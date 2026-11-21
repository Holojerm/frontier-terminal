import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Track record tables (layers/press/server/pipeline/track-record/)
// ─────────────────────────────────────────────
// For each material alert: when the terminal saw the change, against when the
// press (GDELT) and the lab's own newsroom first carried it. All three are
// append-only, so the track-record tab and its exports answer as_of by the
// column that says when each row was written.

// One row per search for an alert's candidates: a match against the kept GKG
// rows, or a read of the stored newsroom posts. Written once per side, when
// the window has closed.
export const trackRecordSearches = sqliteTable(
  'track_record_searches',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull(),
    source: text('source').notNull(), // gdelt | newsroom
    query: text('query').notNull(),
    window_start: text('window_start').notNull(),
    window_end: text('window_end').notNull(),
    status: text('status').notNull(), // ok | skipped
    detail: text('detail'),
    candidates: integer('candidates').notNull(),
    searched_at: text('searched_at').notNull(),
    raw_key: text('raw_key'),
    source_url: text('source_url').notNull(),
  },
  (t) => [
    index('track_record_searches_alert_idx').on(t.alert_id, t.source, t.searched_at),
    // terminalStamps reads max(searched_at) on every cached request.
    index('track_record_searches_searched_idx').on(t.searched_at),
  ],
)

// One row per GDELT GKG file the press side has read (pipeline/track-record/gkg.ts),
// a contiguous run from GKG_FROM: a file is recorded only when it is the next
// one. missing: GDELT never published that quarter hour. matched and raw_key are
// legacy (the job no longer matches rows as it reads them): 0 and null on newer rows.
export const gdeltFiles = sqliteTable(
  'gdelt_files',
  {
    stamp: text('stamp').primaryKey(),
    url: text('url').notNull(),
    status: text('status').notNull(), // ok | missing
    rows: integer('rows').notNull(),
    matched: integer('matched').notNull(),
    raw_key: text('raw_key'),
    fetched_at: text('fetched_at').notNull(),
    recorded_at: text('recorded_at').notNull(),
    // Rows kept in gkg_mentions from this file, and the vocabulary (JSON
    // array) they were kept by; both null for a file read before rows were
    // kept, which leaves it unsearchable for every alert.
    mentions: integer('mentions'),
    vocabulary: text('vocabulary'),
    // When the file was read for reported figures (pipeline/reported/). Null for a
    // file read before that side existed, until the job reads it again for them.
    figures_at: text('figures_at'),
  },
  (t) => [
    index('gdelt_files_recorded_idx').on(t.recorded_at),
    index('gdelt_files_figures_idx').on(t.figures_at, t.stamp),
  ],
)

// The GKG rows that name a tracked lab, filer or model family, kept
// MENTION_RETAIN_DAYS for matching each alert once its window closes
// (track-record/mentions.ts). Compact: names holds only the vocabulary terms
// the row carried.
export const gkgMentions = sqliteTable(
  'gkg_mentions',
  {
    record_id: text('record_id').primaryKey(),
    stamp: text('stamp').notNull(),
    seen_at: text('seen_at').notNull(),
    outlet: text('outlet').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    names: text('names').notNull(), // JSON array
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [index('gkg_mentions_seen_idx').on(t.seen_at)],
)

// One row per (alert, kind, url): an article or newsroom post inside the
// alert's window that matched its search terms. A candidate is not a match;
// a match is a same-event verdict below.
export const trackRecordCandidates = sqliteTable(
  'track_record_candidates',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull(),
    kind: text('kind').notNull(), // press | newsroom
    title: text('title').notNull(),
    snippet: text('snippet'),
    outlet: text('outlet').notNull(),
    url: text('url').notNull(),
    published_at: text('published_at').notNull(),
    search_id: text('search_id').notNull(),
    found_at: text('found_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('track_record_candidates_alert_idx').on(t.alert_id, t.kind, t.published_at),
    index('track_record_candidates_found_idx').on(t.found_at, t.id),
  ],
)

// One verdict per candidate: the judge routine's same-event rating, gated
// and grounded by the Worker (track-record/review.ts).
export const trackRecordVerdicts = sqliteTable(
  'track_record_verdicts',
  {
    id: text('id').primaryKey(),
    candidate_id: text('candidate_id').notNull(),
    alert_id: text('alert_id').notNull(),
    same_event: integer('same_event', { mode: 'boolean' }).notNull(),
    rationale: text('rationale').notNull(),
    judged_at: text('judged_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('track_record_verdicts_alert_idx').on(t.alert_id),
    // One rating per (alert, candidate): the write is do-nothing on this (#316).
    uniqueIndex('track_record_verdicts_pair_uq').on(t.alert_id, t.candidate_id),
    index('track_record_verdicts_judged_idx').on(t.judged_at, t.id),
  ],
)
