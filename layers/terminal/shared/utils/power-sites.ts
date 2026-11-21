// Who supplies power to the data-center sites Epoch AI ties to a lab, and the
// listed companies that puts beside each site (GET /api/power-sites, the
// /power page). The sites, their power and their users are Epoch's. The
// companies are ours, each read from one public page: a filing, a regulator's
// page or the company's own, never press coverage. The first were read by hand
// (layers/terminal/server/curated/power-sites.json); new SEC filings naming a
// site are found and read as they are filed (layers/terminal/server/power/).
// Every link is stored in D1 (power_site_ties) with its basis.

import { z } from 'zod'

import type { RecipeCitation } from './recipe-views'
import type { LabId } from './terminal-types'

export const POWER_ROLES = ['utility', 'generation', 'equipment', 'host'] as const
export type PowerRole = (typeof POWER_ROLES)[number]

export const POWER_ROLE_LABEL: Record<PowerRole, string> = {
  utility: 'Utility',
  generation: 'Generation',
  equipment: 'Equipment',
  host: 'Site host',
}

const curatedLink = z.object({
  role: z.enum(POWER_ROLES),
  company: z.string().min(1),
  /** The listed parent when the company is a subsidiary. */
  parent: z.string().min(1).nullable(),
  ticker: z
    .string()
    .regex(/^[A-Z.]{1,6}$/)
    .nullable(),
  /** Why there is no ticker: municipal, federal, private. */
  unlisted: z.string().min(1).nullable(),
  /** A megawatt figure the page itself ties to this site, and what it measures. */
  mw: z.number().positive().nullable(),
  mw_meaning: z.string().min(1).nullable(),
  source_url: z.url(),
  source_title: z.string().min(1),
  publisher: z.string().min(1),
  published: z.iso.date().nullable(),
  /** The passage the link rests on, byte-identical to the page. */
  quote: z.string().min(20).max(400),
  /** When the page was last fetched and the quote found on it. */
  fetched_at: z.iso.datetime(),
})

const curatedGrid = z.object({
  name: z.string().min(1),
  source_url: z.url(),
  quote: z.string().min(10).max(400),
  fetched_at: z.iso.datetime(),
})

export const curatedPowerSites = z.object({
  sites: z.array(
    z.object({
      /** Epoch's name for the site, exactly. */
      site: z.string().min(1),
      grid: curatedGrid.nullable(),
      links: z.array(curatedLink),
    }),
  ),
})

export type CuratedPowerSites = z.infer<typeof curatedPowerSites>
export type CuratedPowerLink = z.infer<typeof curatedLink>
export type PowerGrid = z.infer<typeof curatedGrid>

/** hand: read by a person. judge: read by a model from a stored SEC filing, checked word for word by the Worker. */
export type PowerBasis = 'hand' | 'judge'

export type PowerLink = CuratedPowerLink & { basis: PowerBasis }

export interface PowerSite {
  /** Epoch's name for the site. */
  name: string
  /** The labs Epoch names as users at #confident or #likely. */
  labs: LabId[]
  /** Epoch's owner and users, verbatim. */
  owner: string
  users: string
  country: string
  /** Epoch's estimate of power now. */
  mw_now: number
  /** Epoch's furthest dated estimate, when it is later than the snapshot. */
  mw_planned: number | null
  planned_date: string | null
  grid: PowerGrid | null
  links: PowerLink[]
}

export interface PowerTicker {
  ticker: string
  /** The listed company: the parent where the link names a subsidiary. */
  company: string
  roles: PowerRole[]
  /**
   * The sites it is tied to, largest first. No megawatts here: a site's power
   * summed per company reads as what the company supplies, which no page says.
   */
  sites: string[]
  labs: LabId[]
}

export interface PowerSitesData {
  as_of: string | null
  /** The date of Epoch's data the sites are read from. */
  snapshot: string | null
  /** Every lab site we have at least one sourced company for, largest first. */
  sites: PowerSite[]
  tickers: PowerTicker[]
  /** Lab sites in Epoch's data we have read no power source for yet, largest first. */
  uncovered: PowerUncovered[]
  /** What the table leaves out: each uncovered site by name, then what is never read. */
  gaps: PowerSiteGap[]
  source: RecipeCitation | null
  caveat: string
}

export interface PowerUncovered {
  name: string
  labs: LabId[]
  mw_now: number
  mw_planned: number | null
  planned_date: string | null
  /** SEC documents naming the site that wait for the judge. */
  pending: number
}

export interface PowerSiteGap {
  /** `site:<Epoch's name>` for an uncovered site, else what is left out. */
  id: string
  /** Epoch's name for the site, on a site's gap. */
  site: string | null
  title: string
  reason: string
}
