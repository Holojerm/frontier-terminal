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
- **Severity.** Every kind has a tier from core's registry, `server/utils/ops-severity.ts`:
  `critical` (the product stopped working), `warning` (a part is degraded; also the default for a
  kind nobody registered), or `info` (the system handled it). Core escalates `server_error` to
  critical at `SERVER_ERROR_CRITICAL_COUNT` in one digest; this app's kinds (`judge_silent` and
  `all_sources_failed` are the critical ones) are in `layers/terminal/server/utils/terminal-ops-severity.ts`,
  registered by `layers/terminal/server/plugins/ops-severity.ts`. The digest leads with the most
  severe kind, the subject starts `[Critical]`, `[Warning]` or `[Info]` so a mail filter on
  `subject:"[Critical]"` can mark those important, critical kinds carry a "What to do" line, and a
  spool of only info rows waits up to `OPS_INFO_HOLD_MS` (a day) unless something louder goes out
  first. Add a new kind to the table when you add its `recordOpsEvent` call.

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

## Bulk feed: Parquet and S3 grants (licensees)

`bulk:build` (hourly at :41, `layers/terminal/server/utils/terminal-bulk.ts`) writes
each table's `recent` and `full` cuts as a gzipped CSV and a zstd Parquet file
(`terminal-parquet.ts`) to `BLOB`, from one pass over the table. The `full`
files and a manifest are also copied to `frontier-terminal-bulk-licensed`
(binding `BULK_LICENSED`), which holds nothing else. That bucket is what a
licensee's S3 credentials open, read-only, so they can never reach the raw
payloads in `BLOB`. Without the binding the build runs and makes no copies; once
it appears, the next run rebuilds the `full` cuts to fill the bucket.

One-time setup (owner):

1. `bunx wrangler r2 bucket create frontier-terminal-bulk-licensed` (no public
   access, no custom domain).
2. An account-owned API token that can mint tokens: dashboard › Manage Account ›
   Account API Tokens › Create Custom Token, permission **Account › Account API
   Tokens › Edit**, no other. Save it in 1Password as "Frontier Terminal bulk
   grants" (field `credential`). The `cf` login can't do this: its OAuth scopes
   don't include token management.

Grants:

```bash
export BULK_GRANT_API_TOKEN="$(op read 'op://Private/Frontier Terminal bulk grants/credential')"
bun run bulk:grant -- --key key_0a1b2c3d4e --remote            # prints S3 credentials once
bun run bulk:grants -- --remote                                # list
bun run bulk:grant -- --key key_0a1b2c3d4e --revoke --remote   # or --grant grant_…
bun run bulk:grant -- --sweep --remote                         # revoke grants of revoked/expired keys
```

- A grant is one account-owned token with "Workers R2 Storage Bucket Item
  Read" on that bucket only, expiring with the key. Its id is the S3 access
  key id; the secret is the SHA-256 of its value, printed once and never
  stored. D1 `bulk_grants` records id, key, token id, created, expires, revoked.
- `keys:revoke` revokes the key's grants too when `BULK_GRANT_API_TOKEN` is
  set, and exits non-zero with the command to run when it isn't.
- An expired key's token has already expired at Cloudflare; `--sweep` deletes
  it and records why.
- Check the copy after a build:
  `bunx wrangler r2 object get frontier-terminal-bulk-licensed/manifest.json --remote --pipe | jq .generated_at`.
