import { describe, expect, it } from 'vitest'

import type { ClaimView, ThesesData, ThesisDef, VerdictView } from '#shared/utils/thesis-types'

import type { ClaimStatusChange } from '../server/db/schema'
import { ANTHROPIC_THESIS } from '../server/theses/anthropic'
import { CLOUDFLARE_THESIS } from '../server/theses/cloudflare'
import { buildThesisDigest } from '../server/theses/digest'

// The weekly digest's wording from a typed payload: the subject counts
// statuses, a claim that moved says what it left, a measured claim shows its
// week, a quiet week says so, and an unconfirmed material event is listed.
// Evidence against the thesis leads: weaker claims first, verdicts that count
// toward a kill condition first, and a failed recipe behind a claim is named.

const NOW = new Date('2026-10-12T13:00:00Z')
const view = (id: string, extra: Partial<ClaimView>): ClaimView => {
  const c = [...ANTHROPIC_THESIS.claims, ...CLOUDFLARE_THESIS.claims].find((x) => x.id === id)!
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

const data = (views: ClaimView[], def: ThesisDef = ANTHROPIC_THESIS): ThesesData => ({
  as_of: null,
  computed_at: NOW.toISOString(),
  caveat: '',
  theses: [
    {
      ...def,
      company_name: def.company,
      ticker: null,
      comparison_names: [],
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

const build = (
  views: ClaimView[],
  changes: ClaimStatusChange[] = [],
  failedRuns: { recipe_id: string; started_at: string; detail: string | null }[] = [],
  def: ThesisDef = ANTHROPIC_THESIS,
) =>
  buildThesisDigest({
    data: data(views, def),
    changes,
    failedRuns,
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

  it('orders claims weakest first, a moved claim ahead of its peers', () => {
    const d = build(
      [
        view('anthropic-spend-premium', {}),
        view('anthropic-demand-growth', { status: 'unresolved' }),
        view('anthropic-hiring-scale', { status: 'weakening' }),
        view('anthropic-safety-asset', { status: 'weakening' }),
        view('anthropic-rival-price-war', { status: 'broken' }),
      ],
      [change('anthropic-safety-asset', 'holding', 'weakening')],
    )
    const order = [...d.text.matchAll(/^(\d)\. /gm)].map((m) => m[1])
    expect(order).toEqual(['3', '5', '4', '2', '1'])
  })

  it('leads the week’s ratings with verdicts that count against the thesis', () => {
    const cut = (provider: VerdictView['provider'], slug: string): VerdictView => ({
      subject: `price:${slug}`,
      change_id: slug,
      provider,
      verdict: 'competitive',
      rationale: `${slug} is the flagship.`,
      facts: { model_slug: slug, cut_pct: 40 },
      detected_at: '2026-10-10T06:00:00Z',
      judged_at: '2026-10-10T07:00:00Z',
      confirmation: null,
      source_url: 'https://example.com/pricing',
      fetched_at: '2026-10-10T06:00:00Z',
    })
    const d = build([
      view('anthropic-rival-price-war', {
        verdicts: [cut('anthropic', 'claude-opus-5-5'), cut('openai', 'gpt-6-sol')],
      }),
    ])
    expect(d.text).toMatch(/Against · Claim 3 · OpenAI[^\n]*\n[^\n]*\n {2}• Claim 3 · Anthropic/)
    expect(d.html).toContain('Against')
  })

  it('names a recipe that failed behind a claim, and a failure is not a quiet week', () => {
    const d = build(
      [view('cloudflare-developer-adoption', {}), view('cloudflare-revenue-growth', {})],
      [],
      [
        { recipe_id: 'npm-wrangler', started_at: '2026-10-09T06:00:00Z', detail: 'HTTP 503' },
        { recipe_id: 'npm-wrangler', started_at: '2026-10-10T06:00:00Z', detail: 'HTTP 429' },
        { recipe_id: 'npm-wrangler', started_at: '2026-10-01T06:00:00Z', detail: 'too old' },
      ],
      CLOUDFLARE_THESIS,
    )
    expect(d.text).toContain(
      '? Data gap, claim 2: npm-wrangler failed 2x this week, so its reading may be stale (HTTP 429)',
    )
    expect(d.text).not.toContain('claim 1: ')
    expect(d.text).not.toContain('No claim changed status')
    expect(d.html).toContain('Data gaps')
  })
})
