// What moved: the overview, the alert feed, and how early each alert was.

import { z } from 'zod'
import { ALERT_AXES } from '../../shared/utils/terminal-labs'
import { LABS } from '#layers/core/shared/utils/lab-names'
import { ALERT_TIER_FILTERS } from '../../../core/shared/utils/terminal-tiers'
import {
  MOVEMENT_WINDOW_HOURS,
  queryAlert,
  queryAlerts,
  queryOverview,
} from '../utils/terminal-alerts'
import { queryTrackRecord } from '../../../press/server/utils/terminal-track-record'
import {
  ALERT_SEARCH_DEPTH,
  json,
  failure,
  READ_ONLY,
  AsOfSchema,
  asOfErrors,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/utils/mcp-kit'

export function registerAlertTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_overview',
    {
      title: 'What moved',
      description:
        `The signal band. movement counts change rows by axis (pricing, hiring, sec) inside a ${MOVEMENT_WINDOW_HOURS}h window ` +
        'anchored to the NEWEST detection (window_from..latest_detected_at), not to the clock — so a quiet weekend still reports Friday’s moves. ' +
        'total_changes is the all-time denominator; sources_not_yet_compared counts sources with a single snapshot (nothing to diff yet). ' +
        'alerts are the newest notable/critical rows with their cited change rows and alert_count the total on file; info is the ' +
        'minor-changes tier (severity info: what moved, low stakes) and info_count its total. ' +
        'A change row is a diff between two snapshots, never a re-read of current state. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('overview', (ctx) => queryOverview(deps.db, ctx))),
  )

  server.registerTool(
    'get_alerts',
    {
      title: 'Alerts and minor changes',
      description:
        'Alerts newest first, each citing the change rows it is a claim about (changes, resolved; missing_change_ids if any did not resolve). ' +
        'Severity reads as a tier: info is minor changes (what moved, low stakes — a role added, a title reworded); notable and critical are alerts ' +
        '(a price move, a new SKU, a department-level hiring shift, a filing). tier selects alert, critical or notable (that severity only), info, or all (default all); ticker is an old name for info. ' +
        'lab and topic keep alerts citing at least one change row from that lab or on that axis (pricing, hiring, sec, revenue, incidents, disclosures, demand, exposure, compute). ' +
        'rule is s1-floor (deterministic: a registration statement appeared on EDGAR), periodic-floor (deterministic: a 10-Q/10-K on a ' +
        'whitelisted CIK), cik-resolved (deterministic: a pending lab’s own S-1 appeared and its CIK was read off it), model-floor (deterministic: a model slug no vendor catalog listed before), prospectus-floor (deterministic: what a lab’s new registration filing states — revenue and the price range on its cover), hiring-rollup (deterministic: one per lab per week, the board’s net change and the departments that moved most), filed-fact-floor (deterministic: a new 10-Q/10-K moved a hyperscaler series, on the exposure axis), guidance-floor (deterministic: a capex figure in a hyperscaler’s earnings release against its previous one, critical when the range moves; or a 10-Q/10-K’s year-to-date capex against that figure, on the exposure axis), gpu-median-floor (deterministic: the equal-weight H100 or B200 rental median moved 5% or more in 7 days over a fixed provider set, notable, or 15% or more, critical, on the compute axis) or agent-judge (a model’s reading of change rows, labelled as such). total is the count on file for the chosen tier. ' +
        `With a severity filter, the newest ${ALERT_SEARCH_DEPTH} rows of the tier are searched and up to limit returned. ` +
        PROVENANCE,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(ALERT_SEARCH_DEPTH).default(20),
        tier: z.enum([...ALERT_TIER_FILTERS, 'ticker']).default('all'),
        severity: z.enum(['info', 'notable', 'critical']).optional(),
        lab: z.enum([...LABS, 'other']).optional(),
        topic: z.enum(ALERT_AXES).optional(),
        as_of: AsOfSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ limit, tier: asked, severity, lab, topic, as_of }) =>
      asOfErrors(async () => {
        const tier = asked === 'ticker' ? 'info' : asked
        const depth = severity ? ALERT_SEARCH_DEPTH : limit
        const alerts = await read(
          'alerts',
          as_of,
          (ctx) => queryAlerts(deps.db, ctx, depth, tier, { lab, topic }),
          lab || topic ? `${tier}:${depth}:${lab ?? ''}:${topic ?? ''}:` : `${tier}:${depth}`,
        )
        if (!severity) return json(alerts)
        return json({
          ...alerts,
          rows: alerts.rows.filter((a) => a.severity === severity).slice(0, limit),
        })
      }),
  )

  server.registerTool(
    'get_alert',
    {
      title: 'One alert',
      description:
        'One alert by id (ids come from get_alerts, get_overview, the Atom feed or an /alerts/<id> permalink), with every cited change ' +
        'row in full: fields lists every scalar field before and after, unchanged ones included. ' +
        PROVENANCE,
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const detail = await deps.serve('alert', (ctx) => queryAlert(deps.db, ctx, id), id)
      if (!detail) return failure(`No alert with id ${id}.`)
      return json(detail)
    },
  )

  server.registerTool(
    'get_track_record',
    {
      title: 'Track record: did we see it before the press?',
      description:
        'For each notable or critical alert since 2026-09-08: saw_at (when the terminal saw the change: the fetch of the earliest cited ' +
        'change row, or for a removal the run that noticed it), and two sides, press (the first article GDELT indexed) and newsroom ' +
        '(the first post on the lab’s own newsroom feed; Anthropic and xAI publish none). A side has a time only when its state is matched: ' +
        'the judge rated that candidate the same event and every earlier candidate not. lead_hours is that time minus saw_at, ' +
        'positive when the terminal saw it first. Other states say why there is no time: window-open (searched once 7 days have passed), ' +
        'not-searched, not-searchable, no-feed, none-found, not-yet-rated (never a guessed lead), no-match. ' +
        'press.published_at is the quarter hour GDELT’s crawler read the article, not when the outlet published it, and GDELT misses outlets. ' +
        'A lead is not a trading signal. press and newsroom tally led, lagged, tied and the median lead over matched rows. ' +
        'A press side with searched_from set was searched only from that time: earlier press was read before the alert existed and never matched to it, ' +
        'so its lead may not be one, and the tally leaves it out (searched_in_part counts them). ' +
        PROVENANCE,
      inputSchema: z.object({ as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ as_of }) =>
      asOfErrors(async () =>
        json(await read('track-record', as_of, (ctx) => queryTrackRecord(deps.db, ctx))),
      ),
  )
}
