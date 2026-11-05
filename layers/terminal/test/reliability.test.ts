import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import msftSubmissions from '~~/fixtures/sec/edgar-submissions-msft.json?raw'
import anthropicIndex from '~~/fixtures/sec/filing-index-anthropic-s-1.html?raw'
import * as schema from '~~/server/db/schema'
import { contentHash } from '../server/pipeline/contracts'
import {
  acceptanceFromFilingIndex,
  acceptanceFromSubmissions,
  citedFiling,
  easternToUtc,
  filingIndexUrl,
  recordDetections,
  releasedAt,
} from '../server/pipeline/reliability/acceptance'
import {
  backoffUntil,
  parseWorkflowRuns,
  recordDeployChecks,
  repoSlug,
  workflowRunsUrl,
} from '../server/pipeline/reliability/deploys'
import { rollRuns, rollSourceRuns, type RunPoint } from '../server/pipeline/reliability/rollup'
import { statedIntervalMinutes } from '../server/pipeline/scopes'
import { insertRows } from '../server/pipeline/store'
import { queryContext } from '../server/utils/terminal-db'
import { queryReliability } from '../server/utils/terminal-reliability'
import { durationLabel, medianOf } from '../shared/utils/terminal-reliability'
import { fixtureText } from './pipeline/fixtures'

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const REPO = 'https://github.com/Holojerm/frontier-terminal'
const RUNS_URL = workflowRunsUrl('Holojerm/frontier-terminal')

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.sourceRunDays,
    schema.pollTicks,
    schema.alerts,
    schema.changes,
    schema.snapshots,
    schema.filingDetections,
    schema.deployChecks,
  ]) {
    await db.delete(table)
  }
})

const point = (
  source_id: string,
  started_at: string,
  status = 'ok',
  scope = 'edgar',
): RunPoint => ({
  source_id,
  scope,
  started_at,
  status,
})

describe('rollRuns', () => {
  it('charges a gap to the day it ended, measured from the previous good run', () => {
    const { days, ticks } = rollRuns(
      [
        point('edgar-fts', '2026-10-01T22:00:00.000Z'),
        point('edgar-fts', '2026-10-01T22:30:00.000Z', 'failed'),
        point('edgar-fts', '2026-10-01T23:00:00.000Z', 'failed'),
        point('edgar-fts', '2026-10-02T01:00:00.000Z', 'unchanged'),
        point('edgar-fts', '2026-10-02T01:30:00.000Z', 'absent'),
        point('edgar-fts', '2026-10-02T02:00:00.000Z', 'skipped'),
      ],
      new Map([['edgar-fts', '2026-10-01T21:30:00.000Z']]),
    )
    const [first, second] = days.sort((a, b) => a.day.localeCompare(b.day))
    expect(first).toMatchObject({
      day: '2026-10-01',
      runs: 3,
      good: 1,
      longest_gap_ms: 30 * 60_000,
      gap_from: '2026-10-01T21:30:00.000Z',
    })
    // A skipped run (nothing attempted) counts nowhere.
    expect(second).toMatchObject({
      day: '2026-10-02',
      runs: 2,
      good: 2,
      first_good_at: '2026-10-02T01:00:00.000Z',
      longest_gap_ms: 3 * 3_600_000,
      gap_from: '2026-10-01T22:00:00.000Z',
      gap_to: '2026-10-02T01:00:00.000Z',
    })
    expect(ticks.map((t) => [t.started_at, t.runs, t.good])).toEqual([
      ['2026-10-01T22:00:00.000Z', 1, 1],
      ['2026-10-01T22:30:00.000Z', 1, 0],
      ['2026-10-01T23:00:00.000Z', 1, 0],
      ['2026-10-02T01:00:00.000Z', 1, 1],
      ['2026-10-02T01:30:00.000Z', 1, 1],
    ])
  })
})

describe('EDGAR acceptance times', () => {
  it('reads acceptanceDateTime from a submissions payload, in UTC', () => {
    expect(acceptanceFromSubmissions(msftSubmissions, '0001193125-26-323660')).toEqual({
      accepted_at: '2026-07-29T20:08:01.000Z',
      filing_date: '2026-07-29',
      form: '10-K',
    })
    expect(acceptanceFromSubmissions(msftSubmissions, '0000000000-26-000000')).toBeNull()
  })

  it('reads a filing index page’s Eastern acceptance time and converts it', () => {
    // EDGAR's submissions feed has this S-1 at 2026-10-26T13:00:11Z.
    expect(acceptanceFromFilingIndex(anthropicIndex)).toEqual({
      accepted_at: '2026-10-26T13:00:11.000Z',
      filing_date: '2026-10-26',
      form: null,
    })
  })

  it('converts Eastern time on both sides of the clock change', () => {
    expect(easternToUtc('2026-10-30', '06:00:00')).toBe('2026-10-30T10:00:00.000Z')
    expect(easternToUtc('2026-11-02', '06:00:00')).toBe('2026-11-02T11:00:00.000Z')
  })

  it('times an after-hours filing from 6 a.m. Eastern on its filing date', () => {
    // Meta's 10-Q: accepted 8 p.m. Eastern on Oct 21, filing date Oct 22.
    expect(releasedAt('2026-10-22T00:00:08.000Z', '2026-10-22')).toBe('2026-10-22T10:00:00.000Z')
    // A filing in market hours is public when accepted.
    expect(releasedAt('2026-10-28T20:07:39.000Z', '2026-10-28')).toBe('2026-10-28T20:07:39.000Z')
  })

  it('finds the filing a cited change row is about', () => {
    expect(
      citedFiling({
        entity_key: 'filing:0001193125-26-436133',
        after_json: JSON.stringify({
          form: '10-Q',
          ciks: ['0000789019'],
          whitelist_cik: '0000789019',
        }),
        before_json: null,
      }),
    ).toEqual({ accession_no: '0001193125-26-436133', cik: '0000789019', form: '10-Q' })
    expect(
      citedFiling({
        entity_key: 'filer:anthropic',
        after_json: JSON.stringify({
          cik: '0002130357',
          resolved_accession: '0001628280-26-067168',
          resolved_form: 'S-1',
        }),
        before_json: null,
      }),
    ).toEqual({ accession_no: '0001628280-26-067168', cik: '0002130357', form: 'S-1' })
    expect(citedFiling({ entity_key: 'model:x', after_json: '{}', before_json: null })).toBeNull()
    expect(filingIndexUrl('0000789019', '0001193125-26-436133')).toBe(
      'https://www.sec.gov/Archives/edgar/data/789019/000119312526436133/0001193125-26-436133-index.htm',
    )
  })
})

async function seedFilingAlert(accession: string, cik: string, form: string, at: string) {
  const changeId = contentHash({ accession, at })
  await insertRows(db, 'changes', [
    {
      id: changeId,
      entity_key: `filing:${accession}`,
      entity_type: 'filing',
      provider: 'other',
      change_type: 'added',
      before_hash: null,
      after_hash: contentHash({ accession }),
      before_json: null,
      after_json: JSON.stringify({
        accession_no: accession,
        form,
        ciks: [cik],
        whitelist_cik: cik,
      }),
      detected_at: at,
      source_url: `https://data.sec.gov/submissions/CIK${cik}.json`,
      fetched_at: at,
    },
  ])
  await insertRows(db, 'alerts', [
    {
      id: contentHash({ rule: 'periodic-floor', changeId }),
      severity: 'notable',
      headline: `${form} filed by MICROSOFT CORP`,
      explanation: 'fixture',
      change_ids: JSON.stringify([changeId]),
      rule: 'periodic-floor',
      created_at: at,
      source_url: `https://data.sec.gov/submissions/CIK${cik}.json`,
      fetched_at: at,
    },
  ])
}

describe('recordDetections', () => {
  it('reads the acceptance time from the stored submissions feed, and records a filing it can’t find', async () => {
    const fetched = '2026-07-29T20:30:00.000Z'
    await insertRows(db, 'snapshots', [
      {
        id: `edgar-submissions-msft:${fetched}`,
        source_id: 'edgar-submissions-msft',
        content_hash: contentHash('msft'),
        raw_key: 'raw/msft.json',
        http_status: 200,
        bytes: msftSubmissions.length,
        source_url: 'https://data.sec.gov/submissions/CIK0000789019.json',
        fetched_at: fetched,
      },
    ])
    await seedFilingAlert('0001193125-26-323660', '0000789019', '10-K', '2026-07-29T20:31:07.000Z')
    await seedFilingAlert('0001193125-26-999999', '0000789019', '10-Q', '2026-07-30T20:31:07.000Z')

    const reads: string[] = []
    const report = await recordDetections(db, {
      raw: {
        get: async (key) => {
          reads.push(key)
          return key === 'raw/msft.json' ? msftSubmissions : null
        },
      },
      now: new Date('2026-07-31T00:00:00Z'),
    })
    expect(report).toMatchObject({ alerts: 2, resolved: 2, found: 1, missing: 1 })
    // One read per filer, however many of its filings are pending.
    expect(reads).toEqual(['raw/msft.json'])
    const rows = await db.select().from(schema.filingDetections)
    const found = rows.find((r) => r.accession_no === '0001193125-26-323660')!
    expect(found).toMatchObject({
      status: 'found',
      accepted_at: '2026-07-29T20:08:01.000Z',
      basis: 'submissions',
      snapshot_id: `edgar-submissions-msft:${fetched}`,
      rule: 'periodic-floor',
    })
    expect(rows.find((r) => r.accession_no === '0001193125-26-999999')!.status).toBe('missing')

    // Nothing new: the found filing isn't read again; the missing one is retried.
    const again = await recordDetections(db, {
      raw: { get: async () => msftSubmissions },
      now: new Date('2026-07-31T01:00:00Z'),
    })
    expect(again.resolved).toBe(1)
    // Past the retry window a missing filing is left alone.
    const late = await recordDetections(db, {
      raw: { get: async () => msftSubmissions },
      now: new Date('2026-08-05T00:00:00Z'),
    })
    expect(late.resolved).toBe(0)
  })
})

describe('deploy checks', () => {
  const run = (id: number, sha: string, conclusion: string | null, created: string) => ({
    id,
    head_sha: sha.padEnd(40, '0'),
    head_branch: 'main',
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    created_at: created,
    updated_at: created,
    html_url: `${REPO}/actions/runs/${id}`,
  })

  it('parses the runs on main and skips anything malformed', () => {
    const rows = parseWorkflowRuns(
      {
        workflow_runs: [
          run(1, 'abc', 'success', '2026-11-04T21:00:00Z'),
          { ...run(2, 'def', 'failure', '2026-11-04T22:00:00Z'), head_branch: 'feat/x' },
          { ...run(3, 'zzz', 'success', '2026-11-04T23:00:00Z') },
        ],
      },
      { source_url: RUNS_URL, fetched_at: '2026-11-05T00:00:00.000Z' },
    )
    expect(rows.map((r) => r.run_id)).toEqual(['1'])
    expect(rows[0]).toMatchObject({ conclusion: 'success', created_at: '2026-11-04T21:00:00.000Z' })
    expect(repoSlug(REPO)).toBe('Holojerm/frontier-terminal')
  })

  it('stores a page, sends its ETag next time, and parks after a refusal', async () => {
    const store = new Map<string, unknown>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => void store.set(k, v),
    }
    const sent: (string | null)[] = []
    let answer: () => Response = () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            run(10, 'aaa', null, '2026-11-04T21:00:00Z'),
            run(11, 'bbb', 'cancelled', '2026-11-04T20:00:00Z'),
          ],
        }),
        { headers: { etag: 'W/"one"' } },
      )
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('if-none-match'))
      return answer()
    }) as typeof fetch
    const deps = { fetch: fetcher, kv, repoUrl: REPO, now: new Date('2026-11-05T00:00:00Z') }

    expect(await recordDeployChecks(db, deps)).toEqual({ status: 'stored', runs: 2 })
    // The in-progress run completes: the next page rewrites it.
    answer = () =>
      new Response(
        JSON.stringify({ workflow_runs: [run(10, 'aaa', 'success', '2026-11-04T21:00:00Z')] }),
        { headers: { etag: 'W/"two"' } },
      )
    expect(await recordDeployChecks(db, deps)).toEqual({ status: 'stored', runs: 1 })
    answer = () => new Response(null, { status: 304 })
    expect(await recordDeployChecks(db, deps)).toEqual({ status: 'not-modified' })
    expect(sent).toEqual([null, 'W/"one"', 'W/"two"'])

    const reset = Date.parse('2026-11-05T00:40:00Z') / 1000
    answer = () =>
      new Response('rate limited', { status: 403, headers: { 'x-ratelimit-reset': String(reset) } })
    expect(await recordDeployChecks(db, deps)).toEqual({
      status: 'rate-limited',
      until: '2026-11-05T00:40:00.000Z',
    })
    expect(await recordDeployChecks(db, deps)).toEqual({
      status: 'parked',
      until: '2026-11-05T00:40:00.000Z',
    })
    expect(sent).toHaveLength(4)

    const rows = await db.select().from(schema.deployChecks)
    expect(rows.find((r) => r.run_id === '10')).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    })
  })

  it('backs off for Retry-After or an hour when GitHub names no reset', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    expect(backoffUntil(new Headers({ 'retry-after': '120' }), now)).toBe(
      '2026-11-05T00:02:00.000Z',
    )
    expect(backoffUntil(new Headers(), now)).toBe('2026-11-05T01:00:00.000Z')
  })
})

describe('queryReliability', () => {
  const NOW = new Date('2026-10-03T00:10:00Z')

  async function seedRuns() {
    const rows: {
      source_id: string
      started_at: string
      status: 'ok' | 'failed' | 'unchanged'
      scope: 'edgar' | 'survey'
    }[] = []
    // edgar-fts every 30 minutes for two days, failing from 10:00 to 13:00 on day one.
    for (
      let t = Date.parse('2026-10-01T00:00:00Z');
      t < Date.parse('2026-10-03T00:00:00Z');
      t += 1_800_000
    ) {
      const at = new Date(t).toISOString()
      // No check at all from 18:00 to 20:00 on day two.
      if (at >= '2026-10-02T18:00:00.000Z' && at < '2026-10-02T20:00:00.000Z') continue
      const failing = at >= '2026-10-01T10:00:00.000Z' && at < '2026-10-01T13:00:00.000Z'
      rows.push({
        source_id: 'edgar-fts',
        started_at: at,
        status: failing ? 'failed' : 'unchanged',
        scope: 'edgar',
      })
      rows.push({
        source_id: 'edgar-submissions-msft',
        started_at: at,
        status: 'unchanged',
        scope: 'edgar',
      })
      const first = at === '2026-10-01T00:00:00.000Z'
      // Good once, then failing on every check since.
      rows.push({
        source_id: 'edgar-companyfacts-spcx',
        started_at: at,
        status: first ? 'ok' : 'failed',
        scope: 'edgar',
      })
      // Checked once and never again (a delisted model's page).
      if (first) {
        rows.push({
          source_id: 'openai-model-md-gone',
          started_at: at,
          status: 'ok',
          scope: 'edgar',
        })
      }
    }
    await insertRows(
      db,
      'source_runs',
      rows.map((r) => ({
        id: `${r.scope}:${r.source_id}:${r.started_at}`,
        scope: r.scope,
        source_id: r.source_id,
        started_at: r.started_at,
        status: r.status,
        detail: null,
        snapshot_id: null,
        added: 0,
        removed: 0,
        modified: 0,
        source_url: 'https://efts.sec.gov/LATEST/search-index',
      })),
    )
  }

  it('reports good checks, the longest gap, stale periods, deploys and corrections from stored rows', async () => {
    await seedRuns()
    const rolled = await rollSourceRuns(db, NOW)
    expect(rolled).toMatchObject({ from: '2026-10-01', behind: false })
    // A second roll changes nothing.
    await rollSourceRuns(db, NOW)

    await db.insert(schema.deployChecks).values([
      {
        run_id: '1',
        head_sha: 'a'.repeat(40),
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-10-02T09:00:00.000Z',
        updated_at: '2026-10-02T09:05:00.000Z',
        html_url: `${REPO}/actions/runs/1`,
        source_url: RUNS_URL,
        fetched_at: '2026-10-02T10:00:00.000Z',
      },
      {
        run_id: '2',
        head_sha: 'b'.repeat(40),
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-10-02T11:00:00.000Z',
        updated_at: '2026-10-02T11:05:00.000Z',
        html_url: `${REPO}/actions/runs/2`,
        source_url: RUNS_URL,
        fetched_at: '2026-10-02T12:00:00.000Z',
      },
    ])
    await db.insert(schema.filingDetections).values({
      accession_no: '0001326801-26-000001',
      cik: '0001326801',
      form: '10-Q',
      alert_id: 'x',
      rule: 'periodic-floor',
      headline: '10-Q filed by Meta Platforms, Inc. (2026-10-22)',
      alerted_at: '2026-10-22T10:30:34.556Z',
      status: 'found',
      accepted_at: '2026-10-22T00:00:08.000Z',
      filing_date: '2026-10-22',
      basis: 'submissions',
      snapshot_id: 's',
      source_url: 'https://data.sec.gov/submissions/CIK0001326801.json',
      fetched_at: '2026-10-22T10:30:00.000Z',
      recorded_at: '2026-10-22T10:41:00.000Z',
    })

    const ctx = queryContext(sourcesYaml, '2026-10-03T00:00:00.000Z', () => NOW)
    const data = await queryReliability(db, ctx, {
      buildSha: 'c'.repeat(40),
      repoUrl: REPO,
      runsUrl: RUNS_URL,
    })

    const fts = data.sources.rows.find((s) => s.source_id === 'edgar-fts')!
    expect(fts.long).toEqual({ runs: 92, good: 86 })
    expect(fts.stated_minutes).toBe(30)
    // Last good at 09:30, next at 13:00 on day one; the two-hour hole on day two is 2.5 h.
    expect(fts.longest_gap).toEqual({
      minutes: 210,
      from: '2026-10-01T09:30:00.000Z',
      to: '2026-10-01T13:00:00.000Z',
    })
    // Worst first, and a source with no runs sits at the end.
    expect(data.sources.rows.map((s) => s.source_id).slice(0, 2)).toEqual([
      'edgar-companyfacts-spcx',
      'edgar-fts',
    ])
    // A source still failing has an open gap; one we stopped checking doesn't.
    expect(data.sources.rows[0]!.longest_gap).toEqual({
      minutes: 2890,
      from: '2026-10-01T00:00:00.000Z',
      to: null,
    })
    const gone = data.sources.rows.find((s) => s.source_id === 'openai-model-md-gone')!
    expect(gone).toMatchObject({ long: { runs: 1, good: 1 }, longest_gap: null })
    expect(data.sources.rows.at(-1)!.long.runs).toBe(0)

    const sec = data.freshness.find((l) => l.id === 'sec')!
    // The checks from 10:00 to 12:30 on day one ran, but half their sources failed,
    // so the data counts as stale until 13:00.
    expect(sec.periods).toEqual([
      { from: '2026-10-02T18:00:00.000Z', to: '2026-10-02T20:00:00.000Z', minutes: 120 },
      { from: '2026-10-01T10:00:00.000Z', to: '2026-10-01T13:00:00.000Z', minutes: 180 },
    ])
    expect(sec.stale_minutes).toBe(300)
    const all = data.freshness.find((l) => l.id === 'all')!
    expect(all.checks).toBe(0)

    expect(data.detection.rows[0]).toMatchObject({
      minutes_from_acceptance: 630.4,
      released_at: '2026-10-22T10:00:00.000Z',
      minutes_from_release: 30.6,
    })
    expect(data.detection.release.median_minutes).toBe(30.6)
    expect(data.deploys.tally).toMatchObject({ success: 1, failure: 1 })
    expect(data.deploys.fetched_at).toBe('2026-10-02T12:00:00.000Z')
    expect(data.corrections.count).toBeGreaterThan(0)
    expect(data.corrections.url).toBe('/about#corrections')
  })
})

describe('helpers', () => {
  it('states each source’s check interval and formats durations', () => {
    expect(statedIntervalMinutes('edgar-fts')).toBe(30)
    expect(statedIntervalMinutes('openai-pricing-md')).toBe(30)
    expect(statedIntervalMinutes('edgar-submissions-anthropic')).toBe(30)
    expect(statedIntervalMinutes('anthropic-greenhouse')).toBe(360)
    expect(durationLabel(31)).toBe('31 min')
    expect(durationLabel(630)).toBe('10.5 h')
    expect(durationLabel(7000)).toBe('4.9 days')
    expect(medianOf([6, 23.5, 27.5, 31, 602, 630, 730])).toBe(31)
  })
})
