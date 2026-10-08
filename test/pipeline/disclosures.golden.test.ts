import { describe, expect, test } from 'vitest'

import {
  DisclosureIndexOutput,
  DisclosureReportPageOutput,
  contentHash,
  disclosureKey,
  disclosureTimelineKey,
} from '../../server/pipeline/contracts'
import { diff } from '../../server/pipeline/diff'
import { isTimestampOnlyChange } from '../../server/pipeline/judge/pending'
import { derivedKeyOf, laneFor } from '../../server/pipeline/lanes'
import { normalizeDisclosureTimelines, normalizeDisclosures } from '../../server/pipeline/normalize'
import { printedDate, textOf } from '../../server/pipeline/parsers/disclosures/html-text'
import { parseOpenAiMisalignmentReport } from '../../server/pipeline/parsers/disclosures/openai-misalignment-report'
import { parseOpenAiMisalignmentReports } from '../../server/pipeline/parsers/disclosures/openai-misalignment-reports'
import { fixtureText, provenanceOf } from './fixtures'

// Disclosure lane golden tests. Expected values are read off the committed
// fixtures (index fetched 2026-10-04, report pages 2026-09-27) and fixtures/manifest.json, never live.

const INDEX = fixtureText('fixtures/disclosures/openai-misalignment-reports.html')
const page = (slug: string) =>
  fixtureText(`fixtures/disclosures/openai-misalignment-report-${slug}.html`)
const DNS = 'an-agent-used-dns-to-reach-an-external-chatbot'
const SELF_REPLICATING = 'self-replicating-prompt-injections-exist'
const UPLOADING = 'uploading-files-to-the-internet-in-order-to-cite-them'

describe('the misalignment index', () => {
  const { rows, skipped } = parseOpenAiMisalignmentReports(INDEX)

  test('12 reports and 3 notices, nothing skipped, provenance from the manifest', () => {
    expect(DisclosureIndexOutput.safeParse({ rows }).success).toBe(true)
    expect(skipped).toEqual([])
    expect(rows.filter((r) => r.kind === 'report')).toHaveLength(12)
    expect(rows.filter((r) => r.kind === 'notice').map((r) => r.entry_id)).toEqual([
      'rubygems',
      'dsewiki',
      'hugging-face',
    ])
    const prov = provenanceOf('openai-misalignment-reports')
    for (const r of rows) {
      expect(r.provider).toBe('openai')
      expect(r.source_url).toBe(prov.source_url)
      expect(r.fetched_at).toBe(prov.fetched_at)
    }
  })

  test('a report is the page’s own words: title, summary, model and context verbatim', () => {
    const dns = rows.find((r) => r.entry_id === DNS)!
    expect(dns).toMatchObject({
      kind: 'report',
      title: 'An agent used DNS to reach an external chatbot',
      model: 'Internal research model',
      observed_during: 'RL training',
      listed_on: '2026-09-25',
      entry_url: `https://alignment.openai.com/misalignment-reports/${DNS}/`,
    })
    expect(dns.summary).toBe(
      'An agent attempting to complete a search-based training task queried a public chatbot service through a gap in our internet-access restrictions: insufficient DNS filtering in its training sandbox.',
    )
    // Typographic apostrophes are kept as printed, not "cleaned".
    expect(
      rows.find(
        (r) => r.entry_id === 'unauthorized-artifactory-writes-and-cross-sample-communication',
      )!.summary,
    ).toContain('OpenAI’s')
    expect(
      rows.find((r) => r.entry_id === 'encouraging-deception-in-compaction-summaries')!.model,
    ).toBe('5.6-sol')
  })

  test('a notice links to its update as printed, and carries no model', () => {
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

  test('a report without a model line keeps its row with no model, nothing invented', () => {
    const bare = INDEX.replace(
      '<p class="report-topics">Internal research model · RL training</p>',
      '',
    )
    const dns = parseOpenAiMisalignmentReports(bare).rows.find((r) => r.entry_id === DNS)!
    expect(dns).toMatchObject({ model: null, observed_during: null })
    // A model line with no separator is a model, not a context.
    const lone = INDEX.replace(
      '<p class="report-topics">Internal research model · RL training</p>',
      '<p class="report-topics">Internal research model</p>',
    )
    expect(parseOpenAiMisalignmentReports(lone).rows.find((r) => r.entry_id === DNS)).toMatchObject(
      { model: 'Internal research model', observed_during: null },
    )
  })

  test('an index with no entries yet is an empty result, not a failure', () => {
    const empty = INDEX.replace(/<tbody class="report-entry"[\s\S]*?<\/tbody>/g, '')
    expect(empty).not.toContain('report-entry')
    expect(empty).toContain('class="cb-index"')
    expect(parseOpenAiMisalignmentReports(empty)).toEqual({ rows: [], skipped: [] })
  })

  test('a redesigned page fails the source instead of emptying it', () => {
    expect(() => parseOpenAiMisalignmentReports('<html><body>moved</body></html>')).toThrow(
      'no <tbody class="report-entry"> entries',
    )
    // Entries present but no report title link: every one is skipped, none is a report.
    const noReports = INDEX.replaceAll('class="report-title"', 'class="other-title"')
    expect(() => parseOpenAiMisalignmentReports(noReports)).toThrow('parsed as a report')
  })

  test('an entry missing its link is skipped by name, not dropped silently', () => {
    const broken = INDEX.replace(
      /(id="report-an-agent-used-dns-to-reach-an-external-chatbot"[\s\S]*?)<a class="report-title" href="[^"]*">/,
      '$1<a class="report-title" href="/elsewhere/">',
    )
    const out = parseOpenAiMisalignmentReports(broken)
    expect(out.rows).toHaveLength(14)
    expect(out.skipped).toEqual([
      {
        entry: 'An agent used DNS to reach an external chatbot',
        reason: 'report link is not /misalignment-reports/<slug>/: /elsewhere/',
      },
    ])
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
      INDEX.replace(
        /(id="report-an-agent-used-dns[\s\S]*?data-label="Last updated"><time datetime=")2026-09-25/,
        '$12026-10-02',
      ),
    )
    const changes = diff(
      entities,
      normalizeDisclosures(revised.rows, 'snap-2'),
      '2026-10-02T06:00:00Z',
    )
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
        INDEX.replaceAll('insufficient DNS filtering', 'insufficient DNS and proxy filtering'),
      ).rows,
      'snap-2',
    )
    const [change] = diff(before, after, '2026-10-02T06:00:00Z')
    expect(change!.change_type).toBe('modified')
    expect(isTimestampOnlyChange(change!)).toBe(false)
  })
})

describe('a report page', () => {
  test('layout one: sample and discovery lines verbatim, discovery read as a date', () => {
    const out = parseOpenAiMisalignmentReport(page(DNS), DNS)
    expect(DisclosureReportPageOutput.safeParse(out).success).toBe(true)
    expect(out.rows[0]).toMatchObject({
      entry_id: DNS,
      title: 'An agent used DNS to reach an external chatbot',
      lines: [
        { label: 'Sample', value: 'Sep 20, 2026' },
        { label: 'Discovery', value: 'Sep 20, 2026' },
      ],
      discovered_on: '2026-09-20',
      disclosed_on: null,
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
      lines: [
        { label: 'Discovery date', value: 'Jun 27, 2026' },
        { label: 'Disclosure date', value: 'Sep 25, 2026' },
      ],
      discovered_on: '2026-06-27',
      disclosed_on: '2026-09-25',
    })
  })

  test('layout two, and an occurrence naming two dates stays verbatim', () => {
    const out = parseOpenAiMisalignmentReport(
      page(UPLOADING),
      UPLOADING,
      provenanceOf(`openai-misalignment-report-${UPLOADING}`),
    )
    expect(out.rows[0]).toMatchObject({
      title: 'Uploading files to the internet in order to cite them',
      lines: [
        { label: 'Samples', value: 'Jan 24, 2026 and Oct 22, 2025' },
        { label: 'Discovery', value: 'May 25, 2026' },
      ],
      discovered_on: '2026-05-25',
      disclosed_on: null,
    })
  })

  test('refuses a page it cannot place or read', () => {
    expect(() => parseOpenAiMisalignmentReport(page(DNS), null)).toThrow('derived for')
    expect(() => parseOpenAiMisalignmentReport('<html></html>', DNS)).toThrow('no <article')
    const twoDiscoveries = page(DNS)
      .replace('Sample: </span>', 'Discovered: </span>')
      .replace(
        '>Sep 20, 2026</span></p><p data-docx-paragraph="4"',
        '>Sep 19, 2026</span></p><p data-docx-paragraph="4"',
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
    // An unknown or prototype-named entity is left as printed, never looked up.
    expect(textOf('&constructor; &bogus;')).toBe('&constructor; &bogus;')
  })
})
