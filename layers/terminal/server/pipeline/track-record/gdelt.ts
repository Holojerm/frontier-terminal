// Press headlines as GDELT records them, for the track record's press side
// (the GKG files, gkg.ts). Terms: sources.yaml › track_record_sources › gdelt-gkg.

/** Articles kept per alert: the earliest ones, since the first report is the one that counts. */
export const PRESS_CANDIDATE_LIMIT = 20

/**
 * GDELT's search API returned a title tokenized: a space either side of
 * punctuation ("Grok 4 . 7", "4 , 058", "Rolls Out : Benchmark", "( GOOGL )?").
 * This closes those gaps so a version or a price reads as the number it is.
 * The judge grounds a rating's rationale against the title, and "4 . 7" holds
 * only 4 and 7: on 2026-11-05 every "Grok 4.6" and "GPT Image 2.5" a
 * rationale quoted was rejected as invented. The GKG files' PAGE_TITLE is
 * untokenized already; closing gaps it does not have changes nothing.
 *
 * A comma joins digits only before three more (a thousands separator), so
 * "1 , 2" never becomes the number 12. Hyphens stay spaced: GDELT writes
 * "state-level" and a "Title - Outlet" separator the same way. The apostrophes
 * and quote marks GDELT drops are gone for good. Idempotent.
 */
export function untokenizeTitle(title: string): string {
  return title
    .replace(/(\d) ([./]) (?=\d)/g, '$1$2')
    .replace(/(\d) , (?=\d{3}(?!\d))/g, '$1,')
    .replace(/(\d) %/g, '$1%')
    .replace(/\( /g, '(')
    .replace(/ +([.,:;?!)])(?!\.\.)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * A stored candidate's title as the judge and the page show it. Press rows
 * stored from the search API before titles were untokenized at ingest still
 * hold "Grok 4 . 7"; closing the gaps on read keeps them in step. Newsroom
 * titles come from the lab's own feed and are shown as written.
 */
export function candidateTitle(candidate: { kind: string; title: string }): string {
  return candidate.kind === 'press' ? untokenizeTitle(candidate.title) : candidate.title
}

/** One key per headline: a wire story syndicated to fifty sites is one report, first seen at its earliest copy. */
export const titleKey = (title: string) =>
  untokenizeTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
