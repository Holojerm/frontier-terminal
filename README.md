# Frontier Terminal

A free, public, read-only investor terminal for the frontier AI labs (OpenAI, Anthropic, Google,
xAI, Meta, and Mistral). It tracks API price lists, hiring (including data center and
infrastructure roles), SEC filings, disclosed revenue, status-page incidents, misalignment
disclosures, and OpenRouter demand share with the spend share it implies. Every number links to
the page we read it from and shows when we read it. Not investment advice.

Built on [nuxt-cf-template](https://github.com/Holojerm/nuxt-cf-template): Nuxt 4 and NuxtUI v4
on Cloudflare Workers, with D1 (SQLite via Drizzle), KV, and R2. There are no accounts, sign-in,
or payments. We removed the template's auth, billing, email, blog, uploads, feedback, admin, and
analytics code. What's left is the app shell, the SEO layer, the CI gates, and the ops/fleet
contract.

## Run it

```bash
bun install
bun dev            # https://frontier-terminal.localhost via portless
bun run ci         # the merge gate: format (writes), lint, every gate, typecheck, tests, build
bun run ci:fast    # while iterating: cheap gates + typecheck + tests touched since origin/main
```

Workers Builds runs `bun run ci` on every push. The browser suites (axe over every public route
in both color modes, and the Content-Security-Policy spec) run in GitHub Actions instead
(`.github/workflows/browser-suites.yml`), because the Workers Builds image can't launch Chromium.

## Layout

| Path | What |
| --- | --- |
| `layers/terminal/` | Everything the product is, as one fork-owned Nuxt layer (`app/`, `server/`, `shared/`, `test/`, and its tables in `server/db/schema.ts`). The app's own `app/`, `server/` and `shared/` hold the template's code and the few files the layer does not own. |
| `layers/terminal/app/pages/` | The terminal pages: `prices/` (catalog and per-SKU history), `hiring.vue`, `revenue.vue`, `releases.vue`, `incidents.vue`, `rankings.vue`, `alerts/` (feed and permalinks), `data.vue` (bulk downloads), `about.vue`. The overview, `app/pages/index.vue`, stays in the app. Every page calls `useSeo()` once and declares `publicPage`. |
| `sources.yaml` | The source registry. One entry per candidate source with its axis, its diff mechanism, and an include or exclude verdict. Transcribed from `docs/source-audit.md`, never re-derived. |
| `layers/terminal/server/pipeline/` | Fetch → normalize → diff → store. `parsers/` is one parser per source, `contracts/` the zod row shapes the DB mirrors, `judge/` the one writer that promotes changes to alerts and re-maps price-matrix cells whose vendor sentence changed, `scopes.ts` which sources a given run covers. |
| `layers/terminal/server/api/` | The read-only JSON API: `overview`, `prices` (+ `prices/[key]`), `hiring` (+ `hiring/history`), `revenue`, `releases`, `incidents`, `rankings`, `spend`, `alerts` (+ `alerts/[id]`), `coverage`, `theses`. Plus `health`, `status`, and `fleet` (the ops contract), and `judge/`, bearer-gated, the only route that writes. |
| `server/routes/` and `layers/terminal/server/routes/` | `robots.txt`, `sitemap.xml`, `llms.txt`, `manifest.webmanifest`, all derived from the route table. `alerts.xml`, the Atom feed. `layers/terminal/server/routes/export/[table].csv.get.ts` and its JSON twin, the bulk downloads. `mcp.ts`, the MCP endpoint. |
| `layers/terminal/server/db/schema.ts` | (re-exported by `server/db/schema.ts`) `snapshots` (one row per fetch, the provenance spine), `entities` (current state per source), `changes` and `alerts` (both append-only), `source_runs`, `judge_runs`, `class_map_decisions` (the judge's price-matrix re-mappings), `claim_readings`, `claim_verdicts`, `claim_status_changes`, `recipe_observations` and `recipe_runs` (the thesis layer), beside the template's `instance_secrets` and `ops_events`. |
| `layers/terminal/server/tasks/` | `layers/terminal/server/tasks/poll/edgar.ts` runs every 30 minutes over the SEC feeds and the model catalogs, so a launch shows within half an hour. `layers/terminal/server/tasks/poll/survey.ts` runs every 6 hours over every included source. `server/tasks/ops/alert.ts` runs every 30 minutes and drains the `ops_events` spool into one digest email. |
| `fixtures/` | A captured copy of every source, with fetch timestamps and trim notes in `fixtures/manifest.json`, so the parsers are tested against the real bytes without the network. |
| `scripts/check-*.ts` | The gates in `bun run ci`: design tokens, brand assets, references, SEO, fleet manifest, cron parity. |
| `layers/terminal/server/theses/` | The thesis layer: each thesis's claims and kill conditions (`anthropic.ts`), the recipes that read non-lab companies' public sources (`recipes/`), the measured signals that read the store, the judged claims' candidates and verdict gate, the pure status rules, the evaluator the survey cron runs after each run, and the weekly digest (`theses:digest`, Mondays 13:00 UTC). |
| `docs/` | `source-audit.md` lists every candidate source, fetched and judged, with the reason for each exclusion. `thesis-engine.md` is the plan to grow the terminal into a thesis engine, with the lab thesis as the first one. |

## Deploy

Pushing to `main` builds and deploys through Workers Builds. Its deploy command,
`bun run deploy:ci`, applies pending D1 migrations first, so a migration that fails stops the
deploy. A manual `bun run deploy` skips them, so run `bun run db:migrate:remote` after one.
`GET /api/status` reports `migrations.pending`, so you can see the gap from outside.

Bindings live in `wrangler.toml` (one environment, no preview). `fleet.json` must match it, or
`bun run fleet:check` fails the build.

## Take the data

Every table is a bulk download in CSV or JSON, with no key. You get the whole table, streamed, at
up to 30 requests a minute per IP.

```
https://frontierterm.com/export/prices_latest.csv
https://frontierterm.com/export/changes.json
```

The tables are `snapshots`, `prices_latest`, `jobs_open`, `incidents`, `revenue_facts`,
`changes`, `alerts`, `claim_readings`, `claim_verdicts`, `recipe_observations`, and `source_runs`
(every row carries `source_url` and `fetched_at`), plus `entity_securities`, which maps each lab
and tracked filer to its issuer, CIK, and symbol. The `/data` page lists them with their columns
and current row counts. `/export/sample/<table>.csv` is the first 50 rows of any of them.
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

Tools: `describe` (the site map), `get_overview`, `get_prices`, `get_price_history`, `get_revenue`,
`get_hiring`, `get_hiring_history`, `get_releases`, `get_incidents`, `get_rankings`, `get_spend`,
`get_alerts`, `get_alert`, `get_coverage`, `get_status`. Every result is the matching `/api/*`
response, provenance included, served through the same cache and the same per-IP rate limit (60
requests a minute). The server is stateless. Each call is one POST with a JSON reply, so there's
no session to keep. Tools and their descriptions live in `layers/terminal/server/utils/mcp.ts`.

## For agents

Read [`AGENTS.md`](./AGENTS.md) first. It's the index into `.claude/docs/`, which you read on
demand instead of all at once.
