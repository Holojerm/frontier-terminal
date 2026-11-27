# Gotchas: silent failure modes

Failures this repo has hit that produce **no error**: wrong-file databases, migrations that never run, empty sitemaps, rate limiters that do nothing. If something appears to work but produces no output, the answer is probably here.

> **Load this when:** debugging anything that fails quietly, touching D1/migrations/deploy config, adding a cron task or a custom `definePageMeta` key, or working in a git worktree.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Local D1 lives in two places — only one is real

NuxtHub serves the dev DB from `.data/db/sqlite.db`. Wrangler's own local D1 sandbox lives at
`.wrangler/state/v3/d1/`. Migrations applied with `bun run db:migrate` and writes with
`wrangler d1 execute --local` land in the **wrangler** path, which the dev server does not read.
Anything that writes to the local dev DB from outside the app opens the NuxtHub path directly
with `bun:sqlite`. The two only converge in production.

An empty local DB is normal on a fresh checkout, and it hides bugs. Filling it is in
[`local-data.md`](local-data.md).

## NuxtHub applies dev migrations in directory order — patched to sort

NuxtHub (0.10.8 through 0.10.12, the latest checked) lists `.data/db/migrations/` with no sort,
and on APFS directory order is not name order. A fresh `.data/db/sqlite.db` on a Mac ran `0018`
before `0000`, failed (`no such table: entitlements`), and every data route returned 503
"Database unavailable". `patches/@nuxthub%2Fcore@0.10.12.patch` (bun's `patchedDependencies`)
sorts the list by name, the order drizzle-kit numbers them. Production is unaffected:
`wrangler d1 migrations apply` sorts its own list.

When upgrading NuxtHub, `bun install` does not fail on the stale patch: it prints one
`no longer applies` warning and drops the entry from `bun.lock`, so the bug comes back with CI
green. `bun run patches:check` (part of `bun run ci`) fails when a `patchedDependencies` key
names a version that isn't the one installed. Re-cut it with `bun patch @nuxthub/core` (unless
upstream sorts by then) and check `bun.lock` still has a `patchedDependencies` entry. A DB
already broken this way is easiest rebuilt: move `.data/db/sqlite.db` aside and start `bun dev`.

## Production D1 is migrated only by `deploy:ci`

Locally this is invisible: NuxtHub's dev plugin (`applyMigrationsDuringDev`) applies
`server/db/migrations/` to `.data/db/sqlite.db` on every dev boot. Production has no equivalent.

`wrangler deploy` does not apply D1 migrations, and NuxtHub's `applyMigrationsDuringBuild` step
runs against the **libsql driver's local file on the build machine** (`hub.db` resolves to
`sqlite`/`libsql` here, not the `d1` driver), so it never touches the remote database. The
`.sql` files are copied into `.output/server/db/migrations/` and the generated `wrangler.json`
points `migrations_dir` at them, but nothing runs them. A deploy that adds a table ships a
Worker querying a table that does not exist, and it shows up as a 500 on a route that worked in
dev.

Workers Builds closes the gap with its deploy command, `bun run deploy:ci`: it runs
`deploy:secrets` (holds the deploy while the Worker lacks a secret `fleet.json` › `secrets`
names), `db:migrate:remote`, then `wrangler --cwd .output deploy`, so the schema lands before the
code that needs it. Add a new required secret to `fleet.json` › `secrets` in the same commit that
starts reading it, and put it on the Worker before that commit merges, or the deploy is held.
Three consequences:

- The build token needs **D1 Edit**. The token Workers Builds generates has only Workers
  Scripts, KV, R2 and Routes permissions. Without D1 Edit the migrate step fails and the deploy
  never runs. The app keeps serving the previous build, and `deploy_drift` reports it.
- Migrations must be **expand-only**: add tables and nullable or defaulted columns. The
  previous build serves traffic between the migrate step and the deploy, and serves everything
  if the deploy fails. Drop or rename only in a later release, once no deployed code reads the
  old shape.
- Stay on one `migrations_table`. The script reads the root `wrangler.toml`, which sets none,
  so it tracks state in wrangler's default `d1_migrations`; the generated
  `.output/server/wrangler.json` names `_hub_migrations`. Alternating makes each think nothing
  has been applied.

A manual `bun run deploy` still skips migrations. Run this yourself after one:

```bash
bun run db:migrate:remote
```

`GET /api/status` (public) reports the gap: `migrations.pending` lists every migration in the
repo that the deployed database has not applied. The portfolio dashboard polls it, and it is
the quickest check by hand after a deploy:
`curl https://frontierterm.com/api/status | jq .migrations` (see [fleet.md](fleet.md)).

## An index existing does not mean D1 uses it

D1 keeps no planner statistics, so SQLite picks an index by rule of thumb, and an `ORDER BY`
can win over a more selective seek. The coverage query read 13k rows a call because two "newest
row of this source" subqueries seeked on the instant alone, where a tick starts every source at
once. Nothing fails: the rows are right, the bill and the latency are not.

- Read the plan and the cost on production, not locally (local `ANALYZE` data changes the
  choice): `bunx wrangler d1 execute frontier-terminal-db --remote --json --command
  "explain query plan …"`, then run the statement and read `meta.rows_read`.
- `bunx wrangler d1 insights frontier-terminal-db --sort-by=reads --time-period=1d` ranks what
  production runs by rows read.
- Name the index (`indexed by <name>`) where the choice matters. A partial index is used only by
  a query that repeats its `WHERE` (`READ_RUN_STATUSES`), an expression index only by the same
  expression with the same literal. `layers/core/test/query-plans.test.ts` holds those plans.
- drizzle-kit writes an expression index wrong (it quotes the expression as column names):
  correct that statement in the generated migration by hand.

## NuxtHub rewrites the generated wrangler config

`wrangler.toml` is an input, not the deployed config. `nuxt build` writes
`.output/server/wrangler.json` and wrangler deploys that. Nitro copies `wrangler.toml` into it
verbatim (bindings, `[triggers]` and `[[ratelimits]]` all survive), then `@nuxthub/core`
rewrites the file on Nuxt's `close` hook (`processWranglerConfigFile`), deleting any `env` key.
This repo has a single environment, so nothing is lost. If one is ever added, it is selected at
**build** time (`CLOUDFLARE_ENV=<name>`), not with `wrangler --env`, because the generated file
has no environments by the time wrangler reads it.

## A cron task needs the same string in two files

`nitro.scheduledTasks` (nuxt.config.ts) maps a cron expression to task names; `[triggers] crons`
(wrangler.toml) tells Cloudflare when to fire. The join is an **exact string match** on the
expression, so `"0 4 * * *"` and `"0 04 * * *"` are different keys: Cloudflare wakes the Worker,
`runCronTasks` finds nothing, and the handler returns success with no log line. If a task never
runs, compare those two strings first.

`bun run crons:check` (in `bun run ci`) compares them both ways, and fails when a scheduled task
name has no file under `server/tasks/`. Keep the map declared once as `SCHEDULED_TASKS` at the
top of `nuxt.config.ts`, handed to both `nitro.scheduledTasks` and `runtimeConfig.scheduledTasks`
(what `/api/status` reports).

A correctly wired task can still stop: the cron stops firing, the run is killed at the CPU
limit, or it throws every tick. So every task file ends in `export default withHeartbeat(task)`
(`layers/core/server/utils/task-heartbeat.ts`), which records each run in `task_heartbeats`, and
the freshness checks in `ops:watch` spool `task_silent` when a task has not completed in one
missed run plus half an interval (`layers/core/server/utils/freshness.ts`).
`layers/terminal/test/freshness.test.ts` fails the build on a task file without it. A task that
cannot carry the wrapper (one in a vendored layer) gets a check of its own in
`TASK_CHECK_OVERRIDES`, with the reason.

No custom Worker entry is needed for a background job: the `cloudflare_module` preset already
exports `scheduled()` (which calls `runCronTasks` when `nitro.experimental.tasks` is on) and
`queue()` (which dispatches the `cloudflare:queue` Nitro hook), plus `email`, `tail` and
`trace`. Hook them from `server/plugins/`. Don't hand-write an entry that re-exports `fetch`: it
rots the next time Nitro changes one of them.

Nitro **skips scheduled tasks under vitest** (`isTest` in its task runtime). Put the logic in a
`server/utils/` function that takes `db` (and any binding it needs) as an argument and test
that, as `server/utils/ops.ts` does. A test driving the task wrapper tests the shim.

Anything a sweep filters on needs an **index**. A `LIMIT` bounds rows deleted, not rows
examined, so an unindexed predicate full-scans the table every tick and slows as the table
grows. That is why `ops_events` is pruned by `created_at`, which every read of it filters on.

## The dev server caches its DB connection — external writes need a restart

A `bun:sqlite` write to `.data/db/sqlite.db` lands in the file, but a running dev server keeps
its own libsql connection and keeps returning the old rows. Write before starting the dev
server, or restart it (or touch `nuxt.config.ts`) after writing. Don't debug the query.

## With no `node` on the PATH, `nuxt dev` silently runs under Bun — and SSR breaks

The `nuxt` bin's shebang asks for Node. On a machine with only Bun, `bun run dev:app` and the
Playwright suites' web server run `nuxt dev` on Bun itself, with no warning. CI never does: the
browser-suites workflow runs `actions/setup-node` from `.node-version`.

Under Bun, every page that renders a component importing `zod` (the subscribe form, through
`layers/alerts/shared/utils/subscribe.ts`) returns 500:
`undefined is not an object (evaluating '__vite_ssr_import_N__.z.object')`. Vite externalizes
`zod`; Bun answers `true` to `'__esModule' in ns` for zod's ESM namespace, so vite-node swaps
the module for its default export, the `z` namespace, which lacks `z` itself. The error text is
JavaScriptCore's, not V8's: that is the tell that Node is not what is running.

Fix the environment, not the app: install the Node that `.node-version` names
(`mise use -g node@24`). `which node` should print a path before you trust a local browser run.
`vite.ssr.noExternal: ['zod']` makes the pages render under Bun, but it works around an
environment CI does not have. Don't commit it.

## An auto-import that typechecks can still be missing at runtime

Nuxt writes every auto-imported name to `.nuxt/types/nitro-imports.d.ts` (server) and
`.nuxt/imports.d.ts` (app), and the typecheck reads those lists. Injection is a separate step:
unimport scans each file it transforms for the names it uses and adds their imports. NuxtHub's
`db`, `kv` and `blob` go through the same `addServerImports` path as our own utils. A
`ReferenceError: x is not defined` with a green typecheck has one of three causes:

- **Stale `.nuxt`.** A util was added, renamed or moved since the last `nuxt prepare`, dev or
  build. Run `bunx nuxt prepare`. vitest and `globals:check` read the same lists
  (`scripts/lib/auto-imports.ts`), so they go stale with it.
- **The file runs outside Nitro and Vite.** bun scripts, drizzle-kit, NuxtHub's schema bundler,
  `nuxt.config` and the Playwright suites inject nothing. Those files, and every file they
  import, keep explicit imports.
- **unimport's scan missed the name.** It matches with regexes, and Nitro runs it on the
  TypeScript source, before esbuild. A name used only in a cast (`z.enum(LABS as [LabId])`),
  only after a division (`D1_MAX_BOUND_PARAMS / COLUMNS`, read as a regex literal) or only
  inside a template literal's `${}` is not seen, and a module-level destructuring of the same
  name (`const { kv } = …`) hides it for the whole file. vitest scans the JavaScript after
  esbuild, so a cast passes there and fails only in the build. Keep the import where a name is
  used like that.

When an auto-import sits on a path that fails open (such as `kv`/`db` in
`server/utils/rate-limit.ts`), check the running logs, not just the type checker.

## A `fatal` 404 pages the owner unless `server/error.ts` is in the chain

Nitro's default error handler `console.error`s every error marked `fatal`, 404s included, and
Nuxt's handler calls it without `silent`. Workers Issues files each of those lines as an issue
and the fleet dashboard mails it as Critical, so a crawler asking for a stale alert id pages
the owner. `server/error.ts` un-flags `fatal` on anything below 500, and the `nitro:config` hook
in `nuxt.config.ts` puts it ahead of Nuxt's handler. Don't move it to `nitro.errorHandler`:
setting that key stops Nuxt registering its own handler, and the error pages go with it. To
check it after an upgrade, serve a build (`npx wrangler --cwd .output dev`), request a missing
slug, and look for `[request error] [fatal]`.

## Custom `definePageMeta` keys need two opt-ins, and fail silently without them

`sitemap.xml` and `llms.txt` are built from `definePageMeta({ publicPage: … })`, collected by a
hook in `nuxt.config.ts`. Getting any of these wrong produces an **empty sitemap**, not an error:

1. **`experimental.extraPageMetaExtractionKeys: ['publicPage']`.** Nuxt's build-time
   `definePageMeta` scanner only extracts a fixed allowlist (`name`, `path`, `middleware`, …).
   Without this, a custom key is replaced with a `__nuxt_dynamic_meta_key` marker and the hook
   sees every page as unmarked.
2. **Collect in `pages:resolved`, not `pages:extend`.** Extraction happens between the two
   hooks. In `pages:extend`, `page.meta` is still `null` for every page.
3. **Write to the Nitro instance too.** Nitro is already initialised by `pages:resolved`, so
   `nuxt.options.runtimeConfig` alone is too late; `useNitro().options.runtimeConfig` is what
   ends up in the bundle. `nuxt.config.ts` sets both.

Values must be JSON-serializable literals. An interpolated string or a referenced constant
fails `isSerializable` and is dropped the same way.

## `nuxt typecheck` checks `server/` only when the root tsconfig is solution-style

Nuxt 4 generates four projects (`.nuxt/tsconfig.app.json`, `.server.json`, `.shared.json`,
`.node.json`). `nuxt typecheck`, and the checker inside `nuxt dev` and `nuxt build`, run
`vue-tsc -b` over all four only when the root `tsconfig.json` has `references`, `"files": []`
and no `include`. The legacy `"extends": "./.nuxt/tsconfig.json"` excludes `server/**`, so
nothing under `server/` or `layers/*/server/` is typechecked and the gate stays green.

- Keep the root `tsconfig.json` as it is. Compiler options go in `nuxt.config.ts` ›
  `typescript.tsConfig`; set in the root file they reach no project.
- A removed auto-import is `TS2304` in the gate. That does not cover a name that typechecks but
  is not injected (the gotcha above), and nothing typechecks `test/` or `scripts/`.

## NuxtUI v4 needs an explicit CSS entry

`app/assets/css/main.css` must contain `@import "tailwindcss"; @import "@nuxt/ui";` and be
listed under `css:` in `nuxt.config.ts`. Without it, NuxtUI's generated theme (`.nuxt/ui.css`)
isn't bundled, and pages render in browser default fonts and colors with no Tailwind utilities.
Don't remove either piece.

## Parallel agent worktrees are supported — keep them that way

Agents can work in isolated git worktrees under `.claude/worktrees/<name>` (gitignored), several
at once. Everything in `bun run ci` is scoped to the checkout it runs in, so a sibling worktree
full of half-finished or deleted code cannot contaminate your run. That is easy to break, and
the breakage is confusing, not loud.

How each gate stays scoped (match this when you add a gate):

| Gate | Why a sibling worktree can't reach it |
| --- | --- |
| `lint` | `.oxlintrc.json` › `ignorePatterns` lists `.claude/**` |
| `design:check` / `seo:check` / `brand:check` | Walk `ROOT/app`, each layer's `app/`, and fixed root-relative asset paths |
| `globals:check` | Walks `ROOT/server` and `ROOT/layers/*/server` |
| `test` | `vitest.config.ts` › `include` is `test/**`, `server/**` and `layers/*/test/**`, relative to the checkout |
| `typecheck` | The root `tsconfig.json` has no files of its own, and Nuxt's generated `.nuxt/tsconfig.*` use scoped includes (`../app/**/*`, `../server/**/*`), not a root glob |
| `test:a11y` | Per-checkout port (see below) |
| `build` | Nuxt only reads `app/`, `server/`, `shared/` and `layers/` |

Three rules, each one because something broke it:

1. **A gate takes its scan root from the checkout**: not a walk upward, not a bare `**/*` glob.
2. **A gate that binds a port derives it** via `scripts/worktree-port.ts`. Never hardcode one.
3. **A gate never writes to a tracked file.** `nuxt-mcp` rewrites `.mcp.json` with the live dev
   server URL on every boot. Two guards: the rewrite is off whenever `NUXT_DEVTOOLS=false`
   (`nuxt.config.ts` › `modules`), which is the automated case, and `.mcp.json` is untracked
   (`.mcp.json.example` is the shared copy), so the rewrite has nothing to dirty even when it
   runs.

## `bun dev` gets a per-worktree hostname

`bun dev` runs `scripts/dev.ts`, which hands portless an explicit hostname: the bare configured
name in the main checkout (`my-app.localhost`), and `<worktree-dir>.my-app.localhost` in a
linked worktree. It prints the host on startup.

portless's own worktree prefix comes from the **branch**, and a branch is not a unique key for a
worktree. Three ways that collides, all silent:

| Case | portless alone | Why it happens |
| --- | --- | --- |
| Worktree checked out on `main` | `my-app.localhost`, same as the main checkout | `main`/`master` are treated as default branches and skipped |
| Detached-HEAD worktree | `my-app.localhost` | Branch reads as `HEAD`, also skipped (Claude Code creates detached worktrees) |
| `feat/pricing` vs `claude/pricing` | both `pricing.my-app.localhost` | The prefix is only the branch's last path segment |

The worktree directory is unique (git won't create two worktrees at one path) and doesn't change
when you switch branches, so the URL stays stable.

`scripts/dev.ts` uses the positional `portless <name> <cmd>` form, which takes the name verbatim.
`portless run --name` would stack its branch prefix on top, and the hostname would move every
time the branch did. `bun dev:app` bypasses the proxy entirely.

**An agent session can't start the proxy.** When it isn't running, portless wants `sudo` to
bind 443, and a shell with no TTY can't answer the prompt, so `bun dev` exits with "Proxy is
not running and no TTY is available for sudo". Use `bunx nuxt dev --port <n>` with a port of
your own (`bun dev:app` assumes 3000, which another checkout may hold). For Playwright scripts
against `nuxt dev`, wait on `load` and a selector: with devtools on, the HMR websocket keeps
`networkidle` from ever firing.

## Workers Builds: dashboard Worker name must match `wrangler.toml`

CI/CD runs on Cloudflare Workers Builds (repo connected in the dashboard under Worker → Settings
→ Build). The Worker's name in the dashboard must match `name` in the root `wrangler.toml`, or
every build fails before it starts. Build settings live in the dashboard, not in the repo: build
command `bun run ci`, deploy command `bun run deploy:ci` (migrates production D1, then deploys;
needs D1 Edit on the build token, see above).

**A build that fails to start is not retried.** "Build failed to initialize and was timed out"
means the build environment never came up, and production stays on the previous commit.
`deploy_drift` (`layers/reliability/server/pipeline/deploy-watch.ts`) reports it once main has
been ahead of `/api/status` → `build.sha` for one tick. To retry without an empty commit, start a
build on the `main` trigger with the **full** sha. A short sha fails at clone with "error
occurred while fetching repository":

```bash
cf builds triggers list --external-script-id "$(cf workers scripts search --name frontier-terminal | jq -r '.[0].id')"
cf builds create <main-trigger-uuid> --body "{\"branch\":\"main\",\"commit_hash\":\"$(git rev-parse origin/main)\"}"
cf builds logs get <build-uuid>
```

## Production can break with CI green — three ways it has, and the guard for each

Dev, vitest, typecheck and the build pass each one.

| Failure | Cause | Guard |
| --- | --- | --- |
| A cron invocation runs out of memory | google-careers (~20 MB) joined the six-hourly survey; the tick died `exceededMemory` and lost every source it had not recorded | `layers/terminal/test/pipeline/payload-budget.test.ts`, in `bun run test` |
| A deploy is refused | `crypto.randomUUID()` called at module load, through a factory's default parameter; Cloudflare rejected the deploy (error 10021) and production stayed on the previous commit | `bun run globals:check`, in `bun run ci` |
| The deploy lands broken, or never lands | nothing on GitHub turns red for a refused deploy | `.github/workflows/post-deploy-smoke.yml` runs `bun run smoke` after every push to main |

**Payload budget.** The test sizes every source each cron invocation fetches (the poll lanes in
`scopes.ts`, the derived families at their production counts, and the survey's recipes) from
`fixtures/manifest.json` › `raw_bytes`, or `raw_bytes:` on a sources.yaml entry with no
fixture. It fails when a source over 16 MiB shares a lane, or a lane totals over 112 MiB; the
test's header gives the evidence for both numbers. The survey sits at ~109 MiB, so its next big
source needs a lane of its own: a scope, a task, and a cron string in both files. Sizes are as
recorded, so recapturing a grown fixture is what lets the gate see upstream growth.

**Module load.** Workers run each module's top level once, in global scope, and refuse random
values, timers and I/O there; the clock reads 1970 there instead. `globals:check` parses
`server/` and `layers/*/server/` and flags `crypto.randomUUID`, `crypto.getRandomValues`,
`Math.random`, `setTimeout`, `setInterval`, `fetch`, `Date.now` and an argument-less
`new Date()` outside a function. It follows module-scope calls into functions it can resolve
(same file, a relative or alias import, or one of our own Nitro auto-imports), up to three calls
deep, including omitted parameters' defaults. It does not follow method calls or re-exports.
Fix by making the value on first use; `// global-scope-ok: <why>` silences a line that is safe.
The gate checks itself on the refused-deploy pattern before every scan, because the TypeScript
parser it uses cannot load in vitest.

**Smoke.** The workflow polls `/api/status` for up to 20 minutes until `build.sha` is the pushed
commit (a deploy that never lands fails here), then requires `status: ok`, no pending
migrations, a cron map equal to `SCHEDULED_TASKS`, and a 200 from `/`, `/alerts`, `/revenue`,
`/exposure`, `/data`, `/api/overview` and `/api/coverage`. A failure is a red check on the main
commit and a GitHub email to whoever merged. It is not in `deploy:ci`: by then the deploy has
happened, and a refused deploy never reaches that step. Run it by hand with
`bun run smoke -- --wait 0`.

## The browser suites run in GitHub Actions, NOT in `bun run ci`

Workers Builds cannot run a browser, so don't move them back into `ci`. The build image ships no
Chromium system libraries (`error while loading shared libraries: libatk-1.0.so.0`), and the
documented fix, `playwright install --with-deps chromium`, needs root, which the image doesn't
give (`su: Authentication failure`). So `.github/workflows/browser-suites.yml` runs
`bun run ci:browser` on the merge queue's drafts, on the Mac mini's runner VM (GitHub's ubuntu
runners as the fallback), where `--with-deps` succeeds. Everything else stays in Workers Builds:
lint, the design/brand/mirror/seo gates, typecheck, the unit tests and the build. Those block a
**deploy**; the browser suites block a **merge**. The build command lives in the Cloudflare
dashboard, not the repo, so the fix is a workflow file, which a fork inherits.

**`test:a11y` is two Playwright projects**, `a11y` and `csp`, so the Content-Security-Policy
gate lives in the Action too. A broken CSP fails silently, which is what that gate exists to
catch. Deleting the workflow deletes the CSP gate, and nothing will tell you.

- **The suites run against the production build, not `nuxt dev`.** `playwright.config.ts` →
  `webServer` runs `test/server/start.ts`: `nuxt build`, the migrations into a fresh
  `.data-browser`, the fixture fill (`test/server/fill.ts`), then `wrangler dev` on `.output`.
  The dev server didn't fit: the merge-queue VM (3 CPUs, 5 GB) SIGKILLed it at `/prices`.
  Measured on the Mac mini, one worker as on CI:

  | | dev server | built Worker |
  | --- | --- | --- |
  | peak while testing (server + Chromium + runner) | 5.6 GB (2.7 + 1.8 + 1.4) | 4.1–4.4 GB (1.8 + 1.6 + 1.2) |
  | peak before the first test | 2.6 GB (boot and warm-up) | 3.2 GB (`nuxt build`, alone) |
  | `bun run test:a11y` wall time | 136s | 114s |

  Nothing compiles on a first visit, so there is no warm-up pass, and the CSP suite reads the
  headers that ship. `/prices` is the slowest test either way (~8s, most of it axe on 1.7 MB of
  HTML).
- **That build skips the server minify.** `BROWSER_SUITE_BUILD=1` sets `nitro.minify: false`
  (`nuxt.config.ts`). The worker preset minifies with terser, in-process: 4.8 GB peak with it,
  3.2 GB without, and the markup and headers the suites check don't change. V8 caps its heap at
  about a quarter of RAM, ~1.25 GB on the VM, and the build needs ~1.5 GB, so `start.ts` runs it
  with `--max-old-space-size=2048`. If the VM ever kills the build, look there first.
- **`reuseExistingServer: false` is on purpose.** A server already on the suite's port wasn't
  started from this build and this store. A stale one makes the run fail to boot instead of
  reporting on something else: kill it, don't flip the flag.
- **The port is derived from the checkout path** (`scripts/worktree-port.ts`, range 3100–3899).
  Every worktree gets its own, so parallel agents don't collide and a `bun run dev:app` on 3000
  doesn't either. It's deterministic, so you can open it by hand mid-run (`bun run test:a11y`
  prints it). Set `A11Y_PORT` to pin a value. Any future suite that binds a port must use this
  helper.
- **The fill runs beside the Worker, not in it.** `/_nitro/tasks` exists only under `nuxt dev`,
  so `fill.ts` runs `fillFromFixtures` in Bun through wrangler's `getPlatformProxy`, on the D1
  and R2 files `wrangler dev` then serves. `--persist-to` adds a `v3/` that `getPlatformProxy`
  doesn't, which is why the fill opens `<store>/v3`. It needs
  `--tsconfig-override=.nuxt/tsconfig.server.json` for the layer's `#server` imports. Without
  rows the sweep only judges empty states ([`local-data.md`](local-data.md)).
- **One worker on CI.** Two workers OOM'd the dev server. The build leaves room for two, but one
  fits the job, and the axe pass on `/prices` is the peak. If a SIGKILL line appears again,
  sample `free -m` and `ps` in the workflow step before guessing.
- **Traces are recorded on the CI retry only** (`trace: 'on-first-retry'`). Locally, rerun a
  failure with `--trace on`.

## Don't add `nuxt-mcp-toolkit` config under `mcp:` in `nuxt.config.ts`

If you ever pull in `@nuxtjs/mcp-toolkit` (not installed), its `ModuleOptions` augmentation doesn't surface as a top-level `mcp:` key in `defineNuxtConfig`, so TypeScript rejects it. Configure via `defineMcpHandler` in `server/mcp/index.ts` instead. <!-- refs-check-ignore: hypothetical, the module is not installed -->
