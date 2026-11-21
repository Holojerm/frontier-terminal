// Forward calls: a figure estimated before it is filed, by several methods,
// each scored once the filing prints the actual. Recorded here, dated, and
// never edited after the fact. A new call is a new entry.

import type { ForwardCallView } from '../../shared/utils/signals'
import type { LabId, RevenueData } from '../../shared/utils/terminal-types'
import { filedFigures } from '../utils/terminal-ground-truth'

export interface ForwardCall {
  id: string
  lab: LabId
  ticker: string
  label: string
  metric: string
  recorded: string
  period: { start: string; end: string }
  methods: { method: string; value: number; control: boolean }[]
  prior: { label: string; value: number; basis: string }
  note: string
}

export const FORWARD_CALLS: readonly ForwardCall[] = [
  {
    id: 'ant-revenue-2026q4',
    lab: 'anthropic',
    ticker: 'ANT',
    label: 'Anthropic revenue, Q4 2026',
    metric: 'Revenue for the quarter, its first as a listed company',
    recorded: '2026-11-20',
    period: { start: '2026-10-01', end: '2026-12-31' },
    methods: [
      { method: 'Ramp AI Index', value: 17.3e9, control: false },
      { method: 'October run-rate of $81B a year, held flat', value: 20.3e9, control: false },
      { method: '@anthropic-ai/sdk npm downloads', value: 28.1e9, control: false },
      { method: '@google/genai npm downloads', value: 20.9e9, control: true },
      { method: 'openai npm downloads', value: 29.9e9, control: true },
    ],
    prior: {
      label: 'Q3 2026',
      value: 16.956e9,
      basis: 'S-1/A: $33.242B for the nine months less $16.286B for the first half',
    },
    note: 'A research exercise, not investment advice. The control methods use another lab’s downloads, so a control that scores as well as the real input shows the input carries no information of its own.',
  },
]

/** Each call with its actual where a filing now prints the period, and each method's error. */
export function scoreForwardCalls(
  revenue: Pick<RevenueData, 'providers'>,
  calls: readonly ForwardCall[] = FORWARD_CALLS,
): ForwardCallView[] {
  return calls.map((call) => {
    const provider = revenue.providers.find((p) => p.provider === call.lab)
    const figures = provider ? filedFigures([...provider.periods, ...provider.superseded]) : []
    const filed = figures.find((f) => f.start === call.period.start && f.end === call.period.end)
    const actual = filed
      ? { value: filed.val, filed: filed.first_filed, filing_url: filed.filing_url }
      : null
    return {
      id: call.id,
      ticker: call.ticker,
      label: call.label,
      metric: call.metric,
      recorded: call.recorded,
      period: call.period,
      unit: 'USD',
      methods: call.methods.map((m) => ({
        ...m,
        error_pct: actual ? ((m.value - actual.value) / actual.value) * 100 : null,
      })),
      prior: call.prior,
      actual,
      note: call.note,
    }
  })
}
