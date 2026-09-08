# Frontier Terminal

A free, public, read-only investor terminal tracking the frontier AI labs — API pricing,
hiring, SEC filings. Every number carries the URL it was read from and when. Not investment
advice.

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
| `app/pages/` | One page today, the landing placeholder. Every page calls `useSeo()` once and declares `publicPage`. |
| `server/api/` | `health`, `status`, `fleet` — the ops contract. Data endpoints arrive with the pipeline. |
| `server/routes/` | `robots.txt`, `sitemap.xml`, `llms.txt`, `manifest.webmanifest`, all derived from the route table; `mcp.ts`, the MCP endpoint. |
| `server/db/schema.ts` | `instance_secrets` and `ops_events`. The pipeline adds its tables beside them. |
| `server/tasks/ops/alert.ts` | Every 30 minutes, drains the `ops_events` spool into one digest email. |
| `scripts/check-*.ts` | The gates in `bun run ci`: design tokens, brand assets, references, SEO, fleet manifest, cron parity. |

## Deploy

Pushing to `main` builds and deploys through Workers Builds. **Migrations are not applied for
you**: after any schema change, run `bun run db:migrate:remote`. `GET /api/status` reports
`migrations.pending` so the gap is visible from outside.

Bindings live in `wrangler.toml` (one environment, no preview). `fleet.json` must match it —
`bun run fleet:check` fails the build otherwise.

## Connect an agent

The terminal is an MCP server as well as a site: the same read-only queries, over Streamable
HTTP, no auth, at

```
https://frontier-terminal.jeremy-ettlinger.workers.dev/mcp
```

```bash
claude mcp add --transport http frontier-terminal https://frontier-terminal.jeremy-ettlinger.workers.dev/mcp
```

For any other client that takes a JSON server definition:

```json
{
  "mcpServers": {
    "frontier-terminal": {
      "type": "http",
      "url": "https://frontier-terminal.jeremy-ettlinger.workers.dev/mcp"
    }
  }
}
```

Tools: `describe` (the site map), `get_overview`, `get_prices`, `get_price_history`, `get_hiring`,
`get_hiring_history`, `get_releases`, `get_incidents`, `get_rankings`, `get_alerts`, `get_alert`,
`get_coverage`, `get_status`. Every result is the matching `/api/*` payload,
provenance included, served through the same cache and the same per-IP rate limit (60 requests
a minute). The server is stateless — each call is one POST with a JSON reply — so there is
nothing to keep a session for. Tools and their descriptions live in `server/utils/mcp.ts`.

## For agents

Read [`CLAUDE.md`](./CLAUDE.md) first. It is the index into `.claude/docs/`, which is read on
demand rather than all at once.
