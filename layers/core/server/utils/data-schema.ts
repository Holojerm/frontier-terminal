// The export schema's version (`schema_version` on /export, the bulk feed and
// every /api envelope) and its changelog (/data, CHANGELOG-data.md). Adding a
// table or column is minor; removing or renaming one is major, announced
// BREAKING_NOTICE_DAYS ahead; changing what a column holds is minor with a note;
// no column change is a patch.
//
// schema.lock.json holds the columns /export served at the last release.
// layers/core/test/terminal-dictionary.test.ts fails when they drift or a
// release's bump is too small, and `bun run schema:lock` rewrites the lock only
// when the newest release says exactly what changed (lockRefusal).

import type { SchemaChangelogEntry } from '../../shared/types/coverage'

export interface TableChange {
  added?: readonly string[]
  removed?: readonly string[]
  /** Old name to new name: a removal and an addition, so always major. */
  renamed?: Readonly<Record<string, string>>
  note?: string
}

export interface SchemaRelease {
  version: string
  /** UTC day the release reached /export. */
  date: string
  summary: string
  /**
   * Per table, what changed. A new table needs only its entry (a note); its
   * columns are read off the export. A dropped table lists them as removed.
   */
  tables?: Readonly<Record<string, TableChange>>
}

export const SCHEMA_RELEASES: readonly SchemaRelease[] = [
  {
    version: '1.0.0',
    date: '2026-11-04',
    summary:
      'First versioned schema. Every export, bulk file, and API response states its schema_version from here on. A full-history export adds a license column before source_url, and a rebuilt export (?as_of=) adds as_of_verified. Neither changes the default columns.',
  },
  {
    version: '1.1.0',
    date: '2026-11-04',
    summary:
      'New: alert webhooks. Each POST carries schema_version, the alert with the columns of the alerts table plus permalink, source_urls and its cited rows of the changes table, and its license. No table columns changed.',
  },
  {
    version: '1.2.0',
    date: '2026-11-04',
    summary:
      'Two tables for the price history from before we watched the labs, read from the Internet Archive’s copies of each lab’s own pricing page: archived_prices (one row per SKU per copy) and archive_captures (every copy considered, read or skipped with the reason).',
    tables: {
      archived_prices: {
        added: [
          'id',
          'capture_id',
          'entity_key',
          'provider',
          'content_hash',
          'payload',
          'captured_at',
          'original_url',
          'basis',
          'source_url',
          'fetched_at',
        ],
      },
      archive_captures: {
        added: [
          'id',
          'era',
          'provider',
          'original_url',
          'captured_at',
          'status',
          'detail',
          'content_hash',
          'raw_key',
          'bytes',
          'rows',
          'source_url',
          'fetched_at',
        ],
      },
    },
  },
  {
    version: '1.3.0',
    date: '2026-11-05',
    summary:
      'New: every bulk file also as Parquet (zstd), the same rows and columns typed by the data dictionary, listed under parquet in each manifest entry. No table columns changed.',
  },
  {
    version: '1.4.0',
    date: '2026-11-05',
    summary:
      'Security-master identifiers. entity_identifiers has one row per company we name, with its CIK, LEI, ticker, MIC and FIGI, each with the URL and time we read it. Join any provider or company column to its entity_id. entity_securities gains mic, figi, and disclosed_in, the filing that discloses a parent or an investor. It also gains a row for Alphabet’s stake in Anthropic, from Anthropic’s S-1/A.',
    tables: {
      entity_identifiers: {
        added: [
          'entity_id',
          'entity_name',
          'entity_kind',
          'legal_name',
          'country',
          'listing_status',
          'cik',
          'cik_source_url',
          'cik_fetched_at',
          'lei',
          'lei_status',
          'lei_note',
          'lei_source_url',
          'lei_fetched_at',
          'ticker',
          'exchange',
          'mic',
          'figi',
          'share_class_figi',
          'figi_source_url',
          'figi_fetched_at',
          'note',
          'source_url',
          'fetched_at',
        ],
      },
      entity_securities: {
        added: ['mic', 'figi', 'disclosed_in'],
        note: 'A new investor row: anthropic to GOOGL, disclosed in Anthropic’s S-1/A.',
      },
    },
  },
  {
    version: '1.5.0',
    date: '2026-11-05',
    summary:
      'Hiring history from before we read the labs’ job boards, from the Internet Archive’s copies of each lab’s own board: a new archived_hiring table (open roles per copy, on the whole board and per department), and an axis column on archive_captures saying which table a copy’s rows went to.',
    tables: {
      archived_hiring: {
        added: [
          'id',
          'capture_id',
          'provider',
          'scope',
          'label',
          'department_id',
          'department',
          'open_roles',
          'captured_at',
          'original_url',
          'basis',
          'source_url',
          'fetched_at',
        ],
      },
      archive_captures: {
        added: ['axis'],
        note: 'Every existing row is pricing.',
      },
    },
  },
  {
    version: '1.5.1',
    date: '2026-11-05',
    summary:
      'The Parquet bulk files are compressed with gzip instead of zstd, which failed on the largest tables. Readers pick the codec up from each file. No columns changed.',
  },
  {
    version: '1.6.0',
    date: '2026-11-07',
    summary:
      'Press reports of the private labs’ revenue, valuations and funding. reported_articles has each GDELT article whose headline names a lab and an amount, and reported_figures has each figure such a headline states, labeled by our judge model and checked against the headline. Unaudited, and never mixed with filed revenue.',
    tables: {
      reported_articles: { note: 'New table.' },
      reported_figures: { note: 'New table.' },
    },
  },
  {
    version: '1.7.0',
    date: '2026-11-11',
    summary:
      'A fourth rights value, restricted: facts a publisher states about itself on a public page, where its site terms restrict automated reading or we couldn’t find them. Our license covers our compilation of those rows with the restriction disclosed, never the saved pages. 25 sources moved to it from not-cleared, among them the OpenAI, Anthropic, xAI, Meta, DeepSeek, Alibaba and Moonshot docs. rights in /api/coverage can now be restricted, and each table’s licensing in /export/dictionary.json gains a restricted list and can answer commercial: restricted. No table columns changed.',
  },
  {
    version: '1.8.0',
    date: '2026-11-19',
    summary:
      'Press reports of deal sizes. reported_figures.metric gains commitment, investment, financing and commitment_total, for the size of a compute, investment or lending deal between a lab and another company, and a counterparty column names that company as the headline writes it. Rows with the five earlier metrics are unchanged and carry a null counterparty.',
    tables: {
      reported_figures: { added: ['counterparty'] },
    },
  },
  {
    version: '1.8.1',
    date: '2026-11-20',
    summary:
      'A fix to how the latency probes in /api/probes are read. ttft_ms is the time to the first text of the answer, and tokens_per_second counts answer tokens only. Until now a lab that streams its reasoning (xAI) was timed to its first reasoning text and its reasoning tokens were counted in throughput, so its readings before 2026-11-20 are not comparable with later ones. No columns changed.',
  },
  {
    version: '1.9.0',
    date: '2026-11-20',
    summary:
      'Six new tables. latency_probes has every hourly probe we send each lab, and probe_days the daily strain reading /api/probes serves. filed_guidance has the capex guidance in each hyperscaler earnings release, with the release’s sentence. dependency_edges has the lines of the dependency graph, one row per filed figure. supplier_passages and power_site_ties are the hand-read tables behind /api/suppliers and /api/power-sites, each row with its quote. The dictionary’s sources gain the power_site_sources pages, grouped as power_sites.',
    tables: {
      latency_probes: { note: 'New table.' },
      probe_days: { note: 'New table.' },
      filed_guidance: { note: 'New table.' },
      dependency_edges: { note: 'New table.' },
      supplier_passages: { note: 'New table.' },
      power_site_ties: { note: 'New table.' },
    },
  },
  {
    version: '1.10.0',
    date: '2026-11-20',
    summary:
      'supplier_passages is read from the suppliers’ own filings as they are filed. Its first rows were read by hand; the filings lane now reads each company’s new 10-Q, 10-K, 8-K, 20-F and 6-K, a model picks out the passages, and a row is kept only where its quote and every figure are in the filing verbatim. basis says which, a row a later filing of the same form drops gets ended_at and ended_by, and fetched_at now moves when a newer filing repeats the quote.',
    tables: {
      supplier_passages: {
        added: ['basis', 'accession_no', 'first_seen_at', 'ended_at', 'ended_by'],
        note: 'source_url, filed, period and source_title move to the newer filing when it repeats the quote word for word.',
      },
    },
  },
  {
    version: '1.11.0',
    date: '2026-11-20',
    summary:
      'power_site_ties keeps up with new filings. Its first rows were read by hand. We now search EDGAR each day for new filings that name each of Epoch’s lab sites, a model picks out the companies tied to the site’s power, and a row is kept only where its quote, the company, the site and any megawatt figure are in the filing verbatim. basis says which. A row the filer’s next periodic filing drops gets ended_at and ended_by. fetched_at now moves when a newer filing repeats the quote or the weekly re-read finds it on its page.',
    tables: {
      power_site_ties: {
        added: ['basis', 'accession_no', 'first_seen_at', 'ended_at', 'ended_by'],
        note: 'source_url, published, source_title and publisher move to the newer filing when it repeats the quote word for word.',
      },
    },
  },
  {
    version: '1.12.0',
    date: '2026-11-20',
    summary:
      '/api/rankings gains weekly: each lab’s share of OpenRouter tokens per ISO week (Monday to Sunday, UTC) over every stored day, oldest first, with tokens and share per lab (other included, as in shares) and the days of the week on record. get_rankings returns it too. No table columns changed, and the per-model rows still aren’t exported.',
  },
  {
    version: '1.13.0',
    date: '2026-11-20',
    summary:
      'GPU rental price history from before our GPU price checks began, read from the Internet Archive’s copies of each provider’s own price page: a new archived_gpu_prices table (one row per priced configuration per copy, keyed like the live gpu-* rows), and gpu as a new axis value on archive_captures. The rows carry CC BY-NC 4.0, like the other archived tables, and a licence key doesn’t relabel them.',
    tables: {
      archived_gpu_prices: { note: 'New table.' },
      archive_captures: { note: 'axis can now be gpu (rows in archived_gpu_prices).' },
    },
  },
  {
    version: '1.14.0',
    date: '2026-11-21',
    summary:
      '/api/adoption gains weekly on each downloads and agent_prs entry: the total per ISO week (Monday to Sunday, UTC) over every stored day, oldest first, through the newest week whose Sunday is on record. days says how many of its days are stored, and partial is true when one is missing. An agent_prs week is also retrospective when any of its days was counted later, from the pull requests that still existed. get_adoption returns it too. No table columns changed.',
  },
  {
    version: '1.15.0',
    date: '2026-11-21',
    summary:
      'OpenAI moved its misalignment reports to openai.com/safety-alignment/misalignment-reports/, and its index stopped printing each report’s model and the context it was observed in. Each report’s own page still prints both, so disclosure_timelines gains model and observed_during, read from that page. On disclosures, model and observed_during are null on OpenAI rows from now on, and entry_url points at the new address. A page’s “First posted” line is now read as its disclosure date.',
    tables: {
      disclosure_timelines: {
        added: ['model', 'observed_during'],
        note: 'disclosed_on is also read from a “First posted” line, which every report page but a few now prints. lines drops “Last updated” as it dropped “Report updated”.',
      },
      disclosures: {
        note: 'model and observed_during are null on OpenAI rows from 2026-11-20 (disclosure_timelines has them); entry_url moved to openai.com/safety-alignment/.',
      },
    },
  },
  {
    version: '1.16.0',
    date: '2026-11-21',
    summary:
      '/api/utilization gains benchmark_rounds: every stored MLPerf Inference round side by side, per accelerator and benchmark at the same accelerator count, with each round’s fastest result in tokens per second per accelerator (our division, unverified by MLCommons) and its result ID, change from the round before, the count of accelerators and mixed-accelerator results left out, a footnote and a source per round. It is null until two rounds are stored, and implied still reads the newest round alone. get_utilization returns it too. No table columns changed.',
  },
  {
    version: '1.17.0',
    date: '2026-11-21',
    summary:
      'Status-page incident history from before our status feed checks began, read from the Internet Archive’s copies of each lab’s own feed: a new archived_incidents table (one row per incident, in the newest copy’s state, shaped like the live incident rows), status as a new axis value on archive_captures, and its covers_from column (how far back a status copy reaches). The rows carry CC BY-NC 4.0, like the other archived tables, and a licence key doesn’t relabel them. /api/incidents gains archived.',
    tables: {
      archived_incidents: { note: 'New table.' },
      archive_captures: {
        added: ['covers_from'],
        note: 'axis can now be status (incidents in archived_incidents).',
      },
    },
  },
  {
    version: '1.18.0',
    date: '2026-11-21',
    summary:
      'The latency probes now leave from one place, a Cloudflare data center in eastern North America, instead of whichever data center ran the hourly job (15 in the first day), so a lab’s times no longer include a varying distance to the router. latency_probes gains placement (enam, or unpinned for every probe before the change), served_by_pinned and rate_limit_headers. probe_days gains placement as part of its key: a day is never read across placements, and the changeover day has a row for each. /api/probes serves the pinned series as each lab’s days and window, and the unpinned history apart, in other_series.',
    tables: {
      latency_probes: { added: ['placement', 'served_by_pinned', 'rate_limit_headers'] },
      probe_days: {
        added: ['placement'],
        note: 'The key is now lab, day and placement. Rows from before the change have placement unpinned.',
      },
    },
  },
  {
    version: '1.19.0',
    date: '2026-11-21',
    summary:
      'Package downloads made comparable. Five non-AI npm packages (react, typescript, express, lodash, axios) are read from 2025-05-13 as controls (recipe ids npm-control-*). A new download_series table has, per day, the controls’ median index (npm-control-index), each npm package’s downloads divided by it (<recipe_id>-normalized), and each lab’s main SDK as a share of the tracked labs’ main SDKs on npm and PyPI (<recipe_id>-share). /api/adoption gains, on each downloads entry, normalized and share per ISO week, normalized_last_28d, normalized_prior_28d, share_28d and the series ids, and a controls block with the basket, its base weeks, its weekly index and npm’s outage days. A day npm reported as zero after a package’s first download is an outage: its recipe_observations row keeps the zero and gains outage: true in payload, and it is left out of weekly totals and 28-day sums. get_adoption returns the new fields too. Anthropic claim 7 and Cloudflare claim 2 read the normalized series.',
    tables: {
      download_series: { note: 'New table.' },
      recipe_observations: {
        note: 'payload is {"outage":true} on an npm outage day. npm-control-* rows are new.',
      },
    },
  },
  {
    version: '1.20.0',
    date: '2026-11-21',
    summary:
      'A signal scorecard. A new signal_results table has, for each registered series, each ticker it is expected to lead and each horizon (1, 5, 20 and 60 trading days), the in-sample and held-out statistic: a correlation with forward returns less SPY’s, or for events a mean abnormal return. A result under the minimum sample is thin and has no estimate. New route /api/signals and MCP tool get_signals serve it with the forward calls. Statistics only: the prices behind them aren’t published.',
    tables: {
      signal_results: { note: 'New table.' },
    },
  },
  {
    version: '1.21.0',
    date: '2026-11-21',
    summary:
      'Grid load where the lab sites are. grid_load_days has EIA-930’s adjusted hourly demand summed per balancing authority and local day, from 2018, for the authorities that hold a lab site. ercot_large_load_facts has ERCOT’s own large-load figures (approved to energize, the sum of observed monthly peaks, the large-load queue), one row per figure per report, with its sentence. /api/grid-load and get_grid_load derive monthly and weekly averages with the change on a year before. The dictionary’s sources gain grid_load_sources.',
    tables: {
      grid_load_days: { note: 'New table.' },
      ercot_large_load_facts: { note: 'New table.' },
    },
  },
  {
    version: '1.22.0',
    date: '2026-11-21',
    summary:
      'A new hardware_prints table: the monthly revenue of TSMC, Hon Hai, Quanta, Wistron, Wiwynn, Gigabyte, Accton and Delta, each figure as a source first gave it, with first_seen_at, published_at (the release time where the source states one), due_on and a vintage per revision. TSMC’s history from its 6-Ks starts in 2015 and Accton’s from its own page in July 2023. /api/prints serves it with each company’s sourced ties, and get_hardware_prints returns the same.',
    tables: { hardware_prints: { note: 'New table.' } },
  },
  {
    version: '1.23.0',
    date: '2026-11-21',
    summary:
      'hardware_prints gains Korea’s semiconductor exports (series kr_chip_exports, entity kr-semiconductors) from Korea Customs Service: the first 10 and 20 days of a month (window d10, d20) and the whole month, in USD, with the stated year-on-year change and the release’s embargo time as published_at. Only releases under KOGL Type 1 (October 2026 on) are served. /api/prints and get_hardware_prints show them.',
    tables: {
      hardware_prints: {
        note: 'series can be kr_chip_exports, with currency USD, a null ticker and a null due_on.',
      },
    },
  },
  {
    version: '1.24.0',
    date: '2026-11-21',
    summary:
      'Earnings-call guidance for the 45 listed companies around the labs. filed_guidance gains the call rows (source exhibit, transcript, remarks or audio) and the columns that place each figure: metric, segment, basis, unit, bound, fiscal_quarter, period_start, period_end, speaker, at_ms, page, call_document_id, page_url and method; the release capex rows are unchanged and read source release. Two new tables: guidance_resolutions (the later 10-Q or 10-K figure that settles a row, with error_share) and call_documents (every exhibit, transcript and replay read). /api/call-guidance and get_call_guidance serve them.',
    tables: {
      filed_guidance: {
        added: [
          'source',
          'metric',
          'segment',
          'basis',
          'unit',
          'bound',
          'fiscal_quarter',
          'period_start',
          'period_end',
          'speaker',
          'at_ms',
          'page',
          'call_document_id',
          'page_url',
          'method',
        ],
        note: 'low and high are in unit, no longer always USD; the release rows are USD.',
      },
      guidance_resolutions: { note: 'New table.' },
      call_documents: { note: 'New table.' },
    },
  },
  {
    version: '1.25.0',
    date: '2026-11-21',
    summary:
      'Hiring at the listed companies around the labs. listed_jobs has every role the job boards of CoreWeave, Nebius, Galaxy, Hut 8, Cipher Digital, Cerebras, Astera Labs and Credo have listed since our first read, and Google’s data-center roles, each classed as data-center work, infrastructure engineering or other, with when it was first listed and when it closed. listed_hiring_reads has each daily read’s counts. /api/hiring/listed and get_listed_hiring derive the weekly levels and their change on the week before. The dictionary’s sources gain listed_hiring_sources.',
    tables: {
      listed_jobs: { note: 'New table.' },
      listed_hiring_reads: { note: 'New table.' },
    },
  },
  {
    version: '1.26.0',
    date: '2026-11-21',
    summary:
      'hardware_prints gains Korea’s monthly exports of HS 8542 (electronic integrated circuits) to the world from UN Comtrade, January 2013 on: series kr_hs8542_exports, entity kr-semiconductors, window month, in USD. It is narrower than Korea Customs Service’s semiconductor figure (kr_chip_exports) and kept as its own series. published_at is the lastReleased of Comtrade’s dataset for the month, and a re-release at a different figure is the next vintage. yoy_pct is null: Comtrade states none. /api/prints entries gain series, the series id, since an entity can now carry two. Attribute "Source: UN Comtrade."',
    tables: {
      hardware_prints: {
        note: 'series can be kr_hs8542_exports, with a null yoy_pct; its published_at is the Comtrade dataset’s lastReleased.',
      },
    },
  },
  {
    version: '1.27.0',
    date: '2026-11-21',
    summary:
      'Forward calls. forward_calls holds each dated estimate of a company’s revenue, capex or remaining performance obligations made before the filing, with every method run and its inputs as they stood, inserted once and never edited. forward_call_scores holds each method’s error once a later 10-Q or 10-K settles the period, and whether the actual landed inside the call’s range. /api/signals and get_signals serve both; forward_calls in it replaces prior with inputs and adds rule, kind, fiscal_year, fiscal_quarter and resolves_from.',
    tables: {
      forward_calls: { note: 'New table.' },
      forward_call_scores: { note: 'New table.' },
    },
  },
  {
    version: '1.28.0',
    date: '2026-11-21',
    summary:
      'History before the live record. archived_rate_limits holds Anthropic’s rate limits and usage tiers from Internet Archive copies of its rate-limit page from March 2024, keyed as limits-anthropic; archive_captures gains axis limits, and /api/limits and get_rate_limits list what moved between copies. filed_text_facts holds what Amazon’s 10-Qs and 10-Ks said about Anthropic in words from 2023-10 until it tagged amzn:AnthropicMember, each figure with its sentence; /api/exposure and get_exposure show them as text series. The dictionary’s sources gain wayback-limits and release-notes.',
    tables: {
      archived_rate_limits: { note: 'New table.' },
      filed_text_facts: { note: 'New table.' },
    },
  },
  {
    version: '1.28.1',
    date: '2026-11-21',
    summary:
      '/api/overview and get_overview gain lab_alerts: each lab’s newest notable or critical alert, however far back, where alerts holds only the newest ten overall. No columns changed.',
  },
  {
    version: '1.28.2',
    date: '2026-11-22',
    summary:
      'npm downloads go back further. Each lab package is read back to its first release (@anthropic-ai/sdk to 2023-01-31), and openai, the control packages and wrangler to 2022-01-01, where the series began at 2025-05-13. recipe_observations and download_series gain the older days, and weekly on each /api/adoption downloads entry is longer. No columns changed.',
  },
  {
    version: '1.28.3',
    date: '2026-11-22',
    summary:
      'PyPI downloads go back further. Each package is read back to its first day (anthropic to 2023-02-09, openai to 2020-01-01), where the series began at 2026-04-08. Days before 2026-04-08 come from ClickPy, ClickHouse’s public copy of the PyPI downloads dataset, and later days from pypistats as before. Over the 181 days both had on 2026-11-22 they matched on 114, and on the rest ClickPy differed by under 1% on average and 3.2% at most. source_url on each row says which one it came from. recipe_observations and download_series gain the older days, and weekly on each /api/adoption downloads entry is longer. No columns changed.',
  },
]

export const SCHEMA_VERSION = SCHEMA_RELEASES.at(-1)!.version

/** Days of notice before a major release removes or renames a column. */
export const BREAKING_NOTICE_DAYS = 90

/** The response header a CSV or a JSON array export carries its version in. */
export const SCHEMA_VERSION_HEADER = 'X-Schema-Version'

export type Bump = 'major' | 'minor' | 'patch'

function parse(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`not a semver version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The kind of bump from `from` to `to`, or null when `to` isn't the next version of any kind. */
export function bumpOf(from: string, to: string): Bump | null {
  const [a, b, c] = parse(from)
  const [x, y, z] = parse(to)
  if (x === a + 1 && y === 0 && z === 0) return 'major'
  if (x === a && y === b + 1 && z === 0) return 'minor'
  if (x === a && y === b && z === c + 1) return 'patch'
  return null
}

const RANK: Readonly<Record<Bump, number>> = { patch: 0, minor: 1, major: 2 }

/** The smallest bump a release's changes allow. */
export function bumpNeeded(release: SchemaRelease): Bump {
  let need: Bump = 'patch'
  for (const change of Object.values(release.tables ?? {})) {
    if (change.removed?.length || Object.keys(change.renamed ?? {}).length) return 'major'
    if (change.added?.length || change.note) need = 'minor'
  }
  return need
}

/**
 * Whether a release after `version` changed `table`'s columns or what they
 * hold. An unparseable or unknown version counts as changed.
 */
export function tableChangedAfter(table: string, version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return true
  const [a, b, c] = parse(version)
  const after = (v: string) => {
    const [x, y, z] = parse(v)
    return x !== a ? x > a : y !== b ? y > b : z > c
  }
  if (!SCHEMA_RELEASES.some((r) => r.version === version)) return true
  return SCHEMA_RELEASES.some((r) => after(r.version) && r.tables?.[table] !== undefined)
}

export function bumpCovers(made: Bump, needed: Bump): boolean {
  return RANK[made] >= RANK[needed]
}

/** schema.lock.json: every exported table's columns, in export order, at `schema_version`. */
export interface SchemaLock {
  schema_version: string
  tables: Readonly<Record<string, readonly string[]>>
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

/**
 * Why `columns` can't be locked over `lock`, or null when they can: unchanged
 * under the same version, or changed by exactly what the newest release, the
 * one right after the lock, says. A table whose columns only moved still
 * needs an entry (a note), since a CSV reader may go by position.
 */
export function lockRefusal(
  lock: SchemaLock,
  columns: Readonly<Record<string, readonly string[]>>,
  releases: readonly SchemaRelease[] = SCHEMA_RELEASES,
): string | null {
  const newest = releases.at(-1)!
  const names = [...new Set([...Object.keys(lock.tables), ...Object.keys(columns)])]
  const changed = names.filter(
    (name) => JSON.stringify(lock.tables[name]) !== JSON.stringify(columns[name]),
  )
  if (newest.version === lock.schema_version) {
    if (!changed.length) return null
    return `${changed.join(', ')} changed since ${lock.schema_version}. Add a release to SCHEMA_RELEASES in layers/core/server/utils/data-schema.ts (adding is minor, removing or renaming is major) and an entry to CHANGELOG-data.md`
  }
  if (releases.at(-2)?.version !== lock.schema_version) {
    return `schema.lock.json is at ${lock.schema_version}, but the release before ${newest.version} is ${releases.at(-2)?.version}. Lock each release as it is added`
  }
  const problems: string[] = []
  for (const name of names) {
    const before = lock.tables[name] ?? []
    const after = columns[name] ?? []
    const change = newest.tables?.[name]
    if (!changed.includes(name)) {
      if (change?.added?.length || change?.removed?.length || change?.renamed) {
        problems.push(`${name} lists column changes, but its columns didn't change`)
      }
      continue
    }
    if (!change) {
      problems.push(`${name} changed, and ${newest.version} has no entry for it`)
      continue
    }
    const renamed = Object.entries(change.renamed ?? {})
    const added = [...(change.added ?? []), ...renamed.map(([, to]) => to)]
    const removed = [...(change.removed ?? []), ...renamed.map(([from]) => from)]
    // A new table's columns are the export's; a list, if given, must agree.
    const wantAdded = after.filter((c) => !before.includes(c))
    const wantRemoved = before.filter((c) => !after.includes(c))
    const fresh = !(name in lock.tables)
    if (!(fresh && !change.added && !renamed.length) && !sameSet(added, wantAdded)) {
      problems.push(
        `${name} added ${JSON.stringify(wantAdded)}, the release says ${JSON.stringify(added)}`,
      )
    }
    if (!sameSet(removed, wantRemoved)) {
      problems.push(
        `${name} removed ${JSON.stringify(wantRemoved)}, the release says ${JSON.stringify(removed)}`,
      )
    }
  }
  return problems.length
    ? `${newest.version} doesn't match the exported columns: ${problems.join('; ')}`
    : null
}

/** The changelog as the dictionary serves it: newest first. */
export function schemaChangelog(): SchemaChangelogEntry[] {
  return [...SCHEMA_RELEASES].reverse().map((release) => ({
    version: release.version,
    date: release.date,
    summary: release.summary,
    tables: Object.entries(release.tables ?? {}).map(([name, change]) => ({
      name,
      added: [...(change.added ?? [])],
      removed: [...(change.removed ?? [])],
      renamed: Object.entries(change.renamed ?? {}).map(([from, to]) => ({ from, to })),
      note: change.note ?? null,
    })),
  }))
}
