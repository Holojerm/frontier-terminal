# Scaffold API Route

Create a new server API route following the project's conventions.

## Usage
`/scaffold-api [path] [method?]`

Examples:
- `/scaffold-api workouts` → creates `layers/<domain>/server/api/workouts.get.ts`
- `/scaffold-api workouts/[id] put` → creates `layers/<domain>/server/api/workouts/[id].put.ts`
- `/scaffold-api workouts post` → creates `layers/<domain>/server/api/workouts.post.ts`

Default method is `get` if not specified.

## Before writing the file: there is no gate

Every route in this app is public: there are no accounts, so there is no session to require
and no server-side auth middleware. A public route owes a
`rateLimit(event, { name, limit, windowSeconds })` call (`rateLimitTerminal()` with the same
options on a product route) and Zod validation on every input. A new route is a read: pipeline
writes happen in each layer's `server/tasks/`, never from a request. The only writers are the
bearer-gated `/api/judge/*` and `/api/gdelt/*` and the weekly digest's `/api/subscribe/*`.

## Instructions

Create the file at `layers/<domain>/server/api/[path].[method].ts` (product code lives in its
domain's layer; root `server/api/` holds template routes only).

### GET route (read)

```typescript
// One or two lines on why this route exists and who calls it — every route in
// server/api/ carries this. Note anything non-obvious about the gate.

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  // 1. Rate limit — every public route pays for its own abuse control
  await rateLimit(event, { name: 'workouts', limit: 60, windowSeconds: 60 })

  // 2. Route params (dynamic routes only)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing id' })

  // 3. Validated query
  const query = await getValidatedQuery(event, querySchema.parse)

  // 4. Read. `db` and `schema` are auto-imported by @nuxthub/core — never
  //    import or instantiate Drizzle, and never call hubDatabase() directly.
  const row = await db.query.workouts.findFirst({
    where: eq(schema.workouts.id, id),
  })

  if (!row) throw createError({ statusCode: 404, message: 'Workout not found' })

  // 5. Shape the response explicitly. Dates are Date objects in Drizzle and
  //    must be serialized — return exactly the fields the client needs rather
  //    than spreading the row, so a column added later isn't leaked by default.
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  }
})
```

### Where the logic goes

Anything with real branching belongs in a `server/utils/*.ts` function taking the Drizzle
client as its **first argument**, not inline in the handler, so the workerd vitest suite can
drive it against a real D1 binding without booting Nitro. See `server/utils/fleet-status.ts`
and `test/fleet-status.test.ts` for the pattern.

Handlers stay thin: rate-limit, validate, call, shape.

### Rules

- **File naming**: `[path].[method].ts`; the method suffix is the HTTP method.
- **Rate-limit every route**: it is public, and the limiter is its only abuse control.
- **`db` and `schema` are auto-imported**: never `useDB()`, never `hubDatabase()`, <!-- refs-check-ignore: names the deprecated APIs a fork must NOT use -->
  never a manual `drizzle()` call.
- **Reference tables as `schema.<table>`** in routes (server utils that import the schema
  module directly use `tables.<table>`; follow the file you're in).
- **Validate input with Zod**: `getValidatedQuery` for query strings, schema declared at
  module scope.
- **No `any` types**: use Zod-inferred types or the `$inferSelect` exports.
- **Always `createError({ statusCode, message })`**: never throw raw errors.
- **Serialize dates** with `.toISOString()`; return an explicit shape, not the raw row.

After creating the file, output:
- The full file path and HTTP method
- The rate-limit budget you chose and why
- The Zod schema fields the user should customize
