import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { disclosureKey } from '../server/pipeline/contracts'
import { deriveSources } from '../server/pipeline/derived'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { pendingChanges } from '../server/pipeline/judge/pending'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { terminalStamp } from '../server/utils/terminal-cache'
import { queryContext } from '../server/utils/terminal-db'
import {
  daysBetween,
  earliestListed,
  median,
  queryDisclosures,
} from '../server/utils/terminal-disclosures'
import { fixtureText, manifest } from './pipeline/fixtures'

// The disclosures axis end to end: poll the index, derive one page per
// report from the stored rows, poll those, and read the payload the page and
// the MCP tool serve. Then a second index tick where one report's printed
// date moves (a revision) and a new report appears.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const INDEX_ID = 'openai-misalignment-reports'
const INDEX = fixtureText('fixtures/disclosures/openai-misalignment-reports.html')
const BASE = 'https://alignment.openai.com/misalignment-reports/'
const DNS = 'an-agent-used-dns-to-reach-an-external-chatbot'
const SELF_REPLICATING = 'self-replicating-prompt-injections-exist'
const UPLOADING = 'uploading-files-to-the-internet-in-order-to-cite-them'
const DECEPTION = 'encouraging-deception-in-compaction-summaries'

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-09-27T06:00:00Z')
const now = () => new Date((tick += 1000))
const run = (ids: readonly string[], fetcher: SourceFetcher) =>
  runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'survey', ids)

/** The committed fixtures by URL; any report page not committed is a 404. */
function fetcher(overrides: Record<string, string> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const text = overrides[source.url] ?? byUrl.get(source.url)
    if (text === undefined) return { ok: false, status: 404, detail: 'HTTP 404' }
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const ctx = async () =>
  queryContext(sourcesYaml, await terminalStamp(db), () => new Date('2026-10-03T00:00:00Z'))

const reportPageIds = async () =>
  (await deriveSources(db, sourcesYaml))
    .filter((s) => s.source_id.startsWith('openai-misalignment-report-'))
    .map((s) => s.source_id)

beforeEach(async () => {
  for (const table of [
    schema.judgeRuns,
    schema.sourceRuns,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
  tick = Date.parse('2026-09-27T06:00:00Z')
})

describe('pure half', () => {
  it('days, median, and the earliest printed date', () => {
    expect(daysBetween('2026-09-20', '2026-09-25')).toBe(5)
    expect(daysBetween('2026-09-25', '2026-09-20')).toBeNull()
    expect(daysBetween(null, '2026-09-25')).toBeNull()
    expect(median([114, 5, 90])).toBe(90)
    expect(median([5, 90])).toBe(47.5)
    expect(median([])).toBeNull()
    expect(
      earliestListed([
        { provider: 'openai', payload: { entry_id: 'a', listed_on: '2026-10-02' } },
        { provider: 'openai', payload: { entry_id: 'a', listed_on: '2026-09-25' } },
        { provider: 'openai', payload: null },
      ]),
    ).toEqual(new Map([['openai:a', '2026-09-25']]))
  })
})

describe('the disclosures axis end to end', () => {
  it('before any poll: OpenAI has no rows yet, the other three are stated cuts', async () => {
    const data = await queryDisclosures(db, await ctx())
    expect(data.entries).toEqual([])
    expect(data.providers.map((p) => [p.provider, p.feed])).toEqual([
      ['openai', 'no_rows'],
      ['anthropic', 'no_public_feed'],
      ['google', 'no_public_feed'],
      ['xai', 'no_public_feed'],
    ])
    const anthropic = data.providers.find((p) => p.provider === 'anthropic')!
    // The audit's words, never a zero dressed as a count.
    expect(anthropic.reason).toContain('investigating-incidents-cybersecurity-evals')
    expect(data.providers.find((p) => p.provider === 'xai')!.reason).toContain('403')
  })

  it('derives one page per report, joins its dates by title, and measures the days', async () => {
    await run([INDEX_ID], fetcher())
    const ids = await reportPageIds()
    expect(ids).toHaveLength(9)
    expect(ids).toContain(`openai-misalignment-report-${DNS}`)

    // The deception report's URL answers with another report's page: its
    // dates must not attach to the deception entry.
    const wrongPage = fixtureText(
      `fixtures/disclosures/openai-misalignment-report-${SELF_REPLICATING}.html`,
    )
    const report = await run(ids, fetcher({ [`${BASE}${DECEPTION}/`]: wrongPage }))
    const statuses = Object.fromEntries(report.sources.map((s) => [s.source_id, s.status]))
    expect(statuses[`openai-misalignment-report-${DNS}`]).toBe('baseline')
    // A report page that is not there is absent, not a failure.
    expect(statuses['openai-misalignment-report-searching-github-for-leaked-api-keys']).toBe(
      'absent',
    )

    const data = await queryDisclosures(db, await ctx())
    const openai = data.providers.find((p) => p.provider === 'openai')!
    expect(openai).toMatchObject({ feed: 'ok', reports: 9, notices: 3, timed_reports: 3 })
    // 5 (DNS), 90 (printed disclosure date), 114 (uploading): the median is 90.
    expect(openai.median_days_to_disclosure).toBe(90)
    expect(openai.sources[0]!.source_id).toBe(INDEX_ID)

    const byId = new Map(data.entries.map((e) => [e.entry_id, e]))
    expect(byId.get(DNS)!.timeline).toMatchObject({
      discovered_on: '2026-09-20',
      disclosed_on: '2026-09-25',
      disclosed_basis: 'first_listed',
      days_to_disclosure: 5,
      source_url: `${BASE}${DNS}/`,
    })
    expect(byId.get(SELF_REPLICATING)!.timeline).toMatchObject({
      disclosed_on: '2026-09-25',
      disclosed_basis: 'printed',
      days_to_disclosure: 90,
    })
    expect(byId.get(UPLOADING)!.timeline!.days_to_disclosure).toBe(114)
    expect(byId.get(DECEPTION)).toMatchObject({ timeline_status: 'title_mismatch', timeline: null })
    expect(byId.get('searching-github-for-leaked-api-keys')!.timeline_status).toBe('not_fetched')
    expect(byId.get('hugging-face')).toMatchObject({
      kind: 'notice',
      timeline_status: 'not_applicable',
    })
    // Newest listed first.
    expect(data.entries[0]!.listed_on).toBe('2026-09-25')
    expect(data.entries.at(-1)!.entry_id).toBe('hugging-face')
  })

  it('a revision moves the printed date but not the publication date, and never wakes the judge', async () => {
    await run([INDEX_ID], fetcher())
    await run(await reportPageIds(), fetcher())

    const NEW = 'a-new-report'
    const newEntry =
      '<details class="cb-entry" data-date="2026-10-02" data-title="A new report"><summary><div>' +
      '<h3>A new report</h3><p class="cb-meta">Report · Updated <time datetime="2026-10-02">Oct 2, 2026</time> · RL training</p>' +
      '</div></summary><div class="cb-body"><div><p class="cb-eyebrow">Observation</p>' +
      '<p class="cb-copy">An agent did something new.</p>' +
      `<a class="cb-link" href="/misalignment-reports/${NEW}/">Read full report</a></div>` +
      '<dl><div><dt>Model</dt><dd>Internal research model</dd></div>' +
      '<div><dt>Observed during</dt><dd>RL training</dd></div></dl></div></details>'
    const nextIndex = INDEX.replace(
      '<time datetime="2026-09-25">Sep 25, 2026</time> · RL training</p>',
      '<time datetime="2026-10-02">Oct 2, 2026</time> · RL training</p>',
    ).replace('<div id="report-entries">', `<div id="report-entries">${newEntry}`)
    const second = await run([INDEX_ID], fetcher({ [BASE]: nextIndex }))
    expect(second.sources[0]).toMatchObject({ status: 'ok', added: 1, modified: 1 })

    const pending = await pendingChanges(db)
    // The new report reaches the judge; the re-stamped DNS date does not.
    expect(pending.changes.map((c) => [c.entity_key, c.change_type])).toEqual([
      [disclosureKey('openai', 'report', NEW), 'added'],
    ])

    const data = await queryDisclosures(db, await ctx())
    const dns = data.entries.find((e) => e.entry_id === DNS)!
    expect(dns.listed_on).toBe('2026-10-02')
    // The earliest date the index ever showed is still the publication date.
    expect(dns.timeline).toMatchObject({ disclosed_on: '2026-09-25', days_to_disclosure: 5 })
    expect(data.entries[0]!.entry_id).toBe(NEW)
    expect(data.entries[0]!.timeline_status).toBe('not_fetched')
    // The next tick derives the new report's page.
    expect(await reportPageIds()).toContain(`openai-misalignment-report-${NEW}`)
  })
})
