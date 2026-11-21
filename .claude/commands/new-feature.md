# New dataset

Add a dataset to the terminal end to end: source, parser, table, route, pages, MCP tool, export
and alerts. This is a read-only pipeline product. Rows come from a scheduled fetch of a public
source, never from a request, and every row carries its `source_url` and `fetched_at`.

## Usage
`/new-feature [dataset]`

Example: `/new-feature gpu-spot-prices`

## Before writing code

Settle these first, and ask if the answer isn't clear:

1. **The source.** The URL, what we take from it, how often, its terms and `robots.txt`, and
   what our license covers (`rights`: `ours`, `upstream`, `restricted` or `not-cleared`). A
   source we can't fetch again isn't stored.
2. **Per lab or not.** Does each row belong to one lab? Then it reaches the lab page and tear
   sheet, and the route takes `?lab=`.
3. **Headline or not.** Would a visitor to the home page miss it? Then it also gets a figure on
   `app/pages/index.vue`.
4. **Does a change matter?** Decide whether a move in this data should raise an alert, and how
   it would be judged (a deterministic rule or the judge routine). See
   `layers/core/shared/utils/terminal-tiers.ts`.

Product code goes in its domain's layer, `layers/<domain>/` (`layers/terminal/` only for what reads several domains), mirroring the app's folders; a list of every domain gets its line in `server/registries/`. Read
[`.claude/docs/patterns.md`](../docs/patterns.md) for the route, query and component shapes,
and [`.claude/docs/voice.md`](../docs/voice.md) before any copy.

## Steps

### 1. Source

Add the source to `sources.yaml` with its `axis`, `provider`, `url`, `diff_mechanism`,
`verdict`, `terms` and `rights`. A thesis recipe (`server/registries/recipes.ts`,
stored in `recipe_observations`) goes under `recipe_sources:` instead, and the other blocks
(`filed_fact_sources:`, `identifier_sources:` and so on) take their own kinds. Note the audit
in `docs/source-audit.md`.

### 2. Parser and fixture

Write the parser under `layers/<domain>/server/pipeline/parsers/<axis>/`, pure from bytes to
rows. Capture the real response into `fixtures/` and record its fetch time in
`fixtures/manifest.json`, so the parser is tested offline against the bytes the source sent.
Register it in its layer's `server/pipeline/parsers.manifest.ts` (listed in `server/registries/parsers.ts`). A parser that fails
throws and the run is recorded as failed. It never writes a partial or guessed row.

### 3. Table and migration

Most datasets are entity rows (`entities`, diffed into `changes`), and need no table of their
own. A new table goes in its domain's file under `layers/<domain>/server/db/tables/` with the provenance columns
(`source_url`, `fetched_at`) and an index on whatever a read filters or sorts on. Then run
`/db-migrate`. Migrations are expand-only, and production applies them only through
`bun run deploy:ci` (`.claude/docs/gotchas.md`).

### 4. Query and route

Put the query in `layers/<domain>/server/utils/terminal-<dataset>.ts` as a function taking the
db first, so it's tested in workerd. Add `layers/<domain>/server/api/<dataset>.get.ts`:
`rateLimitTerminal()`, a Zod query schema, and `serveTerminal(event, '<dataset>', …)` so it is
cached for the poll tick under one cache name. The MCP tool reuses that name. A per-lab
route takes `?lab=` and cuts the payload on the server.

### 5. Pages

- The axis page that reads it in full, with `definePageMeta({ publicPage })` and one
  `useSeo()` call (`.claude/docs/seo.md`).
- Per lab: the lab page (`labs/[lab]/index.vue`) and the tear sheet
  (`labs/[lab]/tear-sheet.vue` and `layers/terminal/app/utils/tear-sheet.ts`), each fetching
  with `query: { lab }`.
- Headline: one figure on `app/pages/index.vue`, linking to the axis page.

Every number shows or links to its source URL and fetch time.

### 6. MCP tool

Register a tool in its domain's file under `layers/<domain>/server/mcp/` that calls
`deps.serve('<dataset>', …)` with the route's cache name. Give it literal `title`,
`description` and `annotations: READ_ONLY`. A new domain file gets its line in `MCP_TOOLS`
(`server/registries/mcp-tools.ts`). Update the `tools/list` test in
`layers/terminal/test/mcp.test.ts` and `MCP_INSTRUCTIONS` in the same registry file.

### 7. Export

Add the table to its domain's record under `layers/<domain>/server/export-tables/` (a new
record file gets its line in `server/registries/export-tables.ts`) with a
builder from `layers/core/server/utils/terminal-export-views.ts` (`plainTable`,
`entityView`, `staticTable` for a hand-read table that ships with the build). Each column
needs a dictionary entry. Classify it in `EXPORT_HISTORY`, add a release in
`layers/core/server/utils/data-schema.ts`, and run `bun run schema:lock`.

### 8. Alerts

Either the dataset sits on an alert axis (`AXIS_DISPLAY`, `AXIS_PATH` and `ENTITY_AXIS` in
`layers/alerts/shared/utils/terminal-labs.ts`) with a rule or judge step that raises it, or
it gets an `alerts` waiver saying why not.

### 9. The surfaces gate

```bash
bun run surfaces:check --matrix
```

Every `✗` in your dataset's row is either fixed or waived in `surfaces.waivers.ts` with a
one-line reason (`.claude/docs/surfaces.md`). Then `bun run ci:fast` while iterating, and
`bun run ci` once before pushing.

## Checklist to print at the end

- [ ] `sources.yaml` entry with `terms` and `rights`
- [ ] Parser with a captured fixture and its fetch time
- [ ] Table and migration, or entity rows
- [ ] Query function, route with Zod, `rateLimitTerminal()` and `serveTerminal()`
- [ ] Axis page, plus lab page and tear sheet if per lab, plus home figure if headline
- [ ] MCP tool on the same cache name, `tools/list` test and `MCP_INSTRUCTIONS` updated
- [ ] Export table, dictionary, `EXPORT_HISTORY`, `schema:lock`
- [ ] Alert axis, or an `alerts` waiver
- [ ] `bun run surfaces:check` passes with no new `not yet:` waiver you could have closed
