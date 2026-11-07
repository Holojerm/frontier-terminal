// The rules that decide which ops events become email (ops-throttle.ts),
// without D1: fingerprints, the transient threshold, streaks and the digest hour.

import { describe, expect, it } from 'vitest'

import type { OpsEvent } from '~~/server/db/schema'
import type { OpsClassifier } from '~~/server/utils/ops-digest'
import {
  OPS_RECOVERED_KIND,
  STREAK_GAP_MS,
  TRANSIENT_THRESHOLD_MS,
  criticalGroups,
  dailyDigestDue,
  fingerprint,
  isTransient,
  normalizeDetail,
  planDailyDigest,
  recoveredRow,
  type Streak,
} from '../server/utils/ops-throttle'

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-11-07T13:00:00Z')

const classify: OpsClassifier = (kind, count) => {
  if (kind === 'all_sources_failed') return { severity: 'critical' }
  if (kind === 'server_error') return { severity: count >= 10 ? 'critical' : 'warning' }
  if (kind === 'judge_rejected') return { severity: 'info' }
  return { severity: 'warning' }
}

let seq = 0
function row(kind: string, detail: string | null, hoursAgo: number): OpsEvent {
  const at = new Date(NOW.getTime() - hoursAgo * HOUR)
  return {
    id: `r${seq++}`,
    kind,
    detail,
    path: null,
    notifiedAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

function streak(
  kind: string,
  detail: string,
  first: number,
  last: number,
  reported: boolean,
): Streak {
  return {
    key: fingerprint(kind, detail),
    kind,
    detail,
    first_seen_at: new Date(NOW.getTime() - first * HOUR).toISOString(),
    last_seen_at: new Date(NOW.getTime() - last * HOUR).toISOString(),
    reported_at: reported ? new Date(NOW.getTime() - 24 * HOUR).toISOString() : null,
  }
}

const streaks = (...list: Streak[]) => new Map(list.map((s) => [s.key, s]))

describe('fingerprint', () => {
  it('ignores what varies between runs of one failure', () => {
    expect(normalizeDetail('npm-codex: HTTP 429 (Retry-After 0s) after 3 attempts')).toBe(
      'npm-codex: HTTP 429 (Retry-After Ns) after N attempts',
    )
    expect(
      fingerprint(
        'track_record_search_failed',
        'GDELT search for alert 243d71f683947667d96d: HTTP 522 after 1 attempts',
      ),
    ).toBe(
      fingerprint(
        'track_record_search_failed',
        'GDELT search for alert e13bffd4af6d4109bfdb: HTTP 522 after 2 attempts',
      ),
    )
  })

  it('keeps the source and the status apart', () => {
    expect(fingerprint('source_failed', 'openai-models-md: HTTP 403')).not.toBe(
      fingerprint('source_failed', 'openai-models-md: HTTP 429'),
    )
    expect(fingerprint('source_failed', 'edgar-submissions-amzn: HTTP 403')).not.toBe(
      fingerprint('source_failed', 'edgar-submissions-msft: HTTP 403'),
    )
  })
})

describe('isTransient', () => {
  it.each([
    ['openai-pricing-md: HTTP 403', true],
    ['npm-mistral: HTTP 429 (Retry-After 0s) after 3 attempts', true],
    ['fetch threw: TimeoutError: The operation was aborted due to timeout', true],
    ['HTTP 522 after 1 attempts', true],
    ['meta-models-md: no "### <line> availability" table found', false],
    ['bulk/alerts.ndjson: Unexpected end of file', false],
    ['HTTP 404', false],
  ])('%s → %s', (detail, expected) => {
    expect(isTransient(detail)).toBe(expected)
  })
})

describe('criticalGroups', () => {
  it('keeps critical kinds, and a server_error burst', () => {
    const rows = [
      row('all_sources_failed', 'x', 1),
      row('source_failed', 'y', 1),
      ...Array.from({ length: 10 }, () => row('server_error', '/a', 1)),
    ]
    expect([...criticalGroups(rows, classify).keys()].sort()).toEqual([
      'all_sources_failed',
      'server_error',
    ])
    expect([...criticalGroups(rows.slice(0, 5), classify).keys()]).toEqual(['all_sources_failed'])
  })
})

describe('dailyDigestDue', () => {
  it('is due from 13:00 UTC until a run is recorded for today', () => {
    expect(dailyDigestDue(null, new Date('2026-11-07T12:59:00Z'))).toBe(false)
    expect(dailyDigestDue(null, NOW)).toBe(true)
    expect(dailyDigestDue(new Date('2026-11-06T13:00:00Z'), new Date('2026-11-07T13:30:00Z'))).toBe(
      true,
    )
    expect(dailyDigestDue(new Date('2026-11-07T13:00:00Z'), new Date('2026-11-07T23:30:00Z'))).toBe(
      false,
    )
  })
})

describe('planDailyDigest', () => {
  it('reports a new persistent failure once, with every row of it', () => {
    const rows = [
      row('bulk_build_failed', 'x.ndjson: Unexpected end of file', 3),
      row('bulk_build_failed', 'x.ndjson: Unexpected end of file', 2),
    ]
    const plan = planDailyDigest(rows, new Map(), classify, NOW)
    expect(plan.send).toBe(true)
    expect(plan.report).toHaveLength(2)
    expect(plan.upserts[0]!.reported_at).toBe(NOW.toISOString())
  })

  it('does not report a streak again while it keeps failing', () => {
    const detail = 'meta-models-md: no table found'
    const plan = planDailyDigest(
      [row('source_failed', detail, 5)],
      streaks(streak('source_failed', detail, 30, 20, true)),
      classify,
      NOW,
    )
    expect(plan.send).toBe(false)
    expect(plan.report).toHaveLength(0)
    expect(plan.upserts[0]!.first_seen_at).toBe(new Date(NOW.getTime() - 30 * HOUR).toISOString())
  })

  it('holds a transient failure until it has lasted the threshold', () => {
    const detail = 'npm-codex: HTTP 429 (Retry-After 0s) after 3 attempts'
    const short = planDailyDigest(
      [row('recipe_failed', detail, 3), row('recipe_failed', detail, 1)],
      new Map(),
      classify,
      NOW,
    )
    expect(short.send).toBe(false)
    expect(short.upserts[0]!.reported_at).toBeNull()

    const lasted = TRANSIENT_THRESHOLD_MS / HOUR
    const long = planDailyDigest(
      [row('recipe_failed', detail, 1)],
      streaks(streak('recipe_failed', detail, lasted + 1, lasted, false)),
      classify,
      NOW,
    )
    expect(long.send).toBe(true)
    expect(long.report).toHaveLength(1)
  })

  it('starts a new streak after a gap, so a returning failure is reported again', () => {
    const detail = 'x: Unexpected end of file'
    const gap = STREAK_GAP_MS / HOUR
    const plan = planDailyDigest(
      [row('bulk_build_failed', detail, 1)],
      streaks(streak('bulk_build_failed', detail, gap + 40, gap + 2, true)),
      classify,
      NOW,
    )
    expect(plan.send).toBe(true)
    expect(plan.upserts[0]!.first_seen_at).toBe(new Date(NOW.getTime() - HOUR).toISOString())
  })

  it('notes a reported streak that went quiet, and drops an unreported one', () => {
    const gap = STREAK_GAP_MS / HOUR
    const reported = streak('source_failed', 'a: HTTP 403', 60, gap + 1, true)
    const transient = streak('source_failed', 'b: HTTP 403', 40, gap + 1, false)
    const ongoing = streak('source_failed', 'c: HTTP 403', 40, 2, true)
    const plan = planDailyDigest([], streaks(reported, transient, ongoing), classify, NOW)
    expect(plan.deletes.sort()).toEqual([reported.key, transient.key].sort())
    expect(plan.recovered).toEqual([reported])
    // A recovery alone does not send.
    expect(plan.send).toBe(false)
    const r = recoveredRow(reported)
    expect(r.kind).toBe(OPS_RECOVERED_KIND)
    expect(r.detail).toContain('Source failed · a: HTTP 403')
  })

  it('does not send for info alone, but lists it when a warning sends', () => {
    const info = row('judge_rejected', 'claim not grounded', 2)
    expect(planDailyDigest([info], new Map(), classify, NOW).send).toBe(false)
    const plan = planDailyDigest(
      [info, row('bulk_build_failed', 'eof', 2)],
      new Map(),
      classify,
      NOW,
    )
    expect(plan.send).toBe(true)
    expect(plan.report.map((r) => r.kind).sort()).toEqual(['bulk_build_failed', 'judge_rejected'])
  })
})
