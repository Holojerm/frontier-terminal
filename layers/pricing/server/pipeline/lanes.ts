import { setLane, type Lane, type ParseContext } from '#layers/core/server/pipeline/lanes'
import { normalizePrices, normalizeRecommendations } from './normalize'
import { parseAlibabaPricingHtml } from './parsers/pricing/alibaba-pricing'
import { parseAnthropicModelsOverviewMd } from './parsers/pricing/anthropic-models-overview'
import { parseAnthropicPricingMd } from './parsers/pricing/anthropic-pricing'
import { parseDeepseekPricingMd } from './parsers/pricing/deepseek-pricing'
import { parseGoogleModelPage } from './parsers/pricing/google-model-page'
import { parseGooglePricingPage } from './parsers/pricing/google-pricing'
import { META_LINE_PAGES, parseMetaModelsMd } from './parsers/pricing/meta-models'
import { parseMetaPricingMd } from './parsers/pricing/meta-pricing'
import { parseMistralModelsMd } from './parsers/pricing/mistral-models'
import { parseMistralPricingMd } from './parsers/pricing/mistral-pricing'
import { parseMoonshotModelsMd } from './parsers/pricing/moonshot-models'
import { parseOpenAiModelPage } from './parsers/pricing/openai-model-page'
import { parseOpenAiModelsMd } from './parsers/pricing/openai-models'
import { parseOpenAiPricingMd } from './parsers/pricing/openai-pricing'
import { parseXaiModelsMd } from './parsers/pricing/xai-models'
import { basisStaleEvents, recommendationRows } from './recommendations'

// The price lists' lanes: each lab's pricing and catalog pages, and the
// derived per-model pages. Every one is a 'set': the page IS the current
// catalog, so a model that leaves it is a removal (a delisting). Registered
// in server/registries/lanes.ts.

const set = setLane

// The pages the class map (layers/pricing/server/utils/terminal-classes.ts) is transcribed
// from also carry the drift check on that map: one 'recommendation' row per
// mapped cell, beside the page's price rows (recommendations.ts). A cell that
// loses its sentence spools class_basis_stale (recommendations.ts ›
// basisStaleEvents).
const checked = (sourceId: string, text: string, { prov, snapshotId, classMap }: ParseContext) =>
  normalizeRecommendations(recommendationRows(sourceId, text, prov, classMap), snapshotId)
// A class-map page with no lane of its own, read as a side: its check row is
// stored with the lane that joins it, under that lane's fetch provenance, as
// every stored row is. The cell names the side page as its basis (basis_source_id).
const checkedSide = (sourceId: string, ctx: ParseContext) =>
  checked(sourceId, ctx.side(sourceId), ctx)
/** A set lane whose page carries class-map sentences. */
const checkedSet = (parse: Lane['parse']): Lane => ({ ...set(parse), opsEvents: basisStaleEvents })

// A derived OpenAI model page: one SKU row that must be the slug it was
// derived for (the parser checks). The page IS the SKU's current state.
const OPENAI_MODEL_PAGE_LANE: Lane = {
  sides: [],
  removals: 'set',
  parse: (text, { prov, snapshotId, derivedKey }) => ({
    entities: normalizePrices(parseOpenAiModelPage(text, derivedKey, prov).rows, snapshotId),
  }),
}

// A derived Google model page: the context window the pricing page omits,
// one unpriced row under the slug's Standard key (the parser checks the slug).
const GOOGLE_MODEL_PAGE_LANE: Lane = {
  sides: [],
  removals: 'set',
  parse: (text, { prov, snapshotId, derivedKey }) => ({
    entities: normalizePrices(parseGoogleModelPage(text, derivedKey ?? '', prov).rows, snapshotId),
  }),
}

/** Lanes for derived sources, matched by source-id prefix (server/registries/lanes.ts › laneFor). */
export const PRICE_DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  { prefix: 'openai-model-md-', lane: OPENAI_MODEL_PAGE_LANE },
  { prefix: 'google-model-md-', lane: GOOGLE_MODEL_PAGE_LANE },
]

export const PRICE_LANES: Readonly<Record<string, Lane>> = {
  'openai-models-md': checkedSet((text, ctx) => ({
    entities: [
      ...normalizePrices(parseOpenAiModelsMd(text, ctx.prov).rows, ctx.snapshotId),
      ...checked('openai-models-md', text, ctx),
    ],
  })),
  'openai-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseOpenAiPricingMd(text, prov).rows, snapshotId),
  })),
  'anthropic-models-md': checkedSet((text, ctx) => ({
    entities: [
      ...normalizePrices(parseAnthropicModelsOverviewMd(text, ctx.prov).rows, ctx.snapshotId),
      ...checked('anthropic-models-md', text, ctx),
    ],
  })),
  'anthropic-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseAnthropicPricingMd(text, prov).rows, snapshotId),
  })),
  'xai-models-md': checkedSet((text, ctx) => ({
    entities: [
      ...normalizePrices(parseXaiModelsMd(text, ctx.prov).rows, ctx.snapshotId),
      ...checked('xai-models-md', text, ctx),
    ],
  })),
  // The availability tables are on each text line's own page (meta-models.ts).
  // Muse Spark's page also carries the balanced cell's sentence.
  'meta-models-md': {
    sides: Object.values(META_LINE_PAGES),
    removals: 'set',
    opsEvents: basisStaleEvents,
    parse: (text, ctx) => ({
      entities: [
        ...normalizePrices(parseMetaModelsMd(text, ctx.side, ctx.prov).rows, ctx.snapshotId),
        ...checked('meta-models-md', text, ctx),
        ...checkedSide('meta-muse-spark-md', ctx),
      ],
    }),
  },
  'meta-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseMetaPricingMd(text, prov).rows, snapshotId),
  })),
  // No class-map check: Mistral's pages print no tier sentence to watch.
  'mistral-models-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseMistralModelsMd(text, prov).rows, snapshotId),
  })),
  'mistral-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseMistralPricingMd(text, prov).rows, snapshotId),
  })),
  // Catalog and prices on one page; no class-map check: it prints no tier sentence.
  'deepseek-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseDeepseekPricingMd(text, prov).rows, snapshotId),
  })),
  'alibaba-pricing-html': set((html, { prov, snapshotId }) => ({
    entities: normalizePrices(parseAlibabaPricingHtml(html, prov).rows, snapshotId),
  })),
  // Prices come from the pricing page above; this page is polled only for
  // the sentences Alibaba's class-map cells rest on.
  'alibaba-models-html': checkedSet((html, ctx) => ({
    entities: checked('alibaba-models-html', html, ctx),
  })),
  // Catalog only: Moonshot's price tables are not in the served page.
  'moonshot-models-md': checkedSet((text, ctx) => ({
    entities: [
      ...normalizePrices(parseMoonshotModelsMd(text, ctx.prov).rows, ctx.snapshotId),
      ...checked('moonshot-models-md', text, ctx),
    ],
  })),
  'google-pricing-html': set((html, { prov, snapshotId }) => {
    const { rows, skipped } = parseGooglePricingPage(html, prov)
    return {
      entities: normalizePrices(rows, snapshotId),
      note: skipped.length ? `${skipped.length} sections/tables skipped` : undefined,
    }
  }),
  // Prices come from the pricing page above; this page is polled only for
  // the sentences Google's class-map cells rest on.
  'google-models-md': checkedSet((text, ctx) => ({
    entities: checked('google-models-md', text, ctx),
  })),
}
