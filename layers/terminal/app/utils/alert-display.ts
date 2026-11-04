// How an alert reads: the badge for each severity and change type, and the
// one-line text behind each rule's caveat. Shared by the list, the ticker and
// the permalink so a severity never wears two icons. DESIGN.md › Never convey
// state by color alone: every badge pairs its color with an icon and a word.

import type { AlertView, ChangeView } from '../../shared/utils/terminal-types'

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
  's1-floor': 'Set by a fixed rule. Every new S-1/424B4 from a company we track is an alert.',
  'cik-resolved':
    'Set by a fixed rule. When a registration filing’s company name matches a lab we haven’t found on EDGAR yet, we link the two and raise an alert.',
  'periodic-floor': 'Set by a fixed rule. Every new 10-Q/10-K from a company we track is an alert.',
  'model-floor':
    'Set by a fixed rule. A model no vendor catalog has listed before is always an alert.',
  'prospectus-floor':
    'Set by a fixed rule. A lab’s new registration filing is an alert, with what the filing itself states (revenue, the period it covers, and the price range on its cover).',
  'hiring-rollup':
    'Set by a fixed rule. One hiring summary per lab per week. It’s notable only when the week’s moves pass our hiring threshold.',
  'agent-judge': 'Judged by a model. It can cite only fields from the changes it links to.',
}

export const TIER_TEXT = {
  alert:
    'Alerts (notable or critical) cover price moves, new SKUs, department-level hiring shifts, physical-infrastructure hiring moves, filings, and new revenue figures.',
  info: 'Minor changes (severity info) are low-stakes moves, like a role added or closed, a title reworded, or a location changed.',
} as const
