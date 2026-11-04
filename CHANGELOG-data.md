# Data schema changelog

Changes to the columns of the exports at `/export/<table>.csv|json`, the bulk
feed at `/export/bulk/manifest.json`, and the JSON envelopes under `/api/*`.
Every one of those states its `schema_version`: a field in a JSON object, and
the `X-Schema-Version` header on a CSV or a JSON array. The same history is on
[/data](https://frontierterm.com/data#schema) and in `changelog` at
`/export/dictionary.json`.

## The promise

- Adding a table or a column is a minor version (1.0.0 to 1.1.0). Code that
  reads columns by name keeps working.
- Removing or renaming a table or a column is a major version (1.x to 2.0.0).
  Licensees get 90 days' notice by email before it ships, and the release is
  listed here first.
- Changing what a column holds without renaming it is a minor version, with a
  note saying what changed.
- A release that changes no column (a fix to how a value is read) is a patch.

The test in `layers/terminal/test/terminal-dictionary.test.ts` fails a build
whose columns don't match the releases in
`layers/terminal/server/utils/data-schema.ts`, or whose version bump is smaller
than its changes need.

## 1.1.0 (2026-11-04)

New: alert webhooks for licensees. We POST each new alert at or above the
severity you chose to an https URL you give us. The body is versioned like the
exports, and its `schema_version` field is this one.

- `alert` has the columns of the `alerts` table except `change_ids`, plus
  `permalink`, `source_urls` and `change_count`. `alert.changes` holds the
  cited rows of the `changes` table (up to 100, all of them on the permalink).
- `license` is the same license split a request with your key gets.
- `event`, `delivery_id` and `sent_at` sit beside them, inside the signed body.
- No table columns changed.

## 1.0.0 (2026-11-04)

First versioned schema. Every export, bulk file, and API response states its
`schema_version` from here on.

- Every table keeps the columns it had. The data dictionary lists them.
- A full-history export (`?history=full`) adds a `license` column before
  `source_url`. A rebuilt export (`?as_of=`) adds `as_of_verified` to a table
  of current rows. Neither changes the default columns.
- New: the bulk feed (`/export/bulk/manifest.json`), one gzipped CSV per table,
  rebuilt daily.
