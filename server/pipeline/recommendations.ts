import { MODEL_CLASS_MAP, type ClassEntry } from '../utils/terminal-classes'
import { RecommendationRow, type Provenance } from './contracts'

// The drift check on the like-for-like matrix. The class map is editorial and
// hand-transcribed; the golden test proves each sentence was on the vendor
// page when it was transcribed, and this proves it is still there every time
// the page is polled. A vendor that rewrites its recommendation ("use GPT-6
// Astra" replacing "start here with GPT-5.6 Sol") turns `present` false, the
// diff records a 'modified' change, refresh spools an ops event, and the
// matrix cell says so — instead of the old mapping quietly aging into
// fiction on a page nobody re-reads.
//
// Presence is a literal substring match after flattening markdown links to
// their text, the same rule the golden test applies to the fixture. Nothing
// smarter: a fuzzy match would report a sentence the vendor changed as still
// present, which is the exact failure this exists to catch. The one exception
// is quote typography: Anthropic's page swapped "you're" for "you’re" on
// 2026-10-27 and the flagship cell read as re-pointed (issue #83). A curly
// apostrophe is a rendering choice, not a changed recommendation.

/** `[text](url)` → `text`; nothing else is touched. */
export function flattenMdLinks(md: string): string {
  return md.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

/** Typographic single and double quotes → their ASCII forms. */
export function foldQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
}

/** Whether the basis sentence is on a link-flattened page, quote typography aside. */
export function basisOnPage(flatPage: string, basis: string): boolean {
  return foldQuotes(flatPage).includes(foldQuotes(basis))
}

/** One row per class-map entry resting on this source; empty for a source none cite.
 * `classMap` is the map in effect (server/pipeline/class-map.ts); the seed by default. */
export function recommendationRows(
  sourceId: string,
  text: string,
  prov: Provenance,
  classMap: readonly ClassEntry[] = MODEL_CLASS_MAP,
): RecommendationRow[] {
  const entries = classMap.filter((e) => e.basis_source_id === sourceId)
  if (entries.length === 0) return []
  const flat = foldQuotes(flattenMdLinks(text))
  return entries.map((e) =>
    RecommendationRow.parse({
      provider: e.provider,
      class: e.class,
      model_slug: e.model_slug,
      basis: e.basis,
      present: flat.includes(foldQuotes(e.basis)),
      ...prov,
    }),
  )
}
