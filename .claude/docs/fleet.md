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
  `build.sha` is behind main's head on GitHub for a full tick, meaning a merge never deployed. Another is
  `judge_silent`: owed changes three hours old and no judge run in that time, repeated every six hours
  while it lasts. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.
- **Severity.** `layers/terminal/server/utils/ops-severity.ts` puts every kind in a tier: `critical`
  (the product stopped working: `judge_silent`, `all_sources_failed`, a burst of `server_error`),
  `warning` (a part is degraded; also the default for a kind the table does not name), or `info` (the
  system handled it). The digest leads with the most severe kind, and the subject starts with
  `[Critical]`, `[Warning]` or `[Info]`, so a mail filter on `subject:"[Critical]"` can mark those
  important and the rest stay quiet. Critical kinds carry a "What to do" line. A spool holding only
  info rows waits up to `OPS_INFO_HOLD_MS` (a day) unless something louder goes out first. Add a new kind
  to the table when you add its `recordOpsEvent` call.

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

## Alert webhooks (licensees)

Licensees with an API key can get alerts POSTed to an https URL
(`/data#webhooks`). The owner sets them up from the CLI, like keys:

```bash
bun run webhooks:add -- --key key_0a1b2c3d4e --url https://hooks.example.com/ft --severity notable [--remote]
bun run webhooks:list [-- --remote]
bun run webhooks:test -- --id whk_0a1b2c3d4e [--remote]
bun run webhooks:remove -- --id whk_0a1b2c3d4e [--remote]
```

- **Secret:** `NUXT_WEBHOOK_SIGNING_KEY` (32+ characters, 1Password "Frontier
  Terminal webhook signing key"). Each webhook's signing secret is
  HMAC-derived from it and the webhook id, so D1 stores no secret, only a
  SHA-256 fingerprint. `add` and `test` need the same value as the Worker:
  `NUXT_WEBHOOK_SIGNING_KEY="$(op read 'op://Private/Frontier Terminal webhook signing key/password')" bun run webhooks:add -- … --remote`.
  Rotating it breaks every webhook: each one goes `failing` with an ops event,
  and has to be removed and re-added with a new secret for the client.
- **Cron:** `webhooks:deliver` on the */5 tick (`layers/terminal/server/utils/webhook-outbox.ts`).
  Unset key = it returns before touching D1. The first run records every
  recent alert as seen and sends nothing.
- **Timing:** a delivery waits until the poll stamp is past the moment the
  cron first saw the alert, so the public pages already list it. A judged
  alert also waits out the social hold, from the same instant. Suppressing its
  social post (above) suppresses the webhook too, and so does deleting the alert.
- **Failures:** retried with backoff for 24 hours. Then the webhook is marked
  `failing`, one `webhook_failing` ops event goes out, and its queued
  deliveries wait. A passing `webhooks:test` makes it active again; anything
  queued more than 24 hours ago is dropped as `expired`.
- **Revoking the key** (`keys:revoke`) stops its webhooks at the next run.
