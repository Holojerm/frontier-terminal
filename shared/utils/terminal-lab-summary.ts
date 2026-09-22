// One lab, read across every axis at once. The axis payloads are each
// organised by axis first and lab second; an investor asks the question the
// other way round. This derives the lab-first reading from the same cached
// payloads the axis pages render, so the strip on the front page, the lab
// page header and the axis panels cannot disagree about a number.

import { alertLabs } from './terminal-labs'
import { LAB_DISPLAY } from './terminal-labs'
import type {
  AlertView,
  BigFour,
  ClusterSeries,
  HiringHistoryData,
  HiringHistoryProvider,
  IncidentProviderView,
  IncidentsData,
  MatrixCell,
  PricesData,
  ProviderShare,
  RankingsData,
  RevenueData,
  RevenuePeriod,
  RevenueProviderView,
  SpendData,
  SpendProviderView,
} from './terminal-types'

export const LABS: readonly BigFour[] = ['openai', 'anthropic', 'google', 'xai'] as const

export function isLab(s: string): s is BigFour {
  return (LABS as readonly string[]).includes(s)
}

export const labPath = (lab: BigFour) => `/labs/${lab}`

/**
 * The lab pages, in the shape `definePageMeta({ publicPage })` produces for a
 * static page. A dynamic route is one pattern, not four URLs, so the route
 * table cannot list these; sitemap.xml and llms.txt append them from here.
 */
export const LAB_PAGES = LABS.map((lab) => ({
  path: labPath(lab),
  changefreq: 'daily' as const,
  priority: '0.9',
  title: LAB_DISPLAY[lab],
  summary: `${LAB_DISPLAY[lab]} on every axis the terminal tracks: flagship API price, disclosed revenue, OpenRouter demand and implied spend share, open roles and the infrastructure buildout, status-page incidents, and the alerts that cite it.`,
}))

export interface LabInputs {
  prices?: PricesData | null
  revenue?: RevenueData | null
  rankings?: RankingsData | null
  spend?: SpendData | null
  hiring?: HiringHistoryData | null
  incidents?: IncidentsData | null
  /** Newest first; filtered here to the ones whose cited rows name the lab. */
  alerts?: AlertView[] | null
}

export interface LabSummary {
  lab: BigFour
  display: string
  /** The flagship cell of the like-for-like matrix, priced or not. */
  flagship: MatrixCell | null
  revenue: { view: RevenueProviderView | null; newest: RevenuePeriod | null }
  demand: ProviderShare | null
  spend: SpendProviderView | null
  hiring: {
    view: HiringHistoryProvider | null
    /** Open roles today; null without a feed. */
    now: number | null
    /** Change since the comparison instant, and how many days back that was. */
    delta: number | null
    days: number | null
    cluster: ClusterSeries | null
  }
  incidents: IncidentProviderView | null
  alerts: AlertView[]
}

export function summarizeLab(lab: BigFour, input: LabInputs): LabSummary {
  const revenue = input.revenue?.providers.find((p) => p.provider === lab) ?? null
  const hiring = input.hiring?.providers.find((p) => p.provider === lab) ?? null
  const hasFeed = hiring !== null && hiring.feed === 'ok' && hiring.total.length > 0
  return {
    lab,
    display: LAB_DISPLAY[lab],
    flagship:
      input.prices?.matrix.cells.find((c) => c.provider === lab && c.class === 'flagship') ?? null,
    revenue: { view: revenue, newest: revenue?.periods[0] ?? null },
    demand: input.rankings?.shares.find((s) => s.provider === lab) ?? null,
    spend: input.spend?.providers.find((p) => p.provider === lab) ?? null,
    hiring: {
      view: hiring,
      now: hasFeed ? hiring.total.at(-1)! : null,
      delta:
        hasFeed && hiring.compare ? hiring.compare.total_now - hiring.compare.total_then : null,
      days: hasFeed && hiring.compare ? hiring.compare.days : null,
      cluster: hasFeed ? (hiring.clusters[0] ?? null) : null,
    },
    incidents: input.incidents?.providers.find((p) => p.provider === lab) ?? null,
    alerts: (input.alerts ?? []).filter((a) => alertLabs(a).includes(lab)),
  }
}
