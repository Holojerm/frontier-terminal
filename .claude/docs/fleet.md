# Fleet contract — status, manifest, ops alerts

**Load this when:** you are touching `fleet.json`, `/api/status`, `/api/fleet`, the
`ops_events` spool or its digest cron, or wiring this app into the portfolio dashboard.

This app can be watched by one portfolio dashboard (`fleet`, itself a template fork).
Three pieces:

- **`fleet.json`** says what this app is — slug, stage, Workers, binding ids,
  crons, which optional modules it kept, which secret *names* production needs.
  Shape: `shared/utils/fleet-manifest.ts`. `bun run fleet:check` fails the build
  when it stops matching `wrangler.toml`, so it can be trusted; edit both in the
  same commit. `template.syncedSha` is the template commit this app was last
  brought level with; `template.customized` lists the seam files it changes on
  purpose, which the dashboard's seam-drift check then skips.
- **`GET /api/status`** is public and carries no secrets (a deliberate difference from
  the template, which put it behind `NUXT_FLEET_TOKEN` in #85: this is an open-source
  data site with an external heartbeat and an MCP `get_status` tool, and the sha,
  migration tags and cron map are all in the public repo): build sha, the
  migrations the repo has vs the ones production applied (`migrations.pending`
  non-empty = the deploy-before-migrate outage, live), the cron map Nitro runs.
  `GET /api/fleet` is counters only (the ops spool today; the pipeline's own
  counters as they arrive) behind `NUXT_FLEET_TOKEN`; 404 when unset. Never edit
  `collectFleetCounters()` to add a counter, and don't add a second endpoint: register a
  contributor from a Nitro plugin with `registerFleetExtraContributor({ key, collect })`
  (`server/utils/extensions.ts`, a trimmed copy of the template's registry). The pipeline's
  numbers are registered that way by `layers/terminal/server/plugins/fleet-counters.ts`
  and land in `extra`.
- **Ops alerting.** Anything worth waking the owner up for calls
  `recordOpsEvent(db, { kind, detail, path })` — the error plugin already does
  for every 5xx — and `server/tasks/ops/alert.ts` drains the spool into one
  digest email every 30 minutes via the `[[send_email]] ALERT_EMAIL` binding.
  Unconfigured = one `ops_alert_unconfigured` log line per tick and nothing
  sent, but the retention sweep (`pruneOpsEvents()`) still runs. Rows are marked notified only after the send resolves, so a mail
  hiccup retries instead of losing the alert. Before draining, the same tick runs
  the watchdogs that spool their own events. One is `deploy_drift`: production's
  `build.sha` is behind main's head on GitHub for a full tick, meaning a merge never deployed. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.

## Social posting (layers/social)

Critical alerts and a Monday what-moved thread post to the app's X and Bluesky
accounts through Buffer. `social:alerts` and `social:digest` queue rows
(`layers/terminal/server/pipeline/social.ts`); `social:post` sends them.

- **Secrets:** `NUXT_SOCIAL_BUFFER_API_KEY` (1Password "Buffer API — Frontier
  Terminal"), `NUXT_SOCIAL_CHANNEL_X`, `NUXT_SOCIAL_CHANNEL_BLUESKY`. With no key <!-- refs-check-ignore: runtimeConfig.social.channelBluesky in layers/social -->
  every task returns before touching D1.
- **Kill switch:** `NUXT_SOCIAL_ENABLED=1` sends. Unset is a dry run — due rows
  become `dry-run`, so switching on never flushes a backlog. Delete the secret to
  stop posting at the next tick.
- **Suppress a judged alert** inside its one-hour hold:
  `UPDATE social_posts SET status = 'suppressed' WHERE kind = 'alert' AND ref = '<alert id>'`.
- **`unknown` rows** (network error or 5xx mid-send) are never retried and land in
  the ops digest as `social_unknown`. Check Buffer; set `sent` or `queued` by hand.
- `fleet.json` lists the key, the X channel and the switch, so the dashboard
  flags any of them going missing. A Bluesky channel joins that list when one is set.
