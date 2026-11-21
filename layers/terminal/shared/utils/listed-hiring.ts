// Hiring at the listed companies around the labs: which boards we read, how a
// role is classed, and the shape /api/hiring/listed serves. The hypothesis the
// signals harness tests: data-center operations, site and construction hiring
// comes two to three quarters before megawatts are energized, and before
// revenue at the neoclouds and miners.
//
// Pure: no clocks, no I/O. The classifier reads only the board's own title
// and department, so a count is reproducible from the stored roles.

export type RoleClass = 'datacenter' | 'infrastructure' | 'other'

export const ROLE_CLASS_LABEL: Readonly<Record<RoleClass, string>> = {
  datacenter: 'Data-center operations, site and construction',
  infrastructure: 'GPU and infrastructure engineering',
  other: 'Other',
}

/** Job-board APIs we have a reader for. */
export type BoardPlatform = 'greenhouse' | 'ashby' | 'hibob' | 'google-feed'

export interface ListedBoard {
  /** sources.yaml `listed_hiring_sources` id. */
  id: string
  /** US symbol; MARKET_SYMBOLS prices it. */
  ticker: string
  company: string
  platform: BoardPlatform
  url: string
  /** Headers the board's API needs to answer (HiBob names the company in one). */
  headers?: Readonly<Record<string, string>>
  /**
   * all: every open role is stored and counted. datacenter: a hyperscaler's
   * board, read only for its data-center roles, so there is no total.
   */
  scope: 'all' | 'datacenter'
  /**
   * Runs data centers of its own (a neocloud, a miner turning host, a
   * hyperscaler). A chip or connectivity maker's "data center" roles sell to
   * data centers, so only its total is registered as a signal.
   */
  host: boolean
  /** Shown beside the board's figures, when its count needs one. */
  caveat?: string
}

export const LISTED_BOARDS: readonly ListedBoard[] = [
  {
    id: 'listed-coreweave-greenhouse',
    ticker: 'CRWV',
    company: 'CoreWeave',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/coreweave/departments',
    scope: 'all',
    host: true,
  },
  {
    id: 'listed-nebius-greenhouse',
    ticker: 'NBIS',
    company: 'Nebius',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/nebius/departments',
    scope: 'all',
    host: true,
  },
  {
    id: 'listed-galaxy-greenhouse',
    ticker: 'GLXY',
    company: 'Galaxy Digital',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/galaxydigitalservices/departments',
    scope: 'all',
    host: true,
    caveat:
      'One board for all of Galaxy: trading and asset management as well as its data centers.',
  },
  {
    id: 'listed-hut8-greenhouse',
    ticker: 'HUT',
    company: 'Hut 8',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/hut8/departments',
    scope: 'all',
    host: true,
    caveat: 'Includes roles at American Bitcoin, the miner Hut 8 controls.',
  },
  {
    id: 'listed-cipher-greenhouse',
    ticker: 'CIFR',
    company: 'Cipher Digital',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/cipherminingtechnologiesinc/departments',
    scope: 'all',
    host: true,
  },
  {
    id: 'listed-cerebras-ashby',
    ticker: 'CBRS',
    company: 'Cerebras',
    platform: 'ashby',
    url: 'https://api.ashbyhq.com/posting-api/job-board/cerebras',
    scope: 'all',
    host: true,
  },
  {
    id: 'listed-astera-greenhouse',
    ticker: 'ALAB',
    company: 'Astera Labs',
    platform: 'greenhouse',
    url: 'https://boards-api.greenhouse.io/v1/boards/asteralabs/departments',
    scope: 'all',
    host: false,
  },
  {
    id: 'listed-credo-hibob',
    ticker: 'CRDO',
    company: 'Credo',
    platform: 'hibob',
    url: 'https://credo.careers.hibob.com/api/job-ad',
    headers: { companyidentifier: 'credo' },
    scope: 'all',
    host: false,
  },
  {
    id: 'listed-google-careers',
    ticker: 'GOOGL',
    company: 'Google',
    platform: 'google-feed',
    url: 'https://www.google.com/about/careers/applications/jobs/feed.xml',
    scope: 'datacenter',
    host: true,
    caveat:
      'Data-center roles only, from the careers feed the DeepMind board is read from: Google-employer roles our rules class as data-center work.',
  },
]

export const LISTED_BOARD_IDS = LISTED_BOARDS.map((b) => b.id)

/**
 * Companies whose board we looked at and do not read, in the words the page
 * shows. sources.yaml › listed_hiring_sources has each with its terms and
 * robots.txt as read (layers/terminal/test/listed-hiring.test.ts pins the pair).
 */
export const LISTED_CUTS: readonly { ticker: string; company: string; reason: string }[] = [
  {
    ticker: 'IREN',
    company: 'IREN',
    reason:
      'Its website terms forbid scraping and automated access to anything reached through its site.',
  },
  {
    ticker: 'NVDA',
    company: 'NVIDIA',
    reason: 'Its terms of service forbid robots, scrapers and other automated access.',
  },
  {
    ticker: 'ORCL',
    company: 'Oracle',
    reason:
      'Its terms forbid robots, spiders, scrapers and other automated access without written permission.',
  },
  {
    ticker: 'META',
    company: 'Meta',
    reason:
      'Its careers site’s robots.txt says automated collection is prohibited without written permission.',
  },
  {
    ticker: 'AMZN',
    company: 'Amazon',
    reason:
      'The Conditions of Use amazon.jobs links to bar data mining, robots and similar data-gathering tools.',
  },
  {
    ticker: 'SMCI',
    company: 'Supermicro',
    reason: 'Its site refuses automated requests, robots.txt included.',
  },
  {
    ticker: 'ANET',
    company: 'Arista',
    reason: 'Its careers page refuses automated requests, and we found no board API.',
  },
  { ticker: 'CORZ', company: 'Core Scientific', reason: 'Its Greenhouse board is not public.' },
  {
    ticker: 'APLD',
    company: 'Applied Digital',
    reason: 'Its board is on ADP Workforce Now, which has no public job API.',
  },
  {
    ticker: 'WULF',
    company: 'TeraWulf',
    reason: 'Its board is on ADP Workforce Now, which has no public job API.',
  },
  {
    ticker: 'RIOT',
    company: 'Riot Platforms',
    reason:
      'Not read: Rippling’s terms did not load for us to read, and one miner’s board adds little to the hosts already read.',
  },
  {
    ticker: 'HPE',
    company: 'HPE',
    reason:
      'Not read: HPE’s terms page did not load for us to read, and the server makers are covered by the Taiwan prints.',
  },
  {
    ticker: 'DELL',
    company: 'Dell',
    reason:
      'Not read: its board is on Oracle Recruiting Cloud, which needs a reader of its own, and the server makers are covered by the Taiwan prints.',
  },
  {
    ticker: 'MSFT',
    company: 'Microsoft',
    reason: 'Not read: its terms bar any means it does not intentionally make available.',
  },
]

// ---- the classifier ---------------------------------------------------------
//
// Title first, then department. A corporate function stays "other" even on a
// data-center team: a recruiter or accountant for data-center operations is
// not a site role, and a chipmaker's "Data Center" account executive sells to
// data centers. The terms are matched case-insensitively on word boundaries.

const CORPORATE =
  /\b(account (executive|manager|director)|sales|business (development|manager|operations)|bdr|sdr|marketing|recruit\w*|talent acquisition|sourcer|counsel|attorney|lawyer|legal|paralegal|accountant|accounting|controller|tax|treasury|fp&a|financial|finance|investor relations|communications|public (affairs|policy)|government (affairs|relations)|people (business )?partner|business partner|(hr|people) consultant|workplace|human resources|hr business partner|payroll|benefits|learning partner|(executive|administrative) assistant)\b/i

const DATACENTER_TITLE =
  /(\bdata ?cent(er|re)s?\b|\bdatacent(er|re)s?\b|\bdc (site|operations|facilities|technician|manager|design|construction)\b|\bdata hall\b|\bwhite space\b|\bfacilit(y|ies)\b|\bconstruction\b|\bcommissioning\b|\bcritical (facilities|environment|infrastructure)\b|\behs\b|\benvironmental,? health\b|\bhealth (&|and) safety\b|\bsubstation\b|\binterconnection\b|\bsite (selection|development|due diligence|manager|lead|acquisition|director|operations)\b|\bpower engineer\b|\bchief power\b|\benergy (market|origination|procurement|development|infrastructure)\b|\breal estate\b|\bland (acquisition|development)\b|\bpermitting\b|\bsuperintendent\b|\bwater treatment\b|\bhvac\b|\bmep\b|\b(electrical|mechanical) (technician|lead|foreman|superintendent)\b|\bstructured cabling\b|\bcolocation\b|\bplant (engineer|manager|operator)\b|\bminer maintenance\b|\bfield technician\b)/i

const INFRASTRUCTURE_TITLE =
  /(\bgpus?\b|\bhpc\b|\bclusters?\b|\bfleet\b|\bsite reliability\b|\bsre\b|\binfrastructure\b|\bplatform engineer|\bnetwork (engineer|architect|operations|reliability|systems)|\bnetworking\b|\binfiniband\b|\bkubernetes\b|\bk8s\b|\bstorage\b|\bcompute\b|\bcapacity (planning|engineer|manager)|\bhardware (infrastructure|operations|reliability|diagnostics?|systems)\b|\brma\b|\bbare.?metal\b|\bdevops\b|\bproduction engineer|\bcloud (infrastructure|platform|operations)\b|\binference (platform|infrastructure|cloud)\b|\bservers?\b)/i

const DATACENTER_DEPARTMENT =
  /(\bdata ?cent(er|re)s?\b|\bdatacent(er|re)s?\b|^dc\b|\bdc (design|operations|site|facilities)\b|\bfacilit(y|ies)\b|\bconstruction\b|\behs\b|\benvironmental,? health\b|\bhealth (&|and) safety\b|\benergy origination\b|\bsite operations\b|\bfield services\b|\bminer maintenance\b|\belectrical\b|\bmaintenance\b)/i

/** Corporate IT is a help desk, not the compute fleet. */
const CORPORATE_IT_DEPARTMENT = /^(it|information technology)\b/i

const INFRASTRUCTURE_DEPARTMENT =
  /(\binfrastructure\b|\bsre\b|\bnetwork|\bhpc\b|\bcompute\b|\bcloud platform\b|\bhw automation\b)/i

/** The class of one role, from the board's own title and department labels. */
export function classifyRole(title: string, department: string | null): RoleClass {
  const t = title.trim()
  const d = (department ?? '').trim()
  if (CORPORATE.test(t)) return 'other'
  if (DATACENTER_TITLE.test(t)) return 'datacenter'
  if (INFRASTRUCTURE_TITLE.test(t)) return 'infrastructure'
  if (DATACENTER_DEPARTMENT.test(d)) return 'datacenter'
  if (CORPORATE_IT_DEPARTMENT.test(d)) return 'other'
  if (INFRASTRUCTURE_DEPARTMENT.test(d)) return 'infrastructure'
  return 'other'
}

// ---- the payload ------------------------------------------------------------

export interface ListedHiringCounts {
  /** Null on a data-center-only board: nothing else on it is read. */
  total: number | null
  datacenter: number
  infrastructure: number | null
}

export interface ListedHiringWeek extends ListedHiringCounts {
  /** The Monday the UTC week starts. */
  week: string
  /** The read the week's figures are from: its last successful one. */
  read_at: string
  /** Against the week before; null for the first week on record. */
  total_change: number | null
  datacenter_change: number | null
}

export interface ListedHiringRole {
  job_id: string
  title: string
  department: string | null
  location: string | null
  role_class: RoleClass
  first_seen_at: string
}

export interface ListedHiringBoard {
  id: string
  ticker: string
  company: string
  platform: BoardPlatform
  scope: ListedBoard['scope']
  host: boolean
  caveat: string | null
  /** The newest successful read, or null before the first one. */
  latest: (ListedHiringCounts & { read_at: string; source_url: string; fetched_at: string }) | null
  weeks: ListedHiringWeek[]
  /** The newest data-center roles on the board, newest first, capped. */
  datacenter_roles: ListedHiringRole[]
  /** The newest failed read since the last good one, if any. */
  failing: { read_at: string; detail: string } | null
}

export interface ListedHiringData {
  computed_at: string
  /** The newest successful read across the boards. */
  as_of: string | null
  rule: string
  boards: ListedHiringBoard[]
  /** Boards we looked at and do not read, with the reason (sources.yaml › cut). */
  cut: { ticker: string; company: string; reason: string }[]
}

export const LISTED_HIRING_RULE =
  'Each role is classed by its title, then its department, as the board words them: data-center operations, site, construction, facilities and power; GPU and infrastructure engineering; or other. Recruiting, finance, legal and sales roles stay other on any team.'

/** The Monday (UTC) of the week an instant falls in, YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const t = Date.parse(iso)
  const d = new Date(t)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const sinceMonday = (d.getUTCDay() + 6) % 7
  return new Date(midnight - sinceMonday * 86_400_000).toISOString().slice(0, 10)
}

export interface ReadCounts extends ListedHiringCounts {
  read_at: string
}

/** One point per week: the week's last successful read, and its change on the week before. */
export function weeklyCounts(reads: readonly ReadCounts[]): ListedHiringWeek[] {
  const last = new Map<string, ReadCounts>()
  for (const r of [...reads].sort((a, b) => (a.read_at < b.read_at ? -1 : 1))) {
    last.set(weekOf(r.read_at), r)
  }
  const weeks: ListedHiringWeek[] = []
  for (const [week, r] of [...last.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const before = weeks.at(-1)
    weeks.push({
      week,
      read_at: r.read_at,
      total: r.total,
      datacenter: r.datacenter,
      infrastructure: r.infrastructure,
      total_change:
        before && before.total !== null && r.total !== null ? r.total - before.total : null,
      datacenter_change: before ? r.datacenter - before.datacenter : null,
    })
  }
  return weeks
}
