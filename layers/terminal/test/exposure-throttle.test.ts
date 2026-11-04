import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { INSTANCES_PER_RUN, filedFactsSkip, runFiledFacts } from '../server/exposure/ingest'
import type { FetchOutcome, FetchSource } from '../server/pipeline/fetch'
import { SEC_MIN_INTERVAL_MS, paceSec } from '../server/pipeline/sec-pace'
import { fixtureText } from './pipeline/fixtures'

// The filed facts and SEC's fair-access limit. On 2026-11-04 at 18:01 UTC
// eighteen instance reads answered 429: the reader ran at the survey instant,
// beside the survey's own SEC fetches. Now it stays off that instant, paces
// its requests, and on a 429 stops, sits out the cooldown, and says so once.

const db = drizzle(env.DB, { schema })
const MSFT = '0000789019'
const AMZN = '0001018724'
const MSFT_Q = '0001193125-26-436133'
const AMZN_Q = '0001018724-26-000040'
const AMZN_INSTANCE =
  'https://www.sec.gov/Archives/edgar/data/1018724/000101872426000040/amzn-20260930_htm.xml'

const YAML = `cik_whitelist:
  MSFT: "${MSFT}"
  AMZN: "${AMZN}"

filed_fact_sources:
  filed-facts-msft:
    ticker: MSFT
    url: https://data.sec.gov/api/xbrl/companyfacts/CIK${MSFT}.json
    instances: true
    rights: ours
  filed-facts-amzn:
    ticker: AMZN
    url: https://data.sec.gov/api/xbrl/companyfacts/CIK${AMZN}.json
    instances: true
    rights: ours
`

const submissions = (cik: string, rows: [string, string, string, string][]) =>
  JSON.stringify({
    cik,
    filings: {
      recent: {
        form: rows.map((r) => r[0]),
        accessionNumber: rows.map((r) => r[1]),
        filingDate: rows.map((r) => r[2]),
        primaryDocument: rows.map((r) => r[3]),
      },
    },
  })

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const missing: FetchOutcome = { ok: false, status: 404, detail: 'HTTP 404' }
const tooMany: FetchOutcome = {
  ok: false,
  status: 429,
  detail: 'HTTP 429 (Retry-After 7200s)',
  retryAfterMs: 7_200_000,
}

function world(msftRows: [string, string, string, string][]) {
  const docs: Record<string, FetchOutcome> = {
    [`https://data.sec.gov/submissions/CIK${MSFT}.json`]: ok(submissions(MSFT, msftRows)),
    [`https://data.sec.gov/submissions/CIK${AMZN}.json`]: ok(
      submissions(AMZN, [['10-Q', AMZN_Q, '2026-10-30', 'amzn-20260930.htm']]),
    ),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${MSFT}.json`]: ok(
      fixtureText('fixtures/filed-facts/companyfacts-msft.json'),
    ),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${AMZN}.json`]: ok(
      fixtureText('fixtures/filed-facts/companyfacts-amzn.json'),
    ),
    'https://www.sec.gov/Archives/edgar/data/789019/000119312526436133/msft-20260930_htm.xml': ok(
      fixtureText('fixtures/filed-facts/msft-20260930.xml'),
    ),
    [AMZN_INSTANCE]: ok(fixtureText('fixtures/filed-facts/amzn-20260930.xml')),
  }
  const fetched: string[] = []
  const fetcher = async (s: FetchSource) => {
    fetched.push(s.url)
    return docs[s.url] ?? missing
  }
  const raw = { put: async () => {} }
  return { docs, fetched, fetcher, raw }
}

const MSFT_LATEST: [string, string, string, string] = [
  '10-Q',
  MSFT_Q,
  '2026-10-28',
  'msft-20260930.htm',
]

const events = () => db.select().from(schema.opsEvents)

beforeEach(async () => {
  for (const table of [
    schema.filedFactReads,
    schema.filedFacts,
    schema.alerts,
    schema.changes,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

describe('filedFactsSkip', () => {
  it('runs only after a poll that ran, with no SEC 429 in the tick', () => {
    expect(filedFactsSkip({ status: 'yielded', to: 'survey' }, false)).toBe(
      'poll yielded to the survey',
    )
    expect(
      filedFactsSkip({ status: 'skipped', heldBy: 'survey@2026-11-04T18:00:04Z' }, false),
    ).toBe('poll lock held by survey@2026-11-04T18:00:04Z')
    const ran = {
      status: 'ran' as const,
      result: {
        scope: 'edgar' as const,
        started_at: '2026-11-04T18:30:02.000Z',
        sources: [],
        failed: 0,
        all_failed: false,
      },
    }
    expect(filedFactsSkip(ran, true)).toBe('SEC answered 429 earlier this tick')
    expect(filedFactsSkip(ran, false)).toBeNull()
  })
})

describe('runFiledFacts under an SEC 429', () => {
  it('stops at the 429, raises one event, sits out the cooldown, then re-reads the document', async () => {
    const w = world([
      MSFT_LATEST,
      ['10-Q', '0001193125-26-100001', '2026-04-29', 'msft-20260331.htm'],
      ['10-Q', '0001193125-26-050001', '2026-01-28', 'msft-20251231.htm'],
    ])
    w.docs[AMZN_INSTANCE] = tooMany

    // Instances go newest first, a filer at a time: MSFT's latest, AMZN's
    // (429), then MSFT's two older ones, which are deferred, not fetched.
    const first = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T17:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(first.deferred).toBe(3)
    expect(w.fetched.filter((u) => u.includes('/Archives/'))).toHaveLength(2)
    expect(w.fetched.at(-1)).toBe(AMZN_INSTANCE)
    expect(first.reads.every((r) => r.status === 'ok')).toBe(true)
    const [event, ...rest] = await events()
    expect(rest).toEqual([])
    expect(event!.kind).toBe('filed_facts_deferred')
    // Retry-After 2 h is longer than the 1 h default cooldown, so it wins.
    expect(event!.detail).toBe(
      `filed facts: 3 requests deferred after SEC 429 on AMZN instance ${AMZN_Q}` +
        ' (HTTP 429 (Retry-After 7200s)); next read after 2026-11-04T19:00:00.000Z',
    )

    // Thirty minutes on: cooling, so nothing is fetched and nothing is said.
    w.fetched.length = 0
    const cooling = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T17:30:00Z'),
      sourcesYaml: YAML,
    })
    expect(cooling).toEqual({
      reads: [],
      alerts: 0,
      deferred: 0,
      cooling_until: '2026-11-04T19:00:00.000Z',
    })
    expect(w.fetched).toEqual([])
    expect(await events()).toHaveLength(1)

    // After the cooldown the 429'd instance is read at once, not a day later,
    // and a real failure (the older filings 404) still alerts, one per read.
    w.docs[AMZN_INSTANCE] = ok(fixtureText('fixtures/filed-facts/amzn-20260930.xml'))
    const after = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T19:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(after.deferred).toBe(0)
    expect(after.cooling_until).toBeNull()
    expect(after.reads).toContainEqual(
      expect.objectContaining({
        ticker: 'AMZN',
        kind: 'instance',
        accession_no: AMZN_Q,
        status: 'ok',
      }),
    )
    expect((await events()).map((e) => e.kind).sort()).toEqual([
      'filed_facts_deferred',
      'filed_facts_failed',
      'filed_facts_failed',
    ])
  })

  it('a 429 on a submissions feed defers the rest of the run the same way', async () => {
    const w = world([MSFT_LATEST])
    w.docs[`https://data.sec.gov/submissions/CIK${AMZN}.json`] = {
      ok: false,
      status: 429,
      detail: 'HTTP 429',
    }
    const run = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T17:00:00Z'),
      sourcesYaml: YAML,
    })
    // AMZN's submissions (429) and its company facts; MSFT's instance.
    expect(run.deferred).toBe(3)
    expect((await events()).map((e) => e.detail)).toEqual([
      'filed facts: 3 requests deferred after SEC 429 on AMZN submissions (HTTP 429);' +
        ' next read after 2026-11-04T18:00:00.000Z',
    ])
  })
})

describe('the cold-start back-fill', () => {
  it('reads at most INSTANCES_PER_RUN instances, paced, however much history is unread', async () => {
    const rows: [string, string, string, string][] = Array.from({ length: 40 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 9, 1) - i * 86_400_000).toISOString().slice(0, 10)
      return ['10-Q', `0001193125-26-${String(200000 + i)}`, day, `msft-${i}.htm`]
    })
    const w = world(rows)
    let t = 0
    const starts: number[] = []
    const fetcher = paceSec(
      async (s) => {
        starts.push(t)
        t += 20
        return w.fetcher(s)
      },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
      },
    )
    const run = await runFiledFacts(db, {
      ...w,
      fetcher,
      now: new Date('2026-11-04T17:00:00Z'),
      sourcesYaml: YAML,
    })
    const instances = run.reads.filter((r) => r.kind === 'instance')
    expect(instances).toHaveLength(INSTANCES_PER_RUN)
    // Two submissions, two company facts, and the instance budget: the most a
    // run can ask of SEC.
    expect(starts).toHaveLength(2 + 2 + INSTANCES_PER_RUN)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(SEC_MIN_INTERVAL_MS)
    }
  })
})
