# New Feature Scaffold

Scaffold a complete full-stack feature: component + API routes + optional schema changes.

## Usage
`/new-feature [FeatureName]`

Example: `/new-feature Workout`

## Instructions

Given a feature name, scaffold the full stack for that feature. Ask clarifying questions first if needed:

1. **What data does this feature manage?** (to know what schema columns/tables are needed)
2. **What operations does it need?** (list, create, update, delete — determines which API routes)
3. **Where does the data come from?** (a source URL and fetch timestamp must ride on every row)

Then execute in this order:

### 1. Schema (if new table or columns needed)

Update `server/db/schema.ts` to add the new table or columns. Follow the existing patterns:
- UUID primary keys: `.$defaultFn(() => crypto.randomUUID())`
- Spread the shared `timestamps` helper for `created_at` / `updated_at` — don't redeclare them
- Foreign keys as `<table_singular>_id` with `.references(() => parent.id)`. Omit the FK
  deliberately if the row must survive a missing parent, and comment why
- Add an `index()` for any column pair you filter or sort on
- Export the inferred types: `export type [Name] = typeof [table].$inferSelect`

After updating schema, remind the user to run `/db-migrate` to generate and apply the migration.

### 2. API Routes

Create the needed routes in `server/api/[feature]/`:
- `index.get.ts` — list all
- `[id].get.ts` — get single by id

Read-only. This site has no accounts and takes no writes from a request: anything that
creates or updates rows is a scheduled task under `server/tasks/`, not an endpoint. Follow
all conventions from `/scaffold-api` — every route rate-limits itself and validates its
query with Zod. Put anything with real branching in `server/utils/[feature].ts` as a
function taking `db` first, so it can be tested in workerd.

### 3. Component

Create `app/components/[Feature]/[Feature]List.vue` — the primary list/display component.
Every rendered number shows, or links to, its source URL and fetch timestamp.

Follow all conventions from `/scaffold-component`.

### 4. Page (if needed)

If the feature warrants its own page, create `app/pages/[feature]/index.vue` that:
- Declares `definePageMeta({ publicPage: … })` and calls `useSeo()` once
- Fetches data with `const { data, status } = await useFetch('/api/[feature]')`
- Renders the List component

### Summary

After scaffolding, output a checklist of what was created and what manual steps remain:
- [ ] Run `/db-migrate` if schema was changed — and remember production D1 needs
      `bun run db:migrate:remote` explicitly; deploying does not apply migrations
- [ ] Customize Zod schemas in API routes
- [ ] Confirm every new route calls `rateLimit()`
- [ ] Add any missing props/emits to components
- [ ] Wire up page navigation in the layout if needed
- [ ] If the page is public, add `definePageMeta({ publicPage: … })` and call `useSeo()` once —
      `bun run seo:check` fails the build otherwise
