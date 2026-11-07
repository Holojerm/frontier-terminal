import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { RevenueRow } from '../../server/pipeline/contracts'
import { diff } from '../../server/pipeline/diff'
import { normalizeOfferings, normalizeRevenues } from '../../server/pipeline/normalize'
import {
  REGISTRATION_FIXTURE,
  registrationTarget,
} from '../../server/pipeline/parsers/sec/filing-index'
import { parseProspectusOffering } from '../../server/pipeline/parsers/sec/prospectus-offering'
import { parseProspectusRevenue } from '../../server/pipeline/parsers/sec/prospectus-revenue'
import { prospectusFloorAlerts, usd } from '../../server/pipeline/prospectus-floor'
import { sourceIdsForScope } from '../../server/pipeline/scopes'
import { includeSources } from '../../server/pipeline/sources'
import { fixtureText, manifest, provenanceOf } from './fixtures'

// What a lab's registration filing says, read off its own document: the cover
// terms (prospectus-offering.ts) and the prospectus-floor alert that sets
// them and the revenue against the lab's previous filing.

const db = drizzle(env.DB, { schema })
const CIK = '0002130357'
const S1 = registrationTarget(REGISTRATION_FIXTURE.key)
const S1A = registrationTarget('anthropic-s-1-a-2026-11-02-0001628280-26-068676')
const html = fixtureText(REGISTRATION_FIXTURE.prospectusPath)
const prov = provenanceOf(REGISTRATION_FIXTURE.prospectusSourceId)

/** A cover as the parser sees it once tags are stripped. */
const cover = (sentence: string) => `<p>AMENDMENT NO. 2 TO FORM S-1</p><p>${sentence}</p>`

describe('parseProspectusOffering', () => {
  it('reads the S-1 cover: no amendment, range blank, Nasdaq under ANT', () => {
    expect(parseProspectusOffering(html, S1, CIK, 'Anthropic, PBC', prov)).toEqual({
      provider: 'anthropic',
      cik: CIK,
      entity_name: 'Anthropic, PBC',
      accession_no: S1.accession_no,
      form: 'S-1',
      filed: '2026-10-26',
      amendment_no: null,
      price_low: null,
      price_high: null,
      price: null,
      exchange: 'Nasdaq Global Select Market',
      symbol: 'ANT',
      ...prov,
    })
  })

  it('reads a set range, a final price, and refuses a one-sided range', () => {
    const ranged = parseProspectusOffering(
      cover(
        'the initial public offering price per share will be between $ 26.00 and $ 29.00 . We have applied to list our Class A common stock on the Nasdaq Global Select Market under the symbol “ANT.”',
      ),
      S1A,
      CIK,
      'Anthropic, PBC',
      prov,
    )!
    expect([ranged.amendment_no, ranged.price_low, ranged.price_high, ranged.price]).toEqual([
      2,
      26,
      29,
      null,
    ])
    const priced = parseProspectusOffering(
      '<p>The initial public offering price is $ 31.00 per share.</p>',
      { ...S1A, form: '424B4' },
      CIK,
      'Anthropic, PBC',
      prov,
    )!
    expect(priced.price).toBe(31)
    expect(
      parseProspectusOffering('<p>no terms here</p>', S1A, CIK, 'Anthropic, PBC', prov),
    ).toBeNull()
    expect(() =>
      parseProspectusOffering(
        cover('offering price per share will be between $ 26.00 and $ .'),
        S1A,
        CIK,
        'Anthropic, PBC',
        prov,
      ),
    ).toThrow('one bound')
  })
})

describe('prospectusFloorAlerts', () => {
  beforeEach(async () => {
    await db.delete(schema.entities)
  })

  const s1Revenue = parseProspectusRevenue(html, S1, CIK, prov)
  const s1Offering = parseProspectusOffering(html, S1, CIK, 'Anthropic, PBC', prov)!

  /** The S-1/A as Amendment No. 1 filed it: nine months to September, range set. */
  const amended = (fetchedAt: string) => {
    const p = { source_url: prov.source_url.replace('sx1', 'sx1ax1'), fetched_at: fetchedAt }
    const base = { ...s1Revenue[0]!, accession_no: S1A.accession_no, form: 'S-1/A' }
    const revenue: RevenueRow[] = [
      { ...base, start: '2025-01-01', end: '2025-09-30', val: 2_545_000_000, unaudited: true },
      { ...base, start: '2026-01-01', end: '2026-09-30', val: 33_242_000_000, unaudited: true },
    ].map((r) => ({ ...r, filed: '2026-11-02', ...p }))
    const offering = {
      ...s1Offering,
      ...p,
      accession_no: S1A.accession_no,
      form: 'S-1/A',
      filed: '2026-11-02',
      amendment_no: 1,
      price_low: 26,
      price_high: 29,
    }
    const after = [
      ...normalizeRevenues(revenue, 'snap', 'anthropic'),
      ...normalizeOfferings([offering], 'snap'),
    ]
    return diff([], after, fetchedAt).changes
  }

  async function storeS1() {
    const rows = [
      ...normalizeRevenues(s1Revenue, 'snap', 'anthropic'),
      ...normalizeOfferings([s1Offering], 'snap'),
    ]
    await db.insert(schema.entities).values(
      rows.map((r) => ({
        ...r,
        source_id: REGISTRATION_FIXTURE.prospectusSourceId,
        first_seen_at: r.fetched_at,
      })),
    )
  }

  it('says what the amendment changed and what it means for timing', async () => {
    await storeS1()
    const changes = amended('2026-11-02T15:00:00.000Z')
    const [alert, ...rest] = await prospectusFloorAlerts(db, changes)
    expect(rest).toEqual([])
    expect(alert!).toMatchObject({ severity: 'critical', rule: 'prospectus-floor' })
    expect(alert!.headline).toBe(
      'Anthropic, PBC S-1/A (Amendment No. 1): $33,242 million revenue for the nine months ended 2026-09-30; price range $26.00 to $29.00 per share',
    )
    expect(alert!.explanation).toBe(
      'Anthropic, PBC filed S-1/A (Amendment No. 1) on 2026-11-02 (accession 0001628280-26-068676). ' +
        'Its statement of operations runs to 2026-09-30: revenue $33,242 million for the nine months ended 2026-09-30, against $2,545 million a year earlier (unaudited). ' +
        'The S-1 of 2026-10-26 ran to 2026-06-30, at $16,286 million for the six months ended 2026-06-30. ' +
        'The cover lists the Nasdaq Global Select Market under the symbol “ANT”. ' +
        'Cover: price range $26.00 to $29.00 per share. ' +
        "The S-1 of 2026-10-26 left it blank. A price range is what an IPO's roadshow launches on; " +
        'the next registration filing to watch for is the 424B4 final prospectus, which states the price.',
    )
    expect(JSON.parse(alert!.change_ids)).toEqual(changes.map((c) => c.id).sort())
  })

  it('stays silent for a filing older than two weeks: a back catalogue is not news', async () => {
    expect(await prospectusFloorAlerts(db, amended('2026-12-01T00:00:00.000Z'))).toEqual([])
  })

  it('formats in the filing’s own unit', () => {
    expect(usd(33_242_000_000)).toBe('$33,242 million')
    expect(usd(1_234_567)).toBe('$1,234,567')
  })
})

describe('registration sources on the edgar tick', () => {
  it('rides the 30-minute tick while the filing is fresh, the survey after', () => {
    const all = [
      ...includeSources(fixtureText('sources.yaml'), manifest.fixtures),
      { source_id: REGISTRATION_FIXTURE.indexSourceId, url: 'u', ext: 'html' as const },
      { source_id: REGISTRATION_FIXTURE.prospectusSourceId, url: 'u', ext: 'html' as const },
    ]
    const registration = [
      REGISTRATION_FIXTURE.indexSourceId,
      REGISTRATION_FIXTURE.prospectusSourceId,
    ]
    expect(sourceIdsForScope('edgar', all, new Date('2026-10-27T00:00:00Z'))).toEqual(
      expect.arrayContaining(registration),
    )
    // Once a document has parsed, the 14 MB re-fetch is left to the survey.
    const parsed = new Set([REGISTRATION_FIXTURE.prospectusSourceId])
    expect(
      sourceIdsForScope('edgar', all, new Date('2026-10-27T00:00:00Z'), parsed).filter((id) =>
        registration.includes(id),
      ),
    ).toEqual([REGISTRATION_FIXTURE.indexSourceId])
    const later = sourceIdsForScope('edgar', all, new Date('2026-11-20T00:00:00Z'))
    expect(later.filter((id) => registration.includes(id))).toEqual([])
  })
})
