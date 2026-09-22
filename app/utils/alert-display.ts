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
  's1-floor': 'Rule-based: every new S-1/424B4 on a whitelisted CIK alerts.',
  'cik-resolved':
    'Rule-based: a registration filing whose filer matches a pending lab’s name resolves that lab’s CIK and alerts.',
  'periodic-floor': 'Rule-based: every new 10-Q/10-K on a whitelisted CIK alerts.',
  'model-floor': 'Rule-based: a model no vendor catalog has listed before always alerts.',
  'agent-judge':
    'Judged by a model, which may cite only fields present in the referenced change rows.',
}

export const TIER_TEXT = {
  alert:
    'Alert tier (notable, critical): a price move, a new SKU, a department-level hiring shift, a physical-infrastructure hiring move, a filing, or a new revenue fact.',
  ticker:
    'Ticker tier (info): what moved, low stakes — a role added or closed, a title reworded, a location shuffled.',
} as const
