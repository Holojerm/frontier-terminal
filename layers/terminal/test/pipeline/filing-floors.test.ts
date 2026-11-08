import { describe, expect, it } from 'vitest'

import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import {
  cikResolvedAlerts,
  periodicFloorAlerts,
  s1FloorAlerts,
} from '../../server/pipeline/filing-floors'

// An alert id is its primary key: a change to what goes into the hash would
// re-alert every stored filing on the next poll. These ids, and the text,
// are pinned so the floors can be reshaped without moving either.

const AT = '2026-09-01T12:00:00.000Z'
const URL = 'https://efts.sec.gov/LATEST/search-index?q=%22S-1%22&forms=S-1'

function added(entity_type: 'filing' | 'filer', row: Record<string, unknown>, n: number) {
  return ChangeRow.parse({
    id: `change-${n}`,
    entity_key: `${entity_type}:${n}`,
    entity_type,
    provider: 'xai',
    change_type: 'added',
    before_hash: null,
    after_hash: contentHash(row),
    before_json: null,
    after_json: JSON.stringify(row),
    detected_at: AT,
    source_url: URL,
    fetched_at: AT,
  })
}

const filing = (accession_no: string, form: string, whitelist_cik: string | null) => ({
  accession_no,
  form,
  file_date: '2026-09-01',
  ciks: ['0001181412'],
  display_names: ['SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)'],
  whitelist_cik,
})

const changes = [
  added('filing', filing('0001628280-26-099999', 'S-1/A', '0001181412'), 1),
  added('filing', filing('0001628280-26-099998', '10-Q', '0001181412'), 2),
  added('filing', filing('0001628280-26-099997', 'S-1', null), 3),
  added('filing', filing('0001628280-26-099996', '8-K', '0001181412'), 4),
  added(
    'filer',
    {
      provider: 'xai',
      cik: '0001181412',
      name: 'SPACE EXPLORATION TECHNOLOGIES CORP',
      resolved_form: 'S-1',
      resolved_accession: '0001628280-26-099999',
      resolved_file_date: '2026-09-01',
    },
    5,
  ),
]
// A modified row never alerts, whatever it holds.
const s1 = added('filing', filing('0001628280-26-099995', 'S-1', '0001181412'), 6)
changes.push({
  ...s1,
  change_type: 'modified',
  before_hash: s1.after_hash,
  before_json: s1.after_json,
})

describe('filing floors', () => {
  it('keep their alert ids: accession for s1-floor, change id for the others', () => {
    const s1 = s1FloorAlerts(changes)
    const periodic = periodicFloorAlerts(changes)
    const cik = cikResolvedAlerts(changes)

    expect(s1.map((a) => a.id)).toEqual([
      contentHash({ rule: 's1-floor', accession_no: '0001628280-26-099999' }),
    ])
    expect(periodic.map((a) => a.id)).toEqual([
      contentHash({ rule: 'periodic-floor', change_id: 'change-2' }),
    ])
    expect(cik.map((a) => a.id)).toEqual([
      contentHash({ rule: 'cik-resolved', change_id: 'change-5' }),
    ])
    // The literal values, so a change to contentHash itself is caught too.
    expect([...s1, ...periodic, ...cik].map((a) => a.id)).toMatchInlineSnapshot(`
      [
        "d594f23f57c49ac8bc63e86c7fe5e961549ca30af061ee57d03b17e6d28066fb",
        "298147be9d3471a0aed8191872adae64ec99eaa98262c8d13930f93d75815c2b",
        "bd9bf1545a224be76c3a2068b47f99e821110132455063ac021a1333ff344f29",
      ]
    `)
  })

  it('pages on the original S-1 only', () => {
    const severityOf = (form: string, n: number) =>
      s1FloorAlerts([added('filing', filing(`acc-${n}`, form, '0001181412'), n)])[0]!.severity
    expect(severityOf('S-1', 10)).toBe('critical')
    expect(severityOf('S-1/A', 11)).toBe('notable')
    expect(severityOf('424B4', 12)).toBe('notable')
  })

  it('keep their severity, headline and explanation', () => {
    const all = [
      ...s1FloorAlerts(changes),
      ...periodicFloorAlerts(changes),
      ...cikResolvedAlerts(changes),
    ]
    expect(all.map(({ id: _id, ...rest }) => rest)).toMatchInlineSnapshot(`
      [
        {
          "change_ids": "["change-1"]",
          "created_at": "2026-09-01T12:00:00.000Z",
          "explanation": "Accession 0001628280-26-099999: form S-1/A filed 2026-09-01 by whitelisted CIK 0001181412 (SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)). An S-1/424B4 on a whitelisted filer always alerts — the s1-floor rule, no model in the loop. What the filing says follows in a prospectus-floor alert once its document is parsed.",
          "fetched_at": "2026-09-01T12:00:00.000Z",
          "headline": "S-1/A filed by SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX) (2026-09-01)",
          "rule": "s1-floor",
          "severity": "notable",
          "source_url": "https://efts.sec.gov/LATEST/search-index?q=%22S-1%22&forms=S-1",
        },
        {
          "change_ids": "["change-2"]",
          "created_at": "2026-09-01T12:00:00.000Z",
          "explanation": "Accession 0001628280-26-099998: form 10-Q filed 2026-09-01 by whitelisted CIK 0001181412 (SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)). A 10-Q, 10-K or 20-F on a whitelisted filer always alerts — the periodic-floor rule, no model in the loop. Where the filer is a tagged revenue filer, its XBRL revenue facts refresh on the /revenue panel at the next company-facts poll.",
          "fetched_at": "2026-09-01T12:00:00.000Z",
          "headline": "10-Q filed by SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412) (2026-09-01)",
          "rule": "periodic-floor",
          "severity": "notable",
          "source_url": "https://efts.sec.gov/LATEST/search-index?q=%22S-1%22&forms=S-1",
        },
        {
          "change_ids": "["change-5"]",
          "created_at": "2026-09-01T12:00:00.000Z",
          "explanation": "Accession 0001628280-26-099999: form S-1 filed 2026-09-01 by SPACE EXPLORATION TECHNOLOGIES CORP (CIK 0001181412), whose name matches the xai pattern in sources.yaml pending_filers. A registration filing by a pending lab always alerts — the cik-resolved rule, no model in the loop. From the next poll the CIK is whitelisted and the filer’s submissions and XBRL company-facts feeds are derived and polled; its reported revenue lands on /revenue as an issuer filing.",
          "fetched_at": "2026-09-01T12:00:00.000Z",
          "headline": "SPACE EXPLORATION TECHNOLOGIES CORP filed S-1 (2026-09-01) — CIK 0001181412 resolved for xai",
          "rule": "cik-resolved",
          "severity": "info",
          "source_url": "https://efts.sec.gov/LATEST/search-index?q=%22S-1%22&forms=S-1",
        },
      ]
    `)
  })
})
