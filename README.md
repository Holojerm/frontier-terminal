# Frontier Terminal

A free, public, read-only investor terminal tracking the frontier AI labs — OpenAI, Anthropic,
Google, xAI — on six axes: API price lists, hiring boards (with the physical-infrastructure
buildout cluster), SEC filings, disclosed revenue, status-page incidents, and OpenRouter demand
share with the spend share it implies. Every number carries the URL it was read from and when.
Not investment advice.

Built on [nuxt-cf-template](https://github.com/Holojerm/nuxt-cf-template): **Nuxt 4 + NuxtUI v4**
on **Cloudflare Workers**, with D1 (SQLite via Drizzle), KV, and R2. No accounts, no sign-in,
no payments — the template's auth, billing, email, blog, uploads, feedback, admin and
analytics subsystems were removed; what remains is the app shell, the SEO layer, the CI gates,
and the ops/fleet contract.

## Run it

```bash
bun install
bun dev            # https://frontier-terminal.localhost via portless
bun run ci         # the merge gate — lint, format, every gate, typecheck, tests, build
```

`bun run ci` is what Workers Builds runs on every push. The browser suites (axe over every
public route in both color modes, and the Content-Security-Policy spec) run in GitHub Actions
instead, because the Workers Builds image cannot launch Chromium — `.github/workflows/browser-suites.yml`.

## Layout

| Path | What |
| --- | --- |
| `app/pages/` | The terminal: the overview, `prices/` (catalog and per-SKU history), `hiring.vue`, `revenue.vue`, `releases.vue`, `incidents.vue`, `rankings.vue`, `alerts/` (feed and permalinks), `data.vue` (bulk downloads), `about.vue`. Every page calls `useSeo()` once and declares `publicPage`. |
| `sources.yaml` | The source registry — one entry per candidate source with its axis, its diff mechanism, and an include/exclude verdict. Transcribed from `docs/source-audit.md`; it never re-derives. |
| `server/pipeline/` | Fetch → normalize → diff → store. `parsers/` is one parser per source, `contracts/` the zod row shapes the DB mirrors, `judge/` the one writer that promotes changes to alerts and re-maps price-matrix cells whose vendor sentence changed, `scopes.ts` which sources a given tick covers. |
| `server/api/` | The read-only JSON API: `overview`, `prices` (+ `prices/[key]`), `hiring` (+ `hiring/history`), `revenue`, `releases`, `incidents`, `rankings`, `spend`, `alerts` (+ `alerts/[id]`), `coverage`. Plus `health`, `status`, `fleet` — the ops contract — and `judge/`, bearer-gated, the only route that writes. |
| `server/routes/` | `robots.txt`, `sitemap.xml`, `llms.txt`, `manifest.webmanifest`, all derived from the route table; `alerts.xml`, the Atom feed; `server/routes/export/[table].csv.get.ts` and its JSON twin, the bulk downloads; `mcp.ts`, the MCP endpoint. |
| `server/db/schema.ts` | `snapshots` (one row per fetch, the provenance spine), `entities` (current state per source), `changes` and `alerts` (both append-only), `source_runs`, `judge_runs`, `class_map_decisions` (the judge's price-matrix re-mappings) — beside the template's `instance_secrets` and `ops_events`. |
| `server/tasks/` | `server/tasks/poll/edgar.ts` every 30 minutes over the SEC feeds and the model catalogs (so a launch shows within half an hour), the two axes worth low latency; `server/tasks/poll/survey.ts` every 6 hours over every included source; `server/tasks/ops/alert.ts` every 30 minutes, draining the `ops_events` spool into one digest email. |
| `fixtures/` | A captured copy of every source, with fetch timestamps and trim notes in `fixtures/manifest.json`, so the parsers are tested against the real bytes without the network. |
| `scripts/check-*.ts` | The gates in `bun run ci`: design tokens, brand assets, references, SEO, fleet manifest, cron parity. |
| `docs/` | `source-audit.md` — every candidate source, fetched and judged, with why the excluded ones were excluded. |

## Deploy

Pushing to `main` builds and deploys through Workers Builds. **Migrations are not applied for
you**: after any schema change, run `bun run db:migrate:remote`. `GET /api/status` reports
`migrations.pending` so the gap is visible from outside.

Bindings live in `wrangler.toml` (one environment, no preview). `fleet.json` must match it —
`bun run fleet:check` fails the build otherwise.

## Take the data

Every table is a bulk download, CSV or JSON, no key — the whole table, streamed, at 30
requests a minute per IP:

```
https://frontierterm.com/export/prices_latest.csv
https://frontierterm.com/export/changes.json
```

`snapshots`, `prices_latest`, `jobs_open`, `incidents`, `rankings_daily`, `revenue_facts`,
`changes`, `alerts`, `source_runs` — each row carrying `source_url` and `fetched_at`. The
`/data` page lists them with their columns and current row counts. Alerts are also an Atom
feed at `/alerts.xml`.

## Connect an agent

The terminal is an MCP server as well as a site: the same read-only queries, over Streamable
HTTP, no auth, at

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
`get_alerts`, `get_alert`, `get_coverage`, `get_status`. Every result is the matching `/api/*` payload,
provenance included, served through the same cache and the same per-IP rate limit (60 requests
a minute). The server is stateless — each call is one POST with a JSON reply — so there is
nothing to keep a session for. Tools and their descriptions live in `server/utils/mcp.ts`.

## For agents

Read [`CLAUDE.md`](./CLAUDE.md) first. It is the index into `.claude/docs/`, which is read on
demand rather than all at once.
