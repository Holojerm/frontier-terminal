import { MODEL_CLASS_MAP, type ClassEntry } from '../utils/terminal-classes'
import {
  RecommendationRow,
  type ChangeRow,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import type { LaneOpsEvent } from '#layers/core/server/pipeline/lanes'
import { cardDescriptions, cardOwners, foldQuotes } from './judge/page-cards'

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
//
// On a page of model cards (Google's, Alibaba's: page-cards.ts) the sentence
// can stay while its card changes hands. Alibaba moved "Complex reasoning and
// coding" from qwen3.8-max's card to the new qwen4-max's on 2026-11-16 (issue
// #405); the substring was still there, so the flagship cell read as current
// and was never offered to the judge. A sentence that is now only other
// models' card description is not present for the model it was mapped to.

/** `[text](url)` → `text`; nothing else is touched. */
export function flattenMdLinks(md: string): string {
  return md.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

// foldQuotes lives with the card readers, which this module calls; defining it
// here would make the two modules import each other.
export { foldQuotes }

/** Whether the basis sentence is on a link-flattened page, quote typography aside. */
export function basisOnPage(flatPage: string, basis: string): boolean {
  return foldQuotes(flatPage).includes(foldQuotes(basis))
}

/** One row per class-map entry resting on this source; empty for a source none cite.
 * `classMap` is the map in effect (layers/pricing/server/pipeline/class-map.ts); the seed by default. */
export function recommendationRows(
  sourceId: string,
  text: string,
  prov: Provenance,
  classMap: readonly ClassEntry[] = MODEL_CLASS_MAP,
): RecommendationRow[] {
  const entries = classMap.filter((e) => e.basis_source_id === sourceId)
  if (entries.length === 0) return []
  const flat = foldQuotes(flattenMdLinks(text))
  const cards = cardDescriptions(sourceId, text)
  return entries.map((e) => {
    const owners = cardOwners(cards, e.basis)
    const ownCard = owners.length === 0 || owners.includes(e.model_slug)
    return RecommendationRow.parse({
      provider: e.provider,
      class: e.class,
      model_slug: e.model_slug,
      basis: e.basis,
      present: flat.includes(foldQuotes(e.basis)) && ownCard,
      ...prov,
    })
  })
}

/**
 * A vendor rewrote a sentence the class map rests on: the owner has a
 * transcription to redo. One event per 'recommendation' change whose
 * after-state lost the sentence, so once per flip — an unchanged verdict diffs
 * to nothing, and a stale cell does not re-spool every tick.
 */
export function basisStaleEvents(modified: readonly ChangeRow[]): LaneOpsEvent[] {
  const events: LaneOpsEvent[] = []
  for (const change of modified) {
    if (change.entity_type !== 'recommendation' || !change.after_json) continue
    const after = JSON.parse(change.after_json) as {
      class?: string
      model_slug?: string
      present?: boolean
    }
    if (after.present !== false) continue
    events.push({
      kind: 'class_basis_stale',
      detail: `${change.provider} ${after.class} (${after.model_slug}) — vendor sentence no longer on the page`,
    })
  }
  return events
}
