// The badge for each severity, shared by the alert list, the ticker, the
// permalink and the track record so a severity never wears two icons.
// DESIGN.md › Never convey state by color alone: every badge pairs its color
// with an icon and a word.

import type { AlertSeverity } from '../../shared/utils/terminal-tiers'

export const SEVERITY_BADGE = {
  critical: { color: 'error', icon: 'i-lucide-siren' },
  notable: { color: 'warning', icon: 'i-lucide-triangle-alert' },
  info: { color: 'info', icon: 'i-lucide-info' },
} as const satisfies Record<AlertSeverity, { color: string; icon: string }>
