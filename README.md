# Frontier Terminal

A free, public, read-only terminal of fundamentals on the frontier AI labs (OpenAI, Anthropic,
Google, xAI, Meta, Mistral, DeepSeek, Alibaba's Qwen, and Moonshot AI's Kimi).

For each lab it tracks API price lists, hiring (including data center and infrastructure roles),
SEC filings and disclosed revenue, OpenRouter demand share with the spend share it implies,
status-page incidents and latency probes, and misalignment disclosures. Around the labs it tracks
the public companies tied to them: hyperscaler capex and backlog, the dependency graph of who
sells to and funds whom, chip and power suppliers, their hiring, GPU rental prices, Taiwan's
monthly server and chip revenue, Korea's chip exports, and grid load where the lab sites are.
Ground truth scores press reports of lab revenue and deals, and what the listed companies guided
on their earnings calls, against the filings that came later. Signals tests every series against
the stocks it should lead, out of sample, with dated forward calls. Theses sit on top of the
data, as short arguments with the numbers that would break them.

Every number links to the page we read it from and shows when we read it. Not investment advice.

Built on [nuxt-cf-template](https://github.com/Holojerm/nuxt-cf-template): Nuxt 4 and NuxtUI v4
on Cloudflare Workers, with D1 (SQLite via Drizzle), KV, and R2. There are no accounts, sign-in,
or payments. The one thing it stores about a person is the email address of someone who
subscribes to the weekly thesis digest (double opt-in, sent through Resend, off until a key is
set). We removed the template's auth, billing, blog, uploads, feedback, admin, and analytics
code. What's left is the app shell, the SEO layer, the CI gates, and the ops/fleet
contract.

## Run it

```bash
bun install
bun dev            # https://frontier-terminal.localhost via portless
bun run ci         # the merge gate: format (writes), lint, every gate, typecheck, tests, build
bun run ci:fast    # while iterating: cheap gates + typecheck + tests touched since origin/main
```

Workers Builds runs `bun run ci` on every pull-request branch (production builds run typecheck + build only). The browser suites (axe over every public route
in both color modes, and the Content-Security-Policy spec) run in GitHub Actions instead
(`.github/workflows/browser-suites.yml`), because the Workers Builds image can't launch Chromium.

## Layout

| Path | What |
| --- | --- |
| `layers/` | The product, as fork-owned Nuxt layers, each with its own `app/`, `server/`, `shared/` and `test/`: `core` (the ingest engine and store, the query plumbing, the export and MCP frameworks, the judge runner), one layer per domain (`pricing`, `talent`, `reliability`, `adoption`, `models`, `companies`, `compute`, `press`), the supporting `alerts`, `theses` and `signals`, and `terminal`, the shell, for what reads several domains at once. `domains.config.ts` says which layer may import which (`bun run domains:check`). `social` is vendored from the template. |
| `server/registries/` | The composition root: each registry (lanes, scopes, MCP tools, export tables, recipes, judge reviews, crawler pages) lists every layer's entries in order, and core reads it through `#server/registries/…`. The app's other `app/`, `server/` and `shared/` files hold the template's code. |
| `sources.yaml` | The source registry. One entry per candidate source with its axis, its diff mechanism, and an include or exclude verdict. Transcribed from `docs/source-audit.md`, never re-derived. |
| `layers/*/app/pages/` | The pages, each in the layer that owns its data: `prices/` in pricing, `releases.vue` and `disclosures.vue` in models, `rankings.vue` in adoption, `exposure.vue` and `filings/` in companies, `compute.vue`, `power.vue` and `hardware.vue` in compute, `ground-truth.vue` in press, `alerts/` in alerts, `theses/` and `signals.vue` in theirs. The shell holds `labs/` (one page and tear sheet per lab), `compare/`, `revenue.vue`, `dependencies.vue`, `hiring.vue`, `incidents.vue`, `data.vue`, `about.vue`, `license.vue` and `contact.vue`. The overview, `app/pages/index.vue`, stays in the app. Every page calls `useSeo()` once and declares `publicPage`. |
| `layers/core/server/pipeline/` | Fetch → normalize → diff → store, `scopes.ts` (which sources a given run covers) and `judge/`, the one writer that promotes changes to alerts. Each domain's parsers, lanes and judge review are in its own `server/pipeline/`. |
| `layers/*/server/api/` | The read-only JSON API, each route in the layer that owns its data. Plus `health`, `status` and `fleet` (the ops contract) in the app, and core's `judge/`, bearer-gated, the only route that writes. |
| `server/routes/` and `layers/*/server/routes/` | `robots.txt`, `sitemap.xml`, `llms.txt`, `manifest.webmanifest`, all derived from the route table. The alerts layer's `alerts.xml`, the Atom feed. `layers/core/server/routes/export/[file].get.ts`, the table downloads (CSV and JSON), and `layers/core/server/routes/mcp.ts`, the MCP endpoint. |
| `layers/*/server/db/schema.ts` | Each layer's tables, all re-exported by `server/db/schema.ts`. Core's are the store: `snapshots` (one row per fetch, the provenance spine), `entities` (current state per source), `changes` and `alerts` (both append-only), `source_runs`, `judge_runs`, `recipe_observations`, `recipe_runs` and `archive_captures`. Each domain holds its own, beside the template's `instance_secrets` and `ops_events`. |
| `layers/*/server/tasks/` | `layers/companies/server/tasks/poll/edgar.ts` runs every 30 minutes over the SEC feeds and the model catalogs, so a launch shows within half an hour. `layers/terminal/server/tasks/poll/survey.ts` runs every 6 hours over every included source. `layers/terminal/server/tasks/ops/watch.ts` runs every 30 minutes: the freshness checks, then the prune of the `ops_events` spool the fleet dashboard alerts from. |
| `fixtures/` | A captured copy of every source, with fetch timestamps and trim notes in `fixtures/manifest.json`, so the parsers are tested against the real bytes without the network. |
| `scripts/check-*.ts` | The gates in `bun run ci`: design tokens, brand assets, references, SEO, fleet manifest, cron parity. |
| `layers/theses/server/theses/` | The thesis layer: each thesis's claims and kill conditions (`anthropic.ts`), the Cloudflare changelog recipe (`layers/theses/server/recipes/`), the measured signals that read the store, the judged claims' candidates and verdict gate, the pure status rules, the evaluator the survey cron runs after each run, and the weekly digest (`theses:digest`, Mondays 13:00 UTC). |
| `docs/` | `source-audit.md` lists every candidate source, fetched and judged, with the reason for each exclusion. `thesis-engine.md` is the plan for the thesis layer, the arguments that sit on top of the terminal's data. |

## Deploy

Pushing to `main` builds and deploys through Workers Builds. Its deploy command,
`bun run deploy:ci`, applies pending D1 migrations first, so a migration that fails stops the
deploy; it then runs `deploy:smoke`, which fails the build if `/` or `/api/health` is not serving. A manual `bun run deploy` skips them, so run `bun run db:migrate:remote` after one.
`GET /api/status` reports `migrations.pending`, so you can see the gap from outside.

Bindings live in `wrangler.toml` (one environment, no preview). `fleet.json` must match it, or
`bun run fleet:check` fails the build.

## Take the data

Every table is a bulk download in CSV or JSON, with no key, streamed, at up to 30 requests a
minute per IP. A table that grows over time (changes, alerts, snapshots, filed facts, and the
like) gives you its last 90 days. Add `?history=full` for every row. Tables of current rows and
lookups (`prices_latest`, `jobs_open`, `filers`, `entity_securities`) download whole.

```
https://frontierterm.com/export/prices_latest.csv
https://frontierterm.com/export/changes.json
https://frontierterm.com/export/changes.csv?history=full
```

The data license depends on age. Our compilation and the numbers we derive from the last 90 days
are CC BY 4.0. Older ones are CC BY-NC 4.0, free for non-commercial use. Anything we published before 2026-11-04 stays CC BY 4.0. A full-history
download labels each row in a `license` column. Upstream data keeps its own license, and the
underlying facts belong to their publishers. The code is MIT. Details are on `/license`.

The `/data` page lists every table with its columns and current row counts. Every row carries
`source_url` and `fetched_at`. `entity_securities` maps each lab and tracked filer to its issuer,
CIK, and symbol. `/export/sample/<table>.csv` is the first 50 rows of any of them.
OpenRouter's per-model rankings are shown as per-lab shares but aren't offered as a download (see
`docs/source-audit.md`). Alerts are also an Atom feed at `/alerts.xml`.

## Connect an agent

The terminal is an MCP server as well as a site. It serves the same read-only queries over
Streamable HTTP, with no auth, at

```
https://frontierterm.com/mcp
```

```bash
claude mcp add --transport http frontier-terminal https://frontierterm.com/mcp
```

For any other client that takes a JSON server definition:

```json
{
  "mcpServers": {
    "frontier-terminal": {
      "type": "http",
      "url": "https://frontierterm.com/mcp"
    }
  }
}
```

Start with `describe` (the site map) or `get_overview` (what moved). A client lists the rest when
it connects: there is a tool for each dataset on the site. Every result is the matching `/api/*`
response, provenance included, served through the same cache and the same per-IP rate limit (60
requests a minute). The server is stateless. Each call is one POST with a JSON reply, so there's
no session to keep. The server is `layers/core/server/utils/mcp.ts`; the tools and their
descriptions are in `layers/terminal/server/mcp/`, listed in `server/registries/mcp-tools.ts`.

## For agents

Read [`AGENTS.md`](./AGENTS.md) first. It's the index into `.claude/docs/`, which you read on
demand instead of all at once.
