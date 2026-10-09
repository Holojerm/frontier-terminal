import { describe, expect, it } from 'vitest'

import type { ClaimView, ThesesData } from '#shared/utils/thesis-types'

import type { ClaimStatusChange } from '../server/db/schema'
import { ANTHROPIC_THESIS } from '../server/theses/anthropic'
import { buildThesisDigest } from '../server/theses/digest'

// The weekly digest's wording from a typed payload: the subject counts
// statuses, a claim that moved says what it left, a measured claim shows its
// week, a quiet week says so, and an unconfirmed material event is listed.

const NOW = new Date('2026-10-12T13:00:00Z')
const { claims, ...thesis } = ANTHROPIC_THESIS

const view = (id: string, extra: Partial<ClaimView>): ClaimView => {
  const c = claims.find((x) => x.id === id)!
  return {
    id,
    n: c.n,
    text: c.text,
    signal_label: c.signal_label,
    signal_kind: c.spec.kind,
    kill_condition: c.kill_condition,
    status: 'holding',
    status_since: null,
    reason: 'reason',
    latest: null,
    series: [],
    verdicts: [],
    ...extra,
  }
}

const data = (views: ClaimView[]): ThesesData => ({
  as_of: null,
  computed_at: NOW.toISOString(),
  caveat: '',
  theses: [
    {
      ...thesis,
      company_name: 'Anthropic',
      ticker: null,
      comparison_names: ['OpenAI', 'Google', 'xAI'],
      claims: views,
    },
  ],
})

const change = (
  claim_id: string,
  previous_status: string | null,
  status: string,
): ClaimStatusChange => ({
  id: `${claim_id}-${status}`,
  thesis_id: 'anthropic',
  claim_id,
  status,
  previous_status,
  reading_date: null,
  reason: 'r',
  changed_at: '2026-10-10T00:00:00Z',
})

const build = (views: ClaimView[], changes: ClaimStatusChange[] = []) =>
  buildThesisDigest({
    data: data(views),
    changes,
    now: NOW,
    appName: 'Frontier Terminal',
    appUrl: 'https://frontierterm.com',
  })

describe('buildThesisDigest', () => {
  it('says a quiet week is quiet, and still sends', () => {
    const d = build([view('anthropic-spend-premium', {})])
    expect(d.subject).toBe('Frontier Terminal theses · Anthropic: 1 holding')
    expect(d.text).toContain('No claim changed status and nothing was rated this week.')
    expect(d.text).toContain('Theses: https://frontierterm.com/api/theses')
  })

  it('names the status a claim left and shows a measured claim’s week', () => {
    const premium = view('anthropic-spend-premium', {
      status: 'weakening',
      series: [
        { date: '2026-10-01', value: 1.4 },
        { date: '2026-10-08', value: 1.25 },
      ],
    })
    const d = build([premium], [change('anthropic-spend-premium', 'holding', 'weakening')])
    expect(d.subject).toContain('1 weakening · 1 claim moved')
    expect(d.text).toContain('[weakening, was holding]')
    expect(d.text).toContain('Week: 1.40× → 1.25×')
    expect(d.text).not.toContain('No claim changed status')
  })

  it('lists this week’s verdicts and the material events awaiting confirmation', () => {
    const safety = view('anthropic-safety-asset', {
      status: 'weakening',
      verdicts: [
        {
          subject: 'incident:anthropic:abc',
          change_id: 'c1',
          provider: 'anthropic',
          verdict: 'material',
          rationale: 'Hit the API for 3.5 hours.',
          facts: { title: 'Elevated errors on Claude API', impact: 'major', hours: 3.5 },
          detected_at: '2026-10-10T06:00:00Z',
          judged_at: '2026-10-10T07:00:00Z',
          confirmation: null,
          source_url: 'https://status.claude.com/api/v2/incidents.json',
          fetched_at: '2026-10-10T06:00:00Z',
        },
      ],
    })
    const d = build([safety])
    expect(d.text).toContain(
      'Claim 5 · Anthropic · material · "Elevated errors on Claude API" (3.5h, major)',
    )
    expect(d.text).toContain('! Awaiting confirmation, claim 5')
    expect(d.html).toContain('Awaiting your confirmation')
  })
})
