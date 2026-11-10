# Fleet contract — status, manifest, ops alerts

**Load this when:** you are touching `fleet.json`, `/api/status`, `/api/fleet`, the
`ops_events` spool or its fleet alerts, or wiring this app into the portfolio dashboard.

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
  and land in `extra` (including `subscribersConfirmed`, the confirmed digest subscribers).
- **Ops alerting.** Anything worth waking the owner up for calls
  `recordOpsEvent(db, { kind, detail, path })` — the error plugin already does
  for every 5xx. The app sends no mail: `GET /api/fleet` reports the last 24 h
  of the spool as `ops.kinds` (per kind: severity, count, newest detail) and the
  fleet dashboard is the only alert sender. Workers Issues
  (`[observability.issues]` in wrangler.toml) covers failures that spool nothing,
  such as a request that never returns.
  `layers/terminal/server/tasks/ops/watch.ts` (`ops:watch`, every 30 minutes) runs the
  watchdogs that spool their own events, then prunes the spool (`pruneOpsEvents()`; this app
  has no purge task). Mostly they are the **freshness checks**
  (`layers/terminal/server/utils/freshness.ts`), one rule for
  every part that can go quiet: a check is stale when work has been owed for longer than its limit
  and nothing succeeded within it, and it spools its kind once every six hours while that lasts.
  There is one check per scheduled task, read from the `task_heartbeats` row `withHeartbeat()`
  writes (`task_silent`; a run that throws also spools `task_failed` at once), plus one per
  producer off the Worker
  (`layers/terminal/server/utils/terminal-freshness.ts`): the judge routine (`judge_silent`, owed
  changes three hours old and no judge run in that time), the GDELT Actions job
  (`gdelt_search_silent`) and the social outbox (`social_outbox_stalled`). The deploy is one
  too (`deploy_drift`): production's `build.sha` behind main's head on GitHub for a full tick
  means a merge never deployed. A failed post-deploy smoke run spools `deploy_smoke_failed` when
  `reliability:deploys` reads it, since GitHub mails that failure to whoever triggered the run.
  `layers/terminal/test/freshness.test.ts` fails the build on a scheduled task with no check and
  on a check kind with no tier. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.
- **Severity.** Every kind has a tier from core's registry, `server/utils/ops-severity.ts`:
  `critical` (the product stopped working), `warning` (a part is degraded; also the default for a
  kind nobody registered), or `info` (the system handled it). Core escalates `server_error` to
  critical at `SERVER_ERROR_CRITICAL_COUNT` in 24 h; this app's kinds (`judge_silent` and
  `all_sources_failed` are the critical ones) are in `layers/terminal/server/utils/terminal-ops-severity.ts`,
  registered by `layers/terminal/server/plugins/ops-severity.ts`. Critical kinds carry a "What to do" line, and `/api/fleet` hands the severity to
  the dashboard, which decides what reaches the inbox. Add a new kind to the table when you add its `recordOpsEvent` call.

## Social posting (layers/social)

Critical alerts and a Monday what-moved thread post to the app's X and Bluesky
accounts through Buffer. A new critical alert is queued as a row by the
EVENTS queue's `alerts.new` fan-out, and `social:digest` queues the weekly
thread (`layers/terminal/server/pipeline/social.ts`); a delayed `social.drain`
message sends each row when it is due, and the hourly `events:sweep` catches
anything a lost message left (`layers/terminal/server/utils/events.ts`). The
layer's own `social:post` task is not scheduled. A due post still queued after
an hour spools `social_outbox_stalled`.

- **Secrets:** `NUXT_SOCIAL_BUFFER_API_KEY` (kept in 1Password),
  `NUXT_SOCIAL_CHANNEL_X`, `NUXT_SOCIAL_CHANNEL_BLUESKY`. With no key <!-- refs-check-ignore: runtimeConfig.social.channelBluesky in layers/social -->
  every task returns before touching D1.
- **Stopping it:** a key and a channel send. Delete `NUXT_SOCIAL_BUFFER_API_KEY` to
  stop posting at the next tick. Rows from before 2026-11-10 marked `dry-run` were
  never sent and never will be.
- **Suppress a judged alert** inside its one-hour hold:
  `UPDATE social_posts SET status = 'suppressed' WHERE kind = 'alert' AND ref = '<alert id>'`.
- **`unknown` rows** (network error or 5xx mid-send) are never retried and land in
  the fleet board as `social_unknown`. Check Buffer; set `sent` or `queued` by hand.
- `fleet.json` lists the key and the X channel, so the dashboard
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

- **Secret:** `NUXT_WEBHOOK_SIGNING_KEY` (32+ characters, kept in 1Password).
  Each webhook's signing secret is
  HMAC-derived from it and the webhook id, so D1 stores no secret, only a
  SHA-256 fingerprint. `add` and `test` need the same value as the Worker:
  `NUXT_WEBHOOK_SIGNING_KEY="$(op read 'op://…')" bun run webhooks:add -- … --remote`.
  Rotating it breaks every webhook: each one goes `failing` with an ops event,
  and has to be removed and re-added with a new secret for the client.
- **Trigger:** the EVENTS queue (`layers/terminal/server/utils/events.ts`).
  Writing an alert emits `alerts.new`; its fan-out queues the deliveries
  (`layers/terminal/server/utils/webhook-outbox.ts`) and schedules a
  `webhooks.drain` message for the first due row, and each drain reschedules
  itself while deliveries are owed, which is how backoff retries run. The
  hourly `events:sweep` covers a lost message. Unset key = the outbox is skipped
  before touching D1. A webhook gets the alerts written after it was added,
  within the last two days.
- **Timing:** a delivery waits until the poll stamp is past the moment the
  alert was written, so the public pages already list it. A judged
  alert also waits out the social hold, from the same instant. Suppressing its
  social post (above) suppresses the webhook too, and so does deleting the alert.
- **Failures:** retried with backoff for 24 hours. Then the webhook is marked
  `failing`, one `webhook_failing` ops event goes out, and its queued
  deliveries wait. A passing `webhooks:test` makes it active again; anything
  queued more than 24 hours ago is dropped as `expired`.
- **Revoking the key** (`keys:revoke`) stops its webhooks at the next run.

## Bulk feed: Parquet and S3 grants (licensees)

`bulk:build` (hourly at :41, `layers/terminal/server/utils/terminal-bulk.ts`) writes
each table's `recent` and `full` cuts as a gzipped CSV and a gzip Parquet file
(`terminal-parquet.ts`), from one pass over the table. The `recent` files go to
`BLOB`; the `full` files and a manifest go to `frontier-terminal-bulk-licensed`
(binding `BULK_LICENSED`), which holds nothing else, and `/export/bulk/full/*`
is served from there. A table not cut by age is one file pair in that bucket,
named by both its index entries. That bucket is what a licensee's S3
credentials open, read-only, so they can never reach the raw payloads in
`BLOB`. Without the binding (local dev) the build keeps everything in `BLOB`;
once it appears, the next run rebuilds every table to fill the bucket.

How a run spends its time: up to `BUILD_BUDGET_MS` (8 minutes of the cron's
15) starting cuts, smallest first, reading D1 `EXPORT_PAGE_SIZE` rows at a time,
and saving the index (`BULK_INDEX_PATH` in R2) after each cut. It also stops at `D1_READ_BUDGET`
planned queries, under D1's per-invocation query limit (a full rebuild needed
~370 on 2026-11-05). A cut that failed today is tried
last (`index.failures` says why), so it can't stall the rest. A schema release
rebuilds only the tables it lists. A cold rebuild of every cut fits one run.
If the feed stalls, compare `bulk_build_failed` ops events with the run's wall
and CPU time in Workers observability (filter `$workers.event.cron` = `41 * * * *`).

One-time setup (owner):

1. `bunx wrangler r2 bucket create frontier-terminal-bulk-licensed` (no public
   access, no custom domain).
2. An account-owned API token that can mint tokens: dashboard › Manage Account ›
   Account API Tokens › Create Custom Token, permission **Account › Account API
   Tokens › Edit**, no other. Save it in 1Password. The `cf` login can't do this: its OAuth scopes
   don't include token management.

Grants:

```bash
export BULK_GRANT_API_TOKEN="$(op read 'op://…')"
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
