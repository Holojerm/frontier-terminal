// The feed itself: coverage, reliability, and deployment status.

import { repoSlug, workflowRunsUrl } from '../../../reliability/server/pipeline/reliability/deploys'
import manifest from '~~/fleet.json'

export function registerFeedTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_coverage',
    {
      title: 'Source coverage',
      description:
        'Every registered source: its audited URL, role (primary, join, cross-check, sec), the audit’s caveat in its own words, ' +
        'newest snapshot (with HTTP status and byte count), how the last poll ended (ok, unchanged, failed, baseline), snapshot count ' +
        'and how many current rows came from it. recipes lists the thesis recipes (GPU rental prices, filers outside the labs), which store ' +
        'outside the lab tables: each one’s last run, observation count, newest stored fetch, and its audit caveat and terms. ' +
        'cuts lists what is deliberately NOT tracked and why. totals are table row counts; ' +
        'exports describes the CSV/JSON bulk downloads at /export/<table>.csv|json; history says whether a table downloads whole or, by default, ' +
        `only its last ${LICENSE_WINDOW_DAYS} days (add ?history=full for every row, labeled per row with its license). Each column’s type, unit, nullability, ` +
        'meaning and license-window date are in the data dictionary at /export/dictionary.json, with the schema_version and its changelog. ' +
        'Every table is also a daily gzipped CSV and Parquet file listed, with SHA-256s, in /export/bulk/manifest.json. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'coverage',
          (ctx) => queryCoverage(deps.db, ctx),
          await recipeRunsStamp(deps.db),
        ),
      ),
  )

  server.registerTool(
    'get_reliability',
    {
      title: 'Reliability: how the feed itself has performed',
      description:
        `For due diligence on the feed, computed from stored records. sources: each registered source (derived per-model and per-filing sources folded by template, members > 0) with runs and good runs over the last ${RELIABILITY_DAYS.short} (short) and ${RELIABILITY_DAYS.long} (long) UTC days, ` +
        'where good is ok, unchanged, baseline or absent (an answered check) and skipped runs are not counted; longest_gap is the longest wait between good runs (to null while still open); stated_minutes is how often we say we check it. Worst first. ' +
        'freshness: per lane (sec: SEC feeds, model catalogs and price lists, stated every 30 minutes; all: every source, stated every 6 hours), the periods our data was past its stated age, from the poll ticks in which most sources answered. ' +
        `detection: each filing a no-model rule alerted on (${DETECTION_RULES.join(', ')}), its first alert time against EDGAR's acceptance time (accepted_at, read from the stored submissions JSON or filing index; null when no stored payload listed it), ` +
        'and released_at, when EDGAR made it public (6:00 a.m. Eastern on the filing date for a filing accepted after 5:30 p.m. Eastern). Median and worst minutes for both. ' +
        'deploys: each run of the post-deploy smoke test on main from GitHub Actions (conclusion success, failure, or cancelled when a newer push superseded it), with build_sha the commit now deployed. ' +
        'corrections: the count and newest entry of the public corrections log. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => {
      const slug = repoSlug(manifest.links.github ?? '')
      const opts = {
        buildSha: deps.status.buildSha || null,
        repoUrl: manifest.links.github ?? '',
        runsUrl: slug ? workflowRunsUrl(slug) : '',
      }
      return json(
        await deps.serve(
          'reliability',
          (ctx) => queryReliability(deps.db, ctx, opts),
          await reliabilityStamp(deps.db),
        ),
      )
    },
  )

  server.registerTool(
    'get_status',
    {
      title: 'Deployment status',
      description:
        'Is what is running the thing that was meant to be running: build sha, migrations the repo has vs. the ones production applied ' +
        '(pending non-empty = a deploy outran its migration), the cron map, and the newest fetch per source. ' +
        'status is ok, degraded (migrations pending) or down (database unreachable). Not cached. No secrets.',
      annotations: READ_ONLY,
    },
    async () => json((await collectStatus(deps.db, deps.status)).payload),
  )
}
