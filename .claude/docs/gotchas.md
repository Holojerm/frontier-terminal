# Gotchas — silent failure modes

Failures this repo has actually hit that produce **no error**: wrong-file databases, migrations that never run, empty sitemaps, rate limiters that quietly do nothing. If something appears to work but produces no output, the answer is probably here.

> **Load this when:** debugging anything that fails quietly, touching D1/migrations/deploy config, adding a cron task or a custom `definePageMeta` key, or working in a git worktree.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

Sharp edges that have bitten this template before — read before forking or before debugging "why doesn't this work."

## Local D1 lives in two places — only one is real

NuxtHub serves the dev DB from `.data/db/sqlite.db`. Wrangler's own local D1 sandbox lives at `.wrangler/state/v3/d1/`. Migrations applied via `bun run db:migrate` or direct writes via `wrangler d1 execute --local` land in the **wrangler** path, which the dev server does NOT read. Anything that writes to the local dev DB from outside the app must open the NuxtHub path directly with `bun:sqlite`. The two only converge in production.

An empty local DB is normal on a fresh checkout, and it hides bugs. Filling it is in [`local-data.md`](local-data.md).

## NuxtHub applies dev migrations in directory order — patched to sort

NuxtHub (0.10.8 through 0.10.12, the latest checked) lists `.data/db/migrations/` with no sort, and on APFS directory order is not name order. A fresh `.data/db/sqlite.db` on a Mac therefore ran `0018` then `0009`, which failed (`no such table: entitlements`) before `0000` ever ran, and every data route returned 503 "Database unavailable". `patches/@nuxthub%2Fcore@0.10.8.patch` adds the `.sort()`. When upgrading NuxtHub, `bun install` fails on the stale patch: re-cut it with `bun patch @nuxthub/core` unless upstream sorts by then. A DB already broken this way is easiest rebuilt: move `.data/db/sqlite.db` aside and start `bun dev`.

## Production D1 is migrated only by `deploy:ci`

Locally this is invisible: NuxtHub's dev plugin (`applyMigrationsDuringDev`) applies
`server/db/migrations/` to `.data/db/sqlite.db` on every dev boot, so schema changes just
appear. Production has no equivalent.

`wrangler deploy` does not apply D1 migrations, and NuxtHub's `applyMigrationsDuringBuild`
step runs against the **libsql driver's local file on the build machine** (`hub.db` resolves
to `sqlite`/`libsql` here, not the `d1` driver), so it never touches your remote database.
The `.sql` files are copied into `.output/server/db/migrations/` and the generated
`wrangler.json` points `migrations_dir` at them — but nothing ever runs them.

So a deploy that adds a table ships a Worker querying a table that does not exist, and the
failure surfaces as a 500 on a route that worked perfectly in dev.

**Workers Builds closes that gap with its deploy command, `bun run deploy:ci`.** It runs
`db:migrate:remote`, then `wrangler --cwd .output deploy`, so the schema lands before the
code that needs it. Three consequences:

- The build token needs **D1 Edit**. The token Workers Builds generates has only Workers
  Scripts, KV, R2 and Routes permissions. Without D1 Edit the migrate step fails and the
  deploy never runs. The app keeps serving the previous build, and `deploy_drift` reports it.
- Migrations must be **expand-only**: add tables and nullable or defaulted columns. The
  previous build serves traffic between the migrate step and the deploy, and it serves
  everything if the deploy fails. Drop or rename only in a later release, once no deployed
  code reads the old shape.
- `migrations_table` matters. The script reads the root `wrangler.toml` (default
  `d1_migrations`), so do not alternate it with the `_hub_migrations` table that
  `.output/server/wrangler.json` names.

A manual `bun run deploy` still skips migrations. Run this yourself after one:

```bash
bun run db:migrate:remote
```

One wrinkle if you script it: the root `wrangler.toml` sets no `migrations_table`, so that
command tracks state in wrangler's default `d1_migrations`, while the generated
`.output/server/wrangler.json` sets `migrations_table = "_hub_migrations"`. Both work; pick
one and stay on it, because alternating makes each think nothing has been applied.

`GET /api/status` reports the gap: `migrations.pending` lists every migration in the repo
that the deployed database has not applied. It is what the portfolio dashboard polls, and
the quickest way to check by hand after a deploy —
`curl -H "Authorization: Bearer $NUXT_FLEET_TOKEN" https://<app>/api/status | jq .migrations`
(it 404s until `NUXT_FLEET_TOKEN` is set; see `.claude/docs/fleet.md`).

## NuxtHub rewrites the generated wrangler config

`wrangler.toml` is an input, not the deployed config. `nuxt build` writes
`.output/server/wrangler.json` and wrangler deploys that. Nitro copies your `wrangler.toml`
into it verbatim — bindings, `[triggers]`, `[[ratelimits]]` all survive, verified — and then
`@nuxthub/core` rewrites the file on Nuxt's `close` hook (`processWranglerConfigFile`),
deleting any `env` key. This repo has a single environment, so nothing is lost; if one is
ever added, know that it is selected at **build** time (`CLOUDFLARE_ENV=<name>`), not with
`wrangler --env`, because the generated file contains no environments by the time wrangler
reads it.

## A cron task needs the same string in two files

`nitro.scheduledTasks` (nuxt.config.ts) maps a cron expression to task names; `[triggers]
crons` (wrangler.toml) tells Cloudflare when to fire. The join is an **exact string match**
on the expression, so `"0 4 * * *"` and `"0 04 * * *"` are different keys — Cloudflare wakes
the Worker on schedule, `runCronTasks` finds nothing, and the handler returns success. No
error, no log line. If a task never runs, compare those two strings before anything else.

`bun run crons:check` (in `bun run ci`) compares them for you, both directions, and also
fails when a scheduled task name has no file under `server/tasks/`. The map is declared
once as `SCHEDULED_TASKS` at the top of `nuxt.config.ts` and handed to both
`nitro.scheduledTasks` and `runtimeConfig.scheduledTasks` (what `/api/status` reports) —
keep it there; the gate can read an inline literal too, but one map is harder to get wrong.

A task that is wired correctly can still stop: the cron stops firing, the run is killed at
the CPU limit, or it throws every tick. Every task file therefore ends in
`export default withHeartbeat(task)` (`layers/terminal/server/utils/task-heartbeat.ts`),
which records each run in `task_heartbeats`, and the freshness checks in `ops:alert`
spool `task_silent` when a task has not completed in one missed run plus half an interval
(`layers/terminal/server/utils/freshness.ts`). `layers/terminal/test/freshness.test.ts`
fails the build on a task file without it. A task that cannot carry the wrapper (one in a
vendored layer) gets a check of its own in `TASK_CHECK_OVERRIDES`, with the reason.

No custom Worker entry is needed for a background surface: the `cloudflare_module`
preset already exports `scheduled()` (which calls `runCronTasks` when
`nitro.experimental.tasks` is on) and `queue()` (which dispatches the `cloudflare:queue`
Nitro hook), plus `email`, `tail` and `trace`. Hook them from `server/plugins/`; do not
hand-write an entry that re-exports `fetch`, because it will rot the next time Nitro changes
one of them.

Note that Nitro **skips scheduled tasks under vitest** (`isTest` in its task runtime). Put
the logic in a `server/utils/` function that takes `db` (and any binding it needs) as an
argument and test that, as `server/utils/ops.ts` does — a test driving the task wrapper
tests the shim. For the same reason, a task must import `db`/`blob` **explicitly** from
`@nuxthub/db` / `@nuxthub/blob` rather than relying on the auto-imports: a task is an
untested bundling surface that runs unattended, and the `kv is not defined` failure in
the gotcha below would surface as a cron event failing with nobody watching.

Anything a sweep filters on needs an **index**. A `LIMIT` bounds rows *deleted*, not rows
*examined* — so an unindexed predicate full-scans the table on every tick and gets slower
as the table grows. `ops_events.notified_at` has one for exactly this reason.

## The dev server caches its DB connection — external writes need a restart

Anything writing to `.data/db/sqlite.db` with `bun:sqlite` writes the file correctly, but a
**running** dev server keeps its own libsql connection and will keep returning the old rows.
Observed directly on the template this came from: insert a row while `bun dev` is up and the
API still reports the old state, with the row plainly visible in the file. Restart the dev
server (or touch `nuxt.config.ts`) and it appears immediately.

So: write before starting the dev server, or restart after writing. Don't go debugging the query.

## NuxtHub's `kv` auto-import doesn't reach every file at runtime

`kv` (the unstorage handle for the KV binding) is declared in `.nuxt/types/nitro-imports.d.ts`, so
it **typechecks** anywhere in `server/`. It is not always **injected** at runtime: in
`server/utils/rate-limit.ts` it resolved to `ReferenceError: kv is not defined` while the build,
typecheck, and lint were all green. Because the rate limiter fails open by design, the only symptom
was a `rate_limit_unavailable` line in the logs — the feature was simply off.

Import it explicitly (`import { kv } from '@nuxthub/kv'`) in server utils. More generally: when a
NuxtHub auto-import is load-bearing, check the running logs, not just the type checker.

## Custom `definePageMeta` keys need two opt-ins, and fail silently without them

`sitemap.xml` and `llms.txt` are built from `definePageMeta({ publicPage: … })`, collected by
a hook in `nuxt.config.ts`. Three things have to be right, and getting any of them wrong
produces an **empty sitemap** rather than an error:

1. **`experimental.extraPageMetaExtractionKeys: ['publicPage']`.** Nuxt's build-time
   `definePageMeta` scanner only extracts a fixed allowlist (`name`, `path`, `middleware`, …).
   Without this, a custom key is discarded and replaced with a `__nuxt_dynamic_meta_key`
   marker — the hook then sees every page as unmarked.
2. **Collect in `pages:resolved`, not `pages:extend`.** Extraction happens *between* the two
   hooks. In `pages:extend`, `page.meta` is still `null` for every page.
3. **Write to the Nitro instance too.** Nitro is already initialised by `pages:resolved`, so
   `nuxt.options.runtimeConfig` alone is too late; `useNitro().options.runtimeConfig` is what
   ends up in the bundle. `nuxt.config.ts` sets both.

Also: values must be JSON-serializable *literals*. An interpolated string or a referenced
constant fails `isSerializable` and is dropped, silently, the same way.

## NuxtUI v4 needs an explicit CSS entry

`app/assets/css/main.css` must contain `@import "tailwindcss"; @import "@nuxt/ui";` and be listed under `css:` in `nuxt.config.ts`. Without this, NuxtUI's generated theme (`.nuxt/ui.css`) doesn't get bundled — pages render in browser default fonts/colors with no Tailwind utilities working. Already wired up in this template; don't remove either piece.

## Parallel agent worktrees are supported — keep them that way

Agents can work in isolated git worktrees under `.claude/worktrees/<name>` (gitignored), several
at once. Everything in `bun run ci` is scoped to the checkout it runs in, so a sibling worktree
full of half-finished or deleted code cannot contaminate your run. That is a property worth
stating, because it is easy to break and the breakage is confusing rather than loud.

How each gate stays scoped — **match this when you add a gate**:

| Gate | Why a sibling worktree can't reach it |
| --- | --- |
| `lint` | `.oxlintrc.json` › `ignorePatterns` lists `.claude/**` |
| `design:check` / `seo:check` / `brand:check` | Walk `ROOT/app`, `ROOT/app/pages`, and fixed root-relative asset paths |
| `globals:check` | Walks `ROOT/server` and `ROOT/layers/*/server` |
| `test` | `vitest.config.ts` › `include` is `test/**` + `server/**`, relative to the checkout |
| `typecheck` | Nuxt's generated `.nuxt/tsconfig.*` use scoped includes (`../app/**/*`, `../server/**/*`), not a root glob |
| `test:a11y` | Per-checkout port — see below |
| `build` | Nuxt only reads `app/`, `server/`, `shared/` |

Three rules follow, and each one exists because something broke it:

1. **A gate takes its scan root from the checkout** — not a walk upward, not a bare `**/*` glob.
2. **A gate that binds a port derives it** via `scripts/worktree-port.ts`. Never hardcode one.
3. **A gate never writes to a tracked file.** `nuxt-mcp` rewrites `.mcp.json` with the live dev
   server URL on every boot, and `test:a11y` boots one — so a green run used to end with a dirty
   tree, and `git add -A` would commit a throwaway port. Two guards now: the rewrite is disabled
   whenever `NUXT_DEVTOOLS=false` (`nuxt.config.ts` › `modules`), which is exactly the automated
   case, and `.mcp.json` is untracked entirely (`.mcp.json.example` is the shared copy), so the
   rewrite has nothing to dirty even when it does run.

## `bun dev` gets a per-worktree hostname

`bun dev` runs `scripts/dev.ts`, which hands portless an explicit hostname instead of letting it
infer one: the bare configured name in the main checkout (`my-app.localhost` — unchanged), and
`<worktree-dir>.my-app.localhost` in a linked worktree. It prints the host on startup.

The wrapper exists because portless's own worktree prefix is derived from the **branch**, and a
branch is not a unique key for a worktree. Three ways that collides, all of them silent:

| Case | portless alone | Why it happens |
| --- | --- | --- |
| Worktree checked out on `main` | `my-app.localhost` — same as the main checkout | `main`/`master` are treated as default branches and skipped |
| Detached-HEAD worktree | `my-app.localhost` | Branch reads as `HEAD`, also skipped — and Claude Code creates detached worktrees |
| `feat/pricing` vs `claude/pricing` | both `pricing.my-app.localhost` | The prefix is only the branch's last path segment |

The worktree *directory* has none of those problems: git won't create two worktrees at one path,
so it's unique by construction and — unlike the branch — doesn't change under you. That's what
keeps the URL stable when you switch branches inside a worktree.

`scripts/dev.ts` uses the positional `portless <name> <cmd>` form, which takes the name verbatim.
`portless run --name` would stack its branch prefix on top: still unique, but the hostname would
move every time the branch did. `bun dev:app` bypasses the proxy entirely.

**An agent session can't start the proxy.** When it isn't running, portless wants `sudo` to
bind 443, and a shell with no TTY can't answer the prompt, so `bun dev` exits with "Proxy is
not running and no TTY is available for sudo". Use `bunx nuxt dev --port <n>` with a port of
your own (`bun dev:app` assumes 3000, which another checkout may hold). For Playwright
scripts against `nuxt dev`, wait on `load` and a selector: with devtools on, the HMR
websocket keeps `networkidle` from ever firing.

> **Historical note.** This section used to warn that `vue-tsc` picked up `.claude/worktrees/`
> and to fix it with `rm -rf .claude/worktrees/<old>`. That is no longer true on Nuxt 4.5: the
> generated tsconfigs scope their includes, and a worktree containing deliberately unbuildable
> code now passes `bun typecheck` untouched. Believing the old note is the more expensive
> mistake, because it argues against running agents in parallel at all.

## Workers Builds: dashboard Worker name must match `wrangler.toml`

CI/CD runs on Cloudflare Workers Builds (repo connected in the dashboard under Worker → Settings → Build). The Worker's name in the dashboard must exactly match `name` in the root `wrangler.toml`, or every build fails before it starts. Build settings live in the dashboard, not in the repo: build command `bun run ci`, deploy command `bun run deploy:ci` (migrates production D1, then deploys; needs D1 Edit on the build token, see above).

**A build that fails to start is not retried.** "Build failed to initialize and was timed out" means the build environment never came up, and Workers Builds leaves production on the previous commit. The ops digest reports it as `deploy_drift` (`layers/terminal/server/pipeline/deploy-watch.ts`) once main has been ahead of `/api/status` → `build.sha` for one tick. To retry without an empty commit, start a build on the `main` trigger with the **full** sha. A short sha fails at clone with "error occurred while fetching repository":

```bash
cf builds triggers list --external-script-id "$(cf workers scripts search --name frontier-terminal | jq -r '.[0].id')"
cf builds create <main-trigger-uuid> --body "{\"branch\":\"main\",\"commit_hash\":\"$(git rev-parse origin/main)\"}"
cf builds logs get <build-uuid>
```

## Production can break with CI green — three ways it has, and the guard for each

All three happened on 2026-11-04. Dev, vitest, typecheck and the build pass each one.

| Failure | What happened | Guard |
| --- | --- | --- |
| A cron invocation runs out of memory | google-careers (~20 MB) joined the six-hourly survey; the 18:00 tick died `exceededMemory` and lost every source it had not recorded | `layers/terminal/test/pipeline/payload-budget.test.ts`, in `bun run test` |
| A deploy is refused | #169 called `crypto.randomUUID()` at module load, through a factory's default parameter; Cloudflare rejected the deploy (error 10021) and production stayed on the previous commit | `bun run globals:check`, in `bun run ci` |
| The deploy lands broken, or never lands | nothing on GitHub turned red for the refused deploy above | `.github/workflows/post-deploy-smoke.yml` runs `bun run smoke` after every push to main |

**Payload budget.** The test sizes every source each cron invocation fetches — the poll
lanes in `scopes.ts`, the derived families at their production counts, and the survey's
recipes — from `fixtures/manifest.json` › `raw_bytes`, or `raw_bytes:` on a sources.yaml
entry with no fixture. It fails when a source over 16 MiB shares a lane, or a lane totals
over 112 MiB; the test's header gives the evidence for both numbers. The survey sits at
~109 MiB, so its next big source needs a lane of its own (#164 shows how: a scope, a task, a
cron string in both files). Sizes are as recorded, so recapturing a grown fixture is what
lets the gate see upstream growth.

**Module load.** Workers run each module's top level once, in global scope, and refuse
random values, timers and I/O there; the clock reads 1970 there instead. `globals:check`
parses `server/` and `layers/*/server/` and flags `crypto.randomUUID`,
`crypto.getRandomValues`, `Math.random`, `setTimeout`, `setInterval`, `fetch`, `Date.now`
and an argument-less `new Date()` outside a function, and follows module-scope calls into
functions it can resolve (same file, or a relative or alias import), up to three calls deep,
including omitted parameters' defaults. It does not follow Nuxt auto-imports called with no
import, method calls or re-exports. Fix by making the value on first use, as #170 did;
`// global-scope-ok: <why>` silences a line that is safe. The gate checks itself on #169's
pattern before every scan, because the TypeScript parser it uses cannot load in vitest.

**Smoke.** The workflow polls `/api/status` for up to 20 minutes until `build.sha` is the
pushed commit (a deploy that never lands fails here), then requires `status: ok`, no pending
migrations, a cron map equal to `SCHEDULED_TASKS`, and a 200 from `/`, `/alerts`,
`/revenue`, `/exposure`, `/data`, `/api/overview` and `/api/coverage`. A failure is a red
check on the main commit and a GitHub email to whoever merged. It is not in `deploy:ci`:
by then the deploy has happened, and a deploy that is refused never reaches that step. Run
it by hand with `bun run smoke -- --wait 0`.

## The browser suites run in GitHub Actions, NOT in `bun run ci`

They used to be in `ci`. They were moved on 2026-08-22, because Workers Builds
**cannot run a browser** and the two documented fixes were both tried and both failed —
so don't move them back without reading this.

What was observed, on every branch, since the moment the repo was connected:

```
error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file
  at globalSetup (test/warmup/global-setup.ts:36:34)
```

The build image ships no Chromium system libraries. The documented fix is
`playwright install --with-deps chromium`, and it cannot work either, because the
image is non-root:

```
$ playwright install --with-deps chromium
Switching to root user to install dependencies...
Password: su: Authentication failure
```

So `.github/workflows/browser-suites.yml` runs `bun run ci:browser` on GitHub's
ubuntu runners, where `--with-deps` succeeds. Everything else stayed in Workers
Builds: lint, the design/brand/mirror/seo gates, typecheck, the unit tests and the
build. Those block a **deploy**; the browser suites block a **merge**.

**`test:a11y` is TWO Playwright projects, not one** — `a11y` and `csp`. So the
Content-Security-Policy gate now lives in the Action too. That is the trap: a broken CSP
fails silently, in exactly the way that gate exists to catch. Deleting that workflow
deletes the CSP gate, and nothing will tell you.

The other half of the original note still stands: because the *build command* lives in the
Cloudflare dashboard rather than the repo, a fork cannot fix this by editing `ci` alone —
which is why the fix is a workflow file, something a fork inherits automatically.
- **The suite starts its own dev server** (`playwright.config.ts` → `webServer`) with
  `reuseExistingServer: false`. That is deliberate: it only produces valid results against a
  server started with `NUXT_DEVTOOLS=false`, and reusing a dev server you already had running
  reports the devtools panel's own markup as your app's violations. So a stale process on the
  suite's port makes the run fail to boot rather than silently lie — kill it, don't flip
  `reuseExistingServer`.
- **The port is derived from the checkout path**, not fixed (`scripts/worktree-port.ts`,
  range 3100–3899). Every worktree gets its own, so parallel agents don't collide and a
  `bun run dev:app` on 3000 doesn't either. It's deterministic, so the same checkout always
  gets the same port and you can open it by hand mid-run — `bun run test:a11y` prints it.
  Set `A11Y_PORT` to pin a value. Any future suite that binds a port must use this helper.
- **The `webServer.timeout` is sized for a cold cache, not your machine.** A cold `nuxt dev`
  builds the whole app before it listens; anything that invalidates the Nuxt build cache
  (editing `nuxt.config.ts`, a merge that touches it) puts you back on that path. Observed:
  a 120s budget timed out on the first run after such a merge, and the very next warm boot
  took 2s. CI is *always* cold, so the budget is 300s and the server runs with
  `NUXT_TYPECHECK=false` to keep vue-tsc off the critical path — `bun run ci` has already
  typechecked by then.
- **Listening is not warm.** Vite compiles each page's own components on that page's first
  browser request, so `test/warmup/global-setup.ts` visits one path per page file before the
  tests race. Warming only the shell passed on the Mac mini and timed out a different lab or
  compare page every run on the two-core `ubuntu-latest` fallback. A new page file in the
  suites goes in its `WARM_PATHS`.
- **The store is filled from fixtures first** (`test/warmup/fill-store.ts`, see
  [`local-data.md`](local-data.md)). Without rows the sweep only judges empty states.

## Don't add `nuxt-mcp-toolkit` config under `mcp:` in `nuxt.config.ts`

If you ever pull in `@nuxtjs/mcp-toolkit` (not currently installed), its `ModuleOptions` augmentation doesn't surface as a top-level `mcp:` key in `defineNuxtConfig` — TypeScript will reject it. Configure via `defineMcpHandler` in `server/mcp/index.ts` instead. <!-- refs-check-ignore: hypothetical, the module is not installed -->

