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
  counters as they arrive) behind `NUXT_FLEET_TOKEN`; 404 when unset. Add a
  counter to `collectFleetCounters()`'s `extra`, not a second endpoint.
- **Ops alerting.** Anything worth waking the owner up for calls
  `recordOpsEvent(db, { kind, detail, path })` — the error plugin already does
  for every 5xx — and `server/tasks/ops/alert.ts` drains the spool into one
  digest email every 30 minutes via the `[[send_email]] ALERT_EMAIL` binding.
  Unconfigured = one `ops_alert_unconfigured` log line per tick and nothing
  sent. Rows are marked notified only after the send resolves, so a mail
  hiccup retries instead of losing the alert. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.
