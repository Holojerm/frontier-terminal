#!/usr/bin/env bun
// One-off, run once by hand after the press side moved to GDELT's GKG files:
// clears what GDELT's DOC search API left in the track-record tables, so no
// code has to read around it.
//
//   - Press candidate titles as that API returned them, tokenized ("Grok 4 . 7",
//     "4 , 058"), are rewritten untokenized. The judge grounds a rationale
//     against the title, and "4 . 7" holds only 4 and 7. The page and the judge
//     used to close the gaps on read; the GKG files' titles never had them.
//   - Its failed searches (status 'failed', nearly all HTTP 429) are deleted.
//     The page already read them as not searched.
//
//   bun run scripts/track-record-cleanup.ts [--remote]            # counts only
//   bun run scripts/track-record-cleanup.ts [--remote] --apply    # writes
//
// Without --remote it works on the local dev database (scripts/lib/d1-cli.ts).
// Idempotent: a second run finds nothing to change. Delete this file once it
// has run against production.

import { lit, runSql } from './lib/d1-cli'

const remote = Bun.argv.includes('--remote')
const apply = Bun.argv.includes('--apply')

/**
 * Close the gaps the search API put either side of punctuation. A comma joins
 * digits only before three more (a thousands separator), so "1 , 2" never
 * becomes 12. Hyphens stay spaced: the API wrote "state-level" and a "Title -
 * Outlet" separator the same way. Idempotent.
 */
function untokenizeTitle(title: string): string {
  return title
    .replace(/(\d) ([./]) (?=\d)/g, '$1$2')
    .replace(/(\d) , (?=\d{3}(?!\d))/g, '$1,')
    .replace(/(\d) %/g, '$1%')
    .replace(/\( /g, '(')
    .replace(/ +([.,:;?!)])(?!\.\.)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const press = runSql(
  remote,
  `SELECT id, title FROM track_record_candidates WHERE kind = 'press'`,
) as { id: string; title: string }[]
const changed = press.flatMap((c) => {
  const title = untokenizeTitle(c.title)
  return title === c.title ? [] : [{ id: c.id, title }]
})
const [failed] = runSql(
  remote,
  `SELECT count(*) AS n FROM track_record_searches WHERE source = 'gdelt' AND status = 'failed'`,
) as { n: number }[]

console.error(
  `${remote ? 'production' : 'local'}: ${changed.length} of ${press.length} press title(s) to untokenize, ` +
    `${failed?.n ?? 0} failed GDELT search(es) to delete`,
)
for (const c of changed.slice(0, 5)) console.error(`  ${c.title}`)
if (!apply) {
  console.error('Counts only. Pass --apply to write.')
  process.exit(0)
}

// A statement per title. Remote, a few dozen go in one wrangler call; bun:sqlite
// runs only the first statement of a string, so locally each goes alone.
const batch = remote ? 40 : 1
for (let i = 0; i < changed.length; i += batch) {
  runSql(
    remote,
    changed
      .slice(i, i + batch)
      .map(
        (c) =>
          `UPDATE track_record_candidates SET title = ${lit(c.title)} WHERE id = ${lit(c.id)};`,
      )
      .join('\n'),
  )
}
runSql(remote, `DELETE FROM track_record_searches WHERE source = 'gdelt' AND status = 'failed'`)
console.error('Done.')
