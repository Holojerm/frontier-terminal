# Code patterns — Vue, API routes, database, forms

The worked examples: a `<script setup>` component, a validated API route, Drizzle queries, error handling, and performance defaults. Copy these shapes rather than inventing new ones.

> **Load this when:** writing a new component, API route, or database query — especially on your first change in this repo.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

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
// server/api/providers/[slug].get.ts
// File naming: [method].ts suffix = HTTP method (get, post, put, delete, patch)
//
// Every route here is public and read-only — there is no session to check.
// A route that takes input validates it with Zod and rate-limits itself.

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'providers', limit: 60, windowSeconds: 60 })

  // 1. Route params
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, message: 'Missing slug' })

  // 2. Validated query
  const query = await getValidatedQuery(event, querySchema.parse)

  // 3. Database query via Drizzle
  // `db` and `schema` are auto-imported by @nuxthub/core — do NOT import manually
  const rows = await db.query.opsEvents.findMany({ limit: query.limit })

  if (rows.length === 0) throw createError({ statusCode: 404, message: 'Not found' })

  // 4. Shape the response explicitly — return the fields the client needs, with
  //    dates serialized, rather than spreading the row.
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString() }))
})
```

## Database (Drizzle + D1)

- **Schema lives in `server/db/schema.ts`** — one file, all tables.
- **Always export inferred types**: `export type User = typeof users.$inferSelect`
- **`db` and `schema` are auto-imported** by `@nuxthub/core` Nitro-wide — they work in `server/api/`, `server/utils/`, `server/middleware/`, `server/plugins/`, `server/routes/`. Never import or instantiate Drizzle manually.
- **Migrations**: Run `bun db:generate` after schema changes, commit migration files.
- **Local dev DB**: NuxtHub creates `.data/db/sqlite.db` on first `bun dev`. This is NOT the same file as `.wrangler/state/v3/d1/` — do not write via `wrangler d1 execute --local`, the dev server won't read it. Anything that writes to the local DB from outside the app should open NuxtHub's path directly with `bun:sqlite`.

```typescript
// Good — db and schema are auto-imported, no import statement needed
const pending = await db.select().from(schema.opsEvents).where(isNull(schema.opsEvents.notifiedAt))

// Bad — raw SQL unless absolutely necessary
await db.run(sql`SELECT * FROM users`)
```

---


## Error Handling

- **Client-side**: Use `<UAlert>` for user-facing errors. Never expose raw error messages.
- **Server-side**: Always throw `createError({ statusCode, message })`. Nitro handles the rest.
- **Loading states**: Use NuxtUI's `loading` prop on buttons, `<USkeleton>` for content.

## Performance

- **Prefer server-side data fetching** (`useFetch` with `await` in `<script setup>`) for initial page loads.
- **Lazy-load heavy components**: `const HeavyChart = defineAsyncComponent(() => import('./HeavyChart.vue'))`
- **Raw payloads go to R2** via `blob` (auto-imported) — never store a fetched document body in D1.


