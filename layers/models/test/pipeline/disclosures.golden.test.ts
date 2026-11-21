import { describe, expect, test } from 'vitest'

import {
  DisclosureIndexOutput,
  DisclosureReportPageOutput,
  contentHash,
  disclosureKey,
  disclosureTimelineKey,
} from '#layers/core/server/utils/contracts'
import { diff } from '#layers/core/server/pipeline/diff'
import { isTimestampOnlyChange } from '#layers/core/server/pipeline/judge/pending'
import { derivedKeyOf, laneFor } from '#server/registries/lanes'
import { normalizeDisclosureTimelines, normalizeDisclosures } from '../../server/pipeline/normalize'
import { printedDate, textOf } from '#layers/core/server/pipeline/parsers/html-text'
import { parseOpenAiMisalignmentReport } from '../../server/pipeline/parsers/disclosures/openai-misalignment-report'
import { parseOpenAiMisalignmentReports } from '../../server/pipeline/parsers/disclosures/openai-misalignment-reports'
import { fixtureText, provenanceOf } from '#layers/core/test/pipeline/fixtures'
import { committedIndexItems, indexPage, withReport } from './misalignment-index'

// Disclosure lane golden tests. Expected values are read off the committed
// fixtures (index and report pages fetched 2026-11-21) and fixtures/manifest.json, never live.

const INDEX = fixtureText('fixtures/disclosures/openai-misalignment-reports.html')
const page = (slug: string) =>
  fixtureText(`fixtures/disclosures/openai-misalignment-report-${slug}.html`)
const BASE = 'https://openai.com/safety-alignment/misalignment-reports/'
const DNS = 'an-agent-used-dns-to-reach-an-external-chatbot'
const SELF_REPLICATING = 'self-replicating-prompt-injections-exist'
const UPLOADING = 'uploading-files-to-the-internet-in-order-to-cite-them'

describe('the misalignment index', () => {
  const { rows, skipped } = parseOpenAiMisalignmentReports(INDEX)

  test('26 reports and 3 notices, the 9 the HTML hides behind "Load more" included', () => {
    expect(DisclosureIndexOutput.safeParse({ rows }).success).toBe(true)
    expect(skipped).toEqual([])
    expect(rows.filter((r) => r.kind === 'report')).toHaveLength(26)
    expect(rows.filter((r) => r.kind === 'notice').map((r) => r.entry_id)).toEqual([
      'rubygems',
      'dsewiki',
      'hugging-face',
    ])
    // The oldest report is past the 20 the markup renders; only the payload has it.
    expect(rows.map((r) => r.entry_id)).toContain(UPLOADING)
    const prov = provenanceOf('openai-misalignment-reports')
    for (const r of rows) {
      expect(r.provider).toBe('openai')
      expect(r.source_url).toBe(prov.source_url)
      expect(r.fetched_at).toBe(prov.fetched_at)
    }
  })

  test('a report is the page’s own words; the index prints no model any more', () => {
    const dns = rows.find((r) => r.entry_id === DNS)!
    expect(dns).toMatchObject({
      kind: 'report',
      title: 'An agent used DNS to reach an external chatbot',
      model: null,
      observed_during: null,
      listed_on: '2026-09-25',
      entry_url: `${BASE}${DNS}/`,
    })
    expect(dns.summary).toBe(
      'An agent attempting to complete a search-based training task queried a public chatbot service through a gap in our internet-access restrictions: insufficient DNS filtering in its training sandbox.',
    )
    // Typographic apostrophes are kept as printed, not "cleaned".
    expect(rows.find((r) => r.entry_id.startsWith('using-peers-work-to-gain'))!.title).toBe(
      'Using peers’ work to gain unauthorized access to OpenAI research infrastructure',
    )
  })

  test('a notice links to its update as printed, keeps the id the old index gave it, and carries no model', () => {
    const hf = rows.find((r) => r.entry_id === 'hugging-face')!
    expect(hf).toMatchObject({
      kind: 'notice',
      title: 'Hugging Face',
      model: null,
      observed_during: null,
      listed_on: '2026-08-26',
      entry_url:
        'https://openai.com/hugging-face-incident-and-misalignment/#model-misalignment-2026-08-26',
    })
  })

  test('an index with no entries yet is an empty result, not a failure', () => {
    expect(parseOpenAiMisalignmentReports(indexPage([]))).toEqual({ rows: [], skipped: [] })
  })

  test('a redesigned page fails the source instead of emptying it', () => {
    expect(() => parseOpenAiMisalignmentReports('<html><body>moved</body></html>')).toThrow(
      'no "items" payload',
    )
    // The page's own markup alone is not enough: the HTML lists only the first 20.
    expect(() =>
      parseOpenAiMisalignmentReports(INDEX.replace(/self\.__next_f\.push/g, 'self.other.push')),
    ).toThrow('no "items" payload')
    // Entries present but none a report: the source fails rather than reading as empty.
    const notices = committedIndexItems().filter((i) => i.filters.type[0] === 'notices')
    expect(() => parseOpenAiMisalignmentReports(indexPage(notices))).toThrow('parsed as a report')
  })

  test('an entry it cannot read is skipped by name, not dropped silently', () => {
    const out = parseOpenAiMisalignmentReports(
      indexPage(withReport(DNS, (i) => ({ ...i, href: '/elsewhere/' }))),
    )
    expect(out.rows).toHaveLength(28)
    expect(out.skipped).toEqual([
      {
        entry: 'An agent used DNS to reach an external chatbot',
        reason: 'report link is not /safety-alignment/misalignment-reports/<slug>/: /elsewhere/',
      },
    ])
    const untyped = parseOpenAiMisalignmentReports(
      indexPage(withReport(DNS, (i) => ({ ...i, filters: { type: ['stories'] } }))),
    )
    expect(untyped.skipped.map((s) => s.reason)).toEqual([
      'type is not reports or notices: ["stories"]',
    ])
  })

  test('the synthetic page parses exactly as the committed one', () => {
    expect(parseOpenAiMisalignmentReports(indexPage(committedIndexItems()))).toEqual({
      rows,
      skipped,
    })
  })

  test('keys: provider + kind + entry id; a revision is one modified row', () => {
    const entities = normalizeDisclosures(rows, 'snap-1')
    expect(entities.map((e) => e.entity_key)).toContain(disclosureKey('openai', 'report', DNS))
    expect(entities.map((e) => e.entity_key)).toContain(
      disclosureKey('openai', 'notice', 'rubygems'),
    )
    for (const e of entities) expect(contentHash(JSON.parse(e.payload))).toBe(e.content_hash)

    // Bump the DNS report's "Last updated" date alone.
    const revised = parseOpenAiMisalignmentReports(
      indexPage(
        withReport(DNS, (i) => ({
          ...i,
          reportDates: { ...i.reportDates, lastUpdated: '2026-10-02' },
        })),
      ),
    )
    const changes = diff(
      entities,
      normalizeDisclosures(revised.rows, 'snap-2'),
      '2026-10-02T06:00:00Z',
    ).changes
    expect(changes.map((c) => [c.entity_key, c.change_type])).toEqual([
      [disclosureKey('openai', 'report', DNS), 'modified'],
    ])
    // Only the printed date moved: stored, but it does not wake the judge.
    expect(isTimestampOnlyChange(changes[0]!)).toBe(true)
  })

  test('a changed summary is a real modification the judge sees', () => {
    const before = normalizeDisclosures(rows, 'snap-1')
    const after = normalizeDisclosures(
      parseOpenAiMisalignmentReports(
        indexPage(
          withReport(DNS, (i) => ({
            ...i,
            description: i.description.replace(
              'insufficient DNS filtering',
              'insufficient DNS and proxy filtering',
            ),
          })),
        ),
      ).rows,
      'snap-2',
    )
    const [change] = diff(before, after, '2026-10-02T06:00:00Z').changes
    expect(change!.change_type).toBe('modified')
    expect(isTimestampOnlyChange(change!)).toBe(false)
  })
})

describe('a report page', () => {
  test('the scope line is the model and context; dates are read, "Last updated" is dropped', () => {
    const out = parseOpenAiMisalignmentReport(page(DNS), DNS)
    expect(DisclosureReportPageOutput.safeParse(out).success).toBe(true)
    expect(out.rows[0]).toMatchObject({
      entry_id: DNS,
      title: 'An agent used DNS to reach an external chatbot',
      model: 'Internal research model',
      observed_during: 'RL training',
      lines: [
        { label: 'Discovery', value: 'Sep 20, 2026' },
        { label: 'Incident date', value: 'Sep 20, 2026' },
        { label: 'First posted', value: 'Sep 25, 2026' },
        { label: 'Sample', value: 'Sep 20, 2026' },
      ],
      discovered_on: '2026-09-20',
      disclosed_on: '2026-09-25',
      ...provenanceOf(`openai-misalignment-report-${DNS}`),
    })
  })

  test('a printed "Disclosure date" is read; "Report updated" is dropped (the index has it)', () => {
    const out = parseOpenAiMisalignmentReport(
      page(SELF_REPLICATING),
      SELF_REPLICATING,
      provenanceOf(`openai-misalignment-report-${SELF_REPLICATING}`),
    )
    expect(out.rows[0]).toMatchObject({
      model: 'GPT-Red-style internal model based on GPT-5.4-mini',
      observed_during: 'RL self-play training',
      lines: [
        { label: 'Discovery date', value: 'Jun 27, 2026' },
        { label: 'Disclosure date', value: 'Sep 25, 2026' },
      ],
      discovered_on: '2026-06-27',
      disclosed_on: '2026-09-25',
    })
  })

  test('an occurrence naming two dates stays verbatim', () => {
    const out = parseOpenAiMisalignmentReport(
      page(UPLOADING),
      UPLOADING,
      provenanceOf(`openai-misalignment-report-${UPLOADING}`),
    )
    expect(out.rows[0]).toMatchObject({
      title: 'Uploading files to the internet in order to cite them',
      lines: [
        { label: 'Discovery', value: 'May 25, 2026' },
        { label: 'Incident dates', value: 'Jan 24, 2026; Oct 22, 2025' },
        { label: 'First posted', value: 'Sep 16, 2026' },
        { label: 'Samples', value: 'Jan 24, 2026 and Oct 22, 2025' },
      ],
      discovered_on: '2026-05-25',
      disclosed_on: '2026-09-16',
    })
  })

  test('a scope line without a separator is a model, not a context; none is no model', () => {
    const lone = page(DNS).replace(
      '<strong>Internal research model · RL training</strong>',
      '<strong>Internal research model</strong>',
    )
    expect(parseOpenAiMisalignmentReport(lone, DNS).rows[0]).toMatchObject({
      model: 'Internal research model',
      observed_during: null,
    })
    const bare = page(DNS).replace('<strong>Internal research model · RL training</strong>', '')
    expect(parseOpenAiMisalignmentReport(bare, DNS).rows[0]).toMatchObject({
      model: null,
      observed_during: null,
    })
  })

  test('refuses a page it cannot place or read', () => {
    expect(() => parseOpenAiMisalignmentReport(page(DNS), null)).toThrow('derived for')
    expect(() => parseOpenAiMisalignmentReport('<html></html>', DNS)).toThrow(
      'no <div data-safety-report-metadata>',
    )
    const twoDiscoveries = page(DNS).replace(
      'Incident date: Sep 20, 2026',
      'Discovered: Sep 19, 2026',
    )
    expect(() => parseOpenAiMisalignmentReport(twoDiscoveries, DNS)).toThrow('two different')
  })

  test('one row per report, keyed by provider and slug', () => {
    const [e] = normalizeDisclosureTimelines(
      parseOpenAiMisalignmentReport(page(DNS), DNS).rows,
      's',
    )
    expect(e!.entity_key).toBe(disclosureTimelineKey('openai', DNS))
    expect(e!.entity_type).toBe('disclosure_timeline')
  })
})

describe('lanes and text helpers', () => {
  test('the index is a registered lane; a report page is derived by prefix', () => {
    expect(laneFor('openai-misalignment-reports')!.removals).toBe('set')
    expect(derivedKeyOf('openai-misalignment-reports')).toBeNull()
    expect(laneFor(`openai-misalignment-report-${DNS}`)).toBeDefined()
    expect(derivedKeyOf(`openai-misalignment-report-${DNS}`)).toBe(DNS)
  })

  test('printedDate reads exactly one date, and refuses anything else', () => {
    expect(printedDate('Sep 20, 2026')).toBe('2026-09-20')
    expect(printedDate('September 11, 2026')).toBe('2026-09-11')
    expect(printedDate('May 8, 2026 and May 15, 2026')).toBeNull()
    expect(printedDate('Feb 30, 2026')).toBeNull()
    expect(printedDate('2026-09-20')).toBeNull()
  })

  test('textOf decodes entities and drops tags', () => {
    expect(textOf('<span>A &amp; B&#x27;s <br>line</span>')).toBe("A & B's line")
    // React's separator between adjacent text nodes is not text.
    expect(textOf('Discovered: Jul 9, 2026<!-- -->')).toBe('Discovered: Jul 9, 2026')
    // An unknown or prototype-named entity is left as printed, never looked up.
    expect(textOf('&constructor; &bogus;')).toBe('&constructor; &bogus;')
  })
})
