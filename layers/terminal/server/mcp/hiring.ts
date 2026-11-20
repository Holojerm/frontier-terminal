// Open roles now and over time.

import { z } from 'zod'
import { HIRING_WINDOW_DAYS, queryHiring, queryHiringHistory } from '../utils/terminal-hiring'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  AsOfSchema,
  asOfErrors,
  PROVENANCE,
  type McpKit,
} from './kit'

export function registerHiringTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_hiring',
    {
      title: 'Open roles',
      description:
        'Open roles per lab, counted from the CURRENT job-board set (a role missing from the board is closed), by department. ' +
        'feed says what the number is: ok, no_rows (feed registered, nothing parsed yet), or no_public_feed — Meta, DeepSeek, Alibaba and Moonshot AI, which ' +
        'have no public hiring feed we can read, so each total is 0 with the audit’s reason rather than a guess. Google counts DeepMind’s roles only ' +
        '(company_names says so), not Alphabet’s. xAI’s board is blended with SpaceX ' +
        '(every row carries company_name "SpaceXAI", now "SpaceXSI"); the caveat and company_names travel with the row so you can say so. ' +
        'as_of before our first read of the boards answers from the Internet Archive’s copies of each lab’s own board ' +
        '(source_id wayback:<era>, point_in_time names each copy; event time, not knowledge time). Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const hiring = await read('hiring', as_of, (ctx) => queryHiring(deps.db, ctx), '', 'hiring')
        if (!provider) return json(hiring)
        return json({
          ...hiring,
          providers: hiring.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_hiring_history',
    {
      title: 'Open roles per day',
      description:
        'Open roles per lab and department, per UTC day (dates, total, departments[].series), RECONSTRUCTED by undoing the ' +
        'change log backwards from the current job-board set — not a series of daily snapshots. Each series starts at the ' +
        'provider’s earliest board snapshot (series_from); baseline_at is this store’s first poll, and roles that opened or closed ' +
        'before the log begins are carried as they stand today, so the oldest points understate churn. compare sets today ' +
        `against ${HIRING_WINDOW_DAYS} days back, or the series start when that is younger (days says which). log is the change ` +
        'rows the series rests on. clusters[] sums named department clusters from sources.yaml — physical-infrastructure (Data Center, ' +
        'Infrastructure, Facilities, Energy, Construction, Compute, Hardware; not Software) is the capacity-buildout signal — with the ' +
        'matched department labels listed so the sum is checkable. Meta, DeepSeek, Alibaba and Moonshot AI are audited cuts (feed ' +
        'no_public_feed, reason given) with empty series; xAI carries the SpaceXAI blend caveat. archived[] is the history from ' +
        'before the live series: the Internet Archive’s weekly copies of each lab’s own board (basis archived, source_id ' +
        'wayback:<era>, at = when the Archive saw it, fetched_at = when we read it), with the board total and clusters, CC BY-NC. ' +
        'Their departments are left out here: GET /api/hiring/history has them, and /export/archived_hiring.csv every row. ' +
        'reach says how far each lab’s history goes and every gap with its reason; archive_method says the rest. ' +
        'Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const history = await read(
          'hiring-history',
          as_of,
          (ctx) => queryHiringHistory(deps.db, ctx),
          '',
          'hiring',
        )
        // An archived copy's departments would put a few hundred kB in a tool
        // result; the totals and clusters stay, the rest is one request away.
        const slim = {
          ...history,
          providers: history.providers.map((p) => ({
            ...p,
            archived: p.archived.map((a) => ({ ...a, departments: null })),
          })),
        }
        if (!provider) return json(slim)
        return json({
          ...slim,
          providers: slim.providers.filter((p) => p.provider === provider),
        })
      }),
  )
}
