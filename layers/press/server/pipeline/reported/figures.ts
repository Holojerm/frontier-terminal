// Reported figures: lab revenue, valuations, funding rounds and deal sizes as
// the press headlines them, read from the same GDELT GKG files as the track
// record (../track-record/gkg.ts). A headline is kept when it names a private
// lab we track, states an amount of money, and uses a financial or a deal
// word. The judge then says which lab, metric and basis each amount is
// (review.ts), and the Worker keeps a label only when its amount, its lab and
// any other company it names are in the headline.
//
// Dependency-free: scripts/gdelt-search.ts imports it without `bun install`,
// and the Worker re-runs the same match on every posted row before keeping it.

import { amountsIn, type Amount } from '../../../../core/server/pipeline/amounts'

// The amount reader is core's, shared with the filing and supplier reviews.
export {
  amountsIn,
  MIN_AMOUNT,
  type Amount,
  type Currency,
} from '../../../../core/server/pipeline/amounts'

/** The private labs whose financials only the press reports. Public parents file their own. */
export const REPORTED_LABS = [
  'openai',
  'anthropic',
  'xai',
  'mistral',
  'deepseek',
  'moonshot',
] as const
export type ReportedLab = (typeof REPORTED_LABS)[number]

// xAI is case-sensitive: "xai" and "XAI" are other things in headlines.
const LAB_PATTERNS: Readonly<Record<ReportedLab, RegExp>> = {
  openai: /\bOpenAI\b/i,
  anthropic: /\bAnthropic\b/i,
  xai: /\bxAI\b/,
  mistral: /\bMistral\b/i,
  deepseek: /\bDeepSeek\b/i,
  moonshot: /\bMoonshot(?: AI)?\b/i,
}

/** The labs a headline names, in REPORTED_LABS order. */
export function labsIn(title: string): ReportedLab[] {
  return REPORTED_LABS.filter((lab) => LAB_PATTERNS[lab].test(title))
}

// Words that make an amount next to a lab's name a financial figure. Broad on
// purpose: the judge drops a headline that states none (a gift, a debt deal).
const FIGURE_WORDS =
  /\b(revenues?|sales|run[- ]rate|annuali[sz]ed|ARR|valuations?|valued|valuing|worth|raises?|raised|raising|fundraise|fundraising|funding|financing|round|tender|share sale|secondary|investors?|investment|backs|backed|acquires|acquired|acquisition|bought|buys|forecasts?|projects|projected|projections?|expects|targets?|sees)\b/i

// Words that make an amount a deal between a lab and another company: compute
// and cloud contracts, a company's investment, a loan. Kept since deals were
// labeled; a file read before then was matched on FIGURE_WORDS alone.
export const DEAL_WORDS =
  /\b(deals?|pacts?|contracts?|agreements?|partnerships?|commits?|committed|commitments?|compute|computing|cloud|capacity|chips?|gigawatts?|data[- ]cent(?:er|re)s?|leases?|loans?|lends?|lending|credit|financing|stakes?|invests?|invested|investing|backlog|obligations?)\b/i

interface FigureHeadline {
  labs: ReportedLab[]
  amounts: Amount[]
}

/** A headline worth a judge's reading, or null: a tracked lab, an amount of money, and a financial or deal word. */
export function figureHeadline(title: string): FigureHeadline | null {
  const labs = labsIn(title)
  if (labs.length === 0 || !(FIGURE_WORDS.test(title) || DEAL_WORDS.test(title))) return null
  const amounts = amountsIn(title)
  return amounts.length ? { labs, amounts } : null
}
