// How an alert reads: the badge for each change type and the one-line text behind each
// rule's caveat. The severity badge is core's (layers/core/app/utils/severity-badge.ts).
// DESIGN.md › Never convey state by color alone: every badge pairs its color with an icon
// and a word.

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
  'filed-fact-floor':
    'Set by a fixed rule. A new 10-Q/10-K that moves a hyperscaler’s capex or backlog, or a figure it files about a lab (a stake, a funding commitment, revenue), is an alert, with the filed figure and the one before it. It’s critical the first time a filer reports the line, or when a commitment or stake moves 25% or more.',
  'guidance-floor':
    'Set by a fixed rule. A capex figure in a hyperscaler’s earnings release is an alert, quoting the release, and critical when the range moves. Each 10-Q and 10-K is checked against the newest figure.',
  'gpu-median-floor':
    'Set by a fixed rule. A move of 5% or more in seven days in the H100 or B200 rental median is an alert. It counts only providers and configurations priced on both days.',
  'adoption-floor':
    'Set by a fixed rule. A package-download or coding-agent week, or a Ramp vendor’s month, that moves by 25% (2 points for Ramp) or more and at least three times its usual move is an alert. Only a complete period counts, and never one counted after the fact.',
  'datacenter-floor':
    'Set by a fixed rule. A new Epoch AI data center of 100 MW or more, or a site whose current power moves 25% and 50 MW or more between two snapshots, is an alert.',
  'limits-floor':
    'Set by a fixed rule. A published API rate limit that moves 10% or more, or goes to or from no limit, is an alert, one per model. New and retired models and tiers don’t count.',
  'pay-floor':
    'Set by a fixed rule. A lab’s posted-pay median for all roles, research or software engineering that holds a move of 5% or more over a week is an alert. A median that flips back and forth doesn’t count.',
  'deal-score-floor':
    'Set by a fixed rule. A new filing that scores press reports of a deal’s size is an alert, one per filed figure, whether the reports matched or missed. Only reports on file before the filing count.',
  'revenue-score-floor':
    'Set by a fixed rule. A lab’s own new filing that scores press reports of its revenue is an alert, one per filing, whether the reports matched or missed. Only reports on file before the filing count.',
  'supplier-passage-floor':
    'Set by a fixed rule. A supplier’s new SEC filing that states a tie to a lab or cloud, or a figure for one, that its earlier filings didn’t is an alert, one per filing. A model finds the passage, and we check it word for word against the filing. It’s notable when it gives a figure for a tracked lab or cloud.',
  'agent-judge': 'Judged by a model. It can cite only fields from the changes it links to.',
}

export const TIER_TEXT = {
  alert:
    'Alerts (notable or critical) cover price moves, new SKUs, department-level hiring shifts, physical-infrastructure hiring moves, filings, and new revenue figures.',
  info: 'Minor changes (severity info) are low-stakes moves, like a role added or closed, a title reworded, or a location changed.',
} as const
