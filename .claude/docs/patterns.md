# Code patterns: Vue, API routes, database

Worked examples: a `<script setup>` component, a validated API route, Drizzle queries, error handling, and performance defaults. Copy these shapes instead of inventing new ones.

> **Load this when:** writing a new component, API route, or database query, especially on your first change in this repo.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Vue / Nuxt Patterns

```vue
<!-- ALWAYS use <script setup lang="ts"> -->
<script setup lang="ts">
// Props — define with TypeScript interface
interface Props {
  userId: string
  isActive?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isActive: false,
})

// Emits — define with TypeScript
const emit = defineEmits<{
  update: [value: string]
  close: []
}>()

// Data fetching — useFetch for pages, $fetch for mutations
const { data: user, status } = await useFetch(`/api/users/${props.userId}`)

// Computed
const displayName = computed(() => user.value?.name ?? 'Unknown')
</script>

<template>
  <!-- PascalCase for components -->
  <UserCard :user="user" @update="emit('update', $event)" />
</template>
```

## API Routes

```typescript
// layers/<name>/server/api/providers/[slug].get.ts
// File naming: [method].ts suffix = HTTP method (get, post, put, delete, patch)
//
// Every route is public and read-only; there is no session to check.
// A route that takes input validates it with Zod and rate-limits itself.

import { z } from 'zod' // zod is not auto-imported

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'providers', limit: 60, windowSeconds: 60 })

  // 1. Route params
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, message: 'Missing slug' })

  // 2. Validated query
  const query = await getValidatedQuery(event, querySchema.parse)

  // 3. Database query via Drizzle
  // `db` and `schema` are auto-imported by @nuxthub/core; don't import them
  const rows = await db.query.opsEvents.findMany({ limit: query.limit })

  if (rows.length === 0) throw createError({ statusCode: 404, message: 'Not found' })

  // 4. Return the fields the client needs, with dates serialized, instead of
  //    spreading the row.
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString() }))
})
```

## Database (Drizzle + D1)

- **Tables live in each layer's `server/db/tables/`.** `server/db/schema.ts` is the composition
  root: the template's ops tables plus a re-export of the layers' tables.
- **Always export inferred types**: `export type User = typeof users.$inferSelect`
- **`db` and `schema` are auto-imported** by `@nuxthub/core` Nitro-wide (`server/` and every
  layer's `server/`). Never import or instantiate Drizzle manually. Query operators (`eq`, `gt`,
  `sql`…) are imported from `drizzle-orm`.
- **Migrations**: run `bun db:generate` after schema changes and commit the migration files.
- **Local dev DB**: `.data/db/sqlite.db`, not `.wrangler/state/v3/d1/`; see
  [gotchas.md](gotchas.md) › Local D1 lives in two places.

```typescript
import { gt, sql } from 'drizzle-orm'

// Good: db and schema are auto-imported
const recent = await db.select().from(schema.opsEvents).where(gt(schema.opsEvents.createdAt, since))

// Bad: raw SQL unless absolutely necessary
await db.run(sql`SELECT * FROM users`)
```

### Product code reaches the app's template files through registries

The app's template files stay the template's. The product layers register their own entries from
Nitro plugins; tests call the same `register…()` function, because plugins don't run under vitest.

- **Fleet counters**: `registerFleetExtraContributor({ key, collect })` in
  `server/utils/extensions.ts`; the numbers land in `extra` on `GET /api/fleet`. Counts only.
  See `layers/terminal/server/plugins/fleet-counters.ts`.
- **Native rate-limit budgets**: `rateLimit()` delegates to Cloudflare's binding only when a call
  site's numbers equal a registered budget. The app registers `NATIVE_LIMITER` (30/60s); the core layer
  adds `RATE_LIMITER_60` with `registerNativeLimiter()` next to its `[[ratelimits]]` block
  (`layers/core/server/plugins/rate-limits.ts`). Named budgets that stay on KV, such as
  `PERMALINK_LIMIT`, live in `layers/core/server/utils/rate-limits.ts`.
- **Dynamic public pages and robots paths**: `registerPublicPageSource()` and
  `registerRobotsDisallow()` in `server/utils/public-pages.ts`. See `seo.md`.

Where the app still differs from a template-owned file, `docs/template-divergence.md` says why.

### Lists of every domain live at the app root

The `core` layer never names a domain, yet the refresh, the MCP server and the export routes each
need every domain's entries. Those lists are composition roots in `server/registries/`, the way
`server/db/schema.ts` composes every layer's tables, and core imports them as `#server/registries/…`:

| Registry | What a domain adds |
| --- | --- |
| `lanes.ts` | its `LANES` and `DERIVED_LANES`, spread in (`set-lanes.ts` when a lane is a set) |
| `mcp-tools.ts` | its `register…Tools` in `MCP_TOOLS`, in tools/list order |
| `export-tables.ts` | its `…_TABLES` record, spread into `EXPORT_TABLES` in export order |
| `recipes.ts` | its recipes, in run order |
| `query-context.ts` | a reader for each sources.yaml block its queries take from `QueryContext` |
| `parsers.ts` | its `parsers.manifest.ts`, which the determinism test iterates |

The shell's parts core needs (the data dictionary, the crawler pages, the judge's alert screen)
reach it the same way: `dictionary.ts`, `crawler-pages.ts` and `judge.ts` re-export them, so neither
core nor the app's own routes import `layers/terminal`. Core defines each entry's type. An event that crosses the direction is a Nitro hook instead: the
judge calls `judge:applied` when a run's verdicts land, and the theses layer subscribes
(`layers/theses/server/plugins/theses-judged.ts`). `bun run domains:check` holds the direction.

### Vendored layers

A fork takes a template feature that has moved into `layers/<name>/` by vendoring it:
`bun run layers:pull <name>` copies the template's `layers/<name>/` at one commit into this
repo, and `layers.lock.json` records that commit and a content hash. Nuxt auto-registers
`layers/`, so nothing else needs configuring. `bun run layers:check` (part of `ci`) fails if
a vendored copy has been edited. `--remote` also re-downloads each commit and confirms the
hash is the template's.

- **Updating**: `bun run layers:pull --all` re-pulls every locked layer at its recorded ref
  (`main` unless you passed `--ref`). `--sha <commit>` takes one exact commit without changing
  which ref the layer follows. The PR diff is what the template changed.
- **Customizing**: app files shadow a layer's components, pages and API routes. `server/utils`
  cannot be shadowed (the layer's export wins), so change server behaviour through an
  extension point or upstream in the template.
- **Why not `extends: ['github:…']`**: NuxtHub's merged schema types leave layers under
  `node_modules` untyped, so a remote layer's tables lose their types.
- **In the template itself**, layers are authored, not vendored: its lock stays empty.

---

## Error Handling

- **Client-side**: `<UAlert>` for user-facing errors. Never expose raw error messages.
- **Server-side**: throw `createError({ statusCode, message })`. Nitro handles the rest.
- **Loading states**: NuxtUI's `loading` prop on buttons, `<USkeleton>` for content.

## Performance

- **Prefer server-side data fetching** (`useFetch` with `await` in `<script setup>`) for initial page loads.
- **Lazy-load heavy components**: `const HeavyChart = defineAsyncComponent(() => import('./HeavyChart.vue'))`
- **Raw payloads go to R2** via `blob` (auto-imported). Never store a fetched document body in D1.
