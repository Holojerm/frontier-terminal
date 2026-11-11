import { foldQuotes } from '../recommendations'

// The descriptions a class-map page prints on each model's own card, for the
// providers whose stored model rows do not carry them. Anthropic's, OpenAI's,
// xAI's and Moonshot's models pages are parsed into catalog rows whose notes
// ARE the description, so the gate in class-map.ts reads those. Google's and
// Alibaba's models pages are polled only for the class-map sentences
// (lanes.ts), and their catalog rows come from pricing pages whose notes are
// tier text: without this, a judge re-mapping onto a Google or Alibaba card
// sentence could never pass, though the seed itself rests on such sentences
// (issue #360).
//
// A description belongs to a card only when the card itself says which model
// it is: Google's by its `*Model code*` line or its `/docs/models/<slug>` link,
// Alibaba's by its `/detail/<slug>` link. A card that names no model adds
// nothing. The text is returned as printed, so the gate's comparison stays the
// same verbatim rule basisOnPage applies.
//
// The same map works the other way: a card's description is about that card's
// model, whatever else it mentions. Argon's card compares itself to Carbon
// ("…lower token spend per turn compared to Gemini 4 Carbon…"), which the
// naming rule read as naming Carbon, and on 2026-11-10 the gate accepted it as
// the basis for Carbon's flagship cell (cardOwners, issue #360 follow-up).

/** slug -> the descriptions printed on that model's cards. */
export type CardDescriptions = Map<string, Set<string>>

type CardReader = (text: string) => CardDescriptions

function add(out: CardDescriptions, slug: string, description: string): void {
  const trimmed = description.trim()
  if (!slug || !trimmed) return
  const set = out.get(slug) ?? new Set<string>()
  set.add(trimmed)
  out.set(slug, set)
}

/** A Markdoc tag's `name="value"` attributes, `\"` escapes undone. */
function markdocAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [, name, value] of tag.matchAll(/([A-Za-z][\w-]*)="((?:[^"\\]|\\.)*)"/g)) {
    out.set(name!, value!.replace(/\\(.)/g, '$1'))
  }
  return out
}

const MD_SLUG = /\/docs\/models\/([A-Za-z0-9._-]+)/

/**
 * Google's models.md: a `{% card description="…" %}` tag per model. A
 * self-closing card names its model by `href`; a block card (the generation's
 * headline model) by the `*Model code* **slug**` line or the models link in
 * its body.
 */
const googleCards: CardReader = (text) => {
  const out: CardDescriptions = new Map()
  const tag = /\{%\s*card\s((?:"(?:[^"\\]|\\.)*"|[^"%])*?)(\/)?%\}/g
  for (const match of text.matchAll(tag)) {
    const attrs = markdocAttributes(match[1]!)
    const description = attrs.get('description')
    if (!description) continue
    let slug = attrs.get('href')?.match(MD_SLUG)?.[1]
    if (!slug && !match[2]) {
      const start = match.index! + match[0].length
      const end = text.indexOf('{% /card %}', start)
      const body = text.slice(start, end === -1 ? undefined : end)
      slug =
        body.match(/\*Model code\*\s*\*\*`?([A-Za-z0-9._-]+)`?\*\*/)?.[1] ??
        body.match(MD_SLUG)?.[1]
    }
    if (slug) add(out, slug, description)
  }
  return out
}

/**
 * Alibaba's model list: an `<a class="adoc-help-center-card">` per model,
 * linking to its `/detail/<slug>` page, with the description as the body's
 * one paragraph.
 */
const alibabaCards: CardReader = (html) => {
  const out: CardDescriptions = new Map()
  const card = /<a\s[^>]*class="adoc-help-center-card"[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(card)) {
    const slug = match[0].match(/href="[^"]*\/detail\/([^"/?#]+)"/)?.[1]
    const body = match[1]!.match(/adoc-help-center-card-body"[^>]*>\s*<p>([^<]*)<\/p>/)?.[1]
    if (slug && body) add(out, slug, body)
  }
  return out
}

const READERS: Readonly<Record<string, CardReader>> = {
  'google-models-md': googleCards,
  'alibaba-models-html': alibabaCards,
}

/** The card descriptions on a class-map page; empty for a source with no reader. */
export function cardDescriptions(sourceId: string, text: string): CardDescriptions {
  return READERS[sourceId]?.(text) ?? new Map()
}

/** The models whose own card prints this sentence, quote typography aside. */
export function cardOwners(cards: CardDescriptions, basis: string): string[] {
  const wanted = foldQuotes(basis.trim())
  return [...cards]
    .filter(([, descriptions]) => [...descriptions].some((d) => foldQuotes(d) === wanted))
    .map(([slug]) => slug)
}
