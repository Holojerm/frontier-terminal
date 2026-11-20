import { text } from 'drizzle-orm/sqlite-core'

// Every pipeline row a reader can see carries where it came from and when.
export const provenance = {
  source_url: text('source_url').notNull(),
  fetched_at: text('fetched_at').notNull(),
}
