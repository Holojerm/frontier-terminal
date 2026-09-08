// How an alert reads: the badge for each severity and change type, and the
// one-line text behind each rule's caveat. Shared by the list, the ticker and
// the permalink so a severity never wears two icons. DESIGN.md › Never convey
// state by color alone: every badge pairs its color with an icon and a word.

import type { AlertView, ChangeView } from '#shared/utils/terminal-types'

export const SEVERITY_BADGE = {
  critical: { color: 'error', icon: 'i-lucide-siren' },
  notable: { color: 'warning', icon: 'i-lucide-triangle-alert' },
  info: { color: 'info', icon: 'i-lucide-info' },
} as const satisfies Record<AlertView['severity'], { color: string; icon: string }>

export const CHANGE_BADGE = {
  added: { color: 'success', icon: 'i-lucide-plus' },
  removed: { color: 'neutral', icon: 'i-lucide-minus' },
  modified: { color: 'warning', icon: 'i-lucide-pencil' },
} as const satisfies Record<ChangeView['change_type'], { color: string; icon: string }>

export const RULE_TEXT: Record<AlertView['rule'], string> = {
  's1-floor':
    'Deterministic floor rule: a new S-1/424B4 filing on a whitelisted CIK always alerts — no model in the loop.',
  'agent-judge':
    'Agent-judged significance. The explanation may cite only fields present in the referenced change rows; nothing outside them.',
}

export const TIER_TEXT = {
  alert:
    'Alert tier (notable, critical): a price move, a new SKU, a department-level hiring shift, or a filing.',
  ticker:
    'Ticker tier (info): what moved, low stakes — a role added or closed, a title reworded, a location shuffled.',
} as const
