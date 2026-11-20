# Surfaces: where a dataset has to show up

**Load this when:** adding a dataset, route, table or page.

A dataset that reaches only its own page is half shipped. In November several did: the home
page, tear sheet, MCP tools, bulk exports and alerts still described the original seven axes.
`bun run surfaces:check` (in `bun run ci` and `ci:fast`) makes every gap either closed or
written down.

## What a dataset reaches

| Surface | Where | How the gate sees it |
| --- | --- | --- |
| A page | its axis page under `layers/terminal/app/pages/` | a page or component fetches the route |
| The lab page | `layers/terminal/app/pages/labs/[lab]/index.vue` | the page, or a component it renders, fetches the route |
| The tear sheet | `layers/terminal/app/pages/labs/[lab]/tear-sheet.vue` | same, for the sheet |
| An MCP tool | `layers/terminal/server/mcp/<domain>.ts` | `serve('<name>'` or `read('<name>'` with the route's cache name |
| The bulk export | `EXPORT_TABLES`, composed from `layers/terminal/server/export-tables/<domain>.ts` | an export builder reads the table |
| An alert axis | `AXIS_PATH` in `layers/terminal/shared/utils/terminal-labs.ts` | the route sits under an axis page (`/api/hiring/history` is under `/hiring`), or the axis's `AXIS_ROUTES` entry names it (`/api/gpu-prices` on `compute`) |
| The overview | `app/pages/index.vue` | not gated: only headline datasets belong there |
| `llms.txt` and the sitemap | `definePageMeta({ publicPage })` | `bun run seo:check` |

The lab page and tear sheet are asked for only when a route is per lab. A route is per lab
when it takes `?lab=` (`lab: z.…` in its query schema, or `lab` destructured from
`getValidatedQuery`), or when the lab page or tear sheet already reads it. A lab-specific read
uses the route's `?lab=` on the server. It never filters an all-lab payload in the page.

Routes checked: every GET under `layers/terminal/server/api/` except the writers in `judge/`,
`gdelt/` and `subscribe/`. Tables checked: every `sqliteTable` in `layers/terminal/server/db/tables/`.
Template routes and tables (`server/`) are not product data.

## Reading the matrix

```bash
bun run surfaces:check --matrix
```

prints one line per route (page, lab page, tear sheet, MCP, alert axis, cache name) and one per
table (the exports that read it). `✓` is reached, `✗` is a gap, `·` is not asked (a route that
isn't per lab). Every `✗` has a waiver.

The parsing rules live in `scripts/lib/surfaces.ts`, tested in `test/surfaces.test.ts`. If the
gate reads zero routes, tables or exports it fails instead of passing, because that means a
parser stopped matching the code.

## Waivers

`surfaces.waivers.ts` at the repo root lists each gap by kind (`page`, `labPage`, `tearSheet`,
`mcp`, `alerts`, `export`) and subject (the route URL as the file names it, such as
`/api/prices/[key]`, or the table's SQL name), with a one-line reason. The reason starts with
one of:

- `internal:` never public. Credentials, cursors, run logs, a page's own payload.
- `derived:` the rows reach this surface through another route or table. Name it.
- `covered:` reached in a way the gate can't see. Say which.
- `not yet:` a gap someone should close.

The gate fails on a gap with no waiver, on a waiver whose gap is gone (stale), and on an
empty or multi-line reason. So the PR that closes a gap deletes its waiver in the same diff,
and a `not yet:` waiver never outlives its fix.

Add a waiver only after deciding the surface is wrong for this dataset or can't be built in
this PR. "Didn't get to it" is a `not yet:`, written down where the next agent will see it.

## Adding a dataset

`/new-feature` (`.claude/commands/new-feature.md`) walks the whole path: source, parser and
fixture, table and migration, query and route, pages, MCP tool, export, alert axis, then this
gate.
