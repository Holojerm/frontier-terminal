// Implied spend share: the demand-share rankings (tokens per model per UTC
// day, OpenRouter) joined to the price catalog (USD per million tokens, the
// vendors' own pages) — one join over data already in the store. Tokens say
// who is used; tokens × list price says where the dollars would go at list,
// which is the "tokens to open source, economics to the frontier labs"
// decomposition an investor wants and the rankings alone cannot give.
//
// Held out exactly as far as it deserves. It is one routing channel's
// traffic, not market revenue; the rankings carry total tokens with no
// prompt/completion split, so every figure is a pair of bounds — all tokens
// at the input price, all at the output price — never a point; and a model
// the catalog does not list is counted in tokens and excluded from dollars,
// with coverage printed beside the share so the gap is never hidden.
//
// The pure half (summarizeSpend, matchSku) has no clock and no database;
// test/terminal-spend.test.ts drives it on fixture rows.

import { eq } from 'drizzle-orm'

import type {
  BigFour,
  DateWindow,
  SourceRef,
  SpendData,
  SpendModel,
  SpendProviderView,
} from '#shared/utils/terminal-types'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'
import { sourceStamps, type QueryContext } from './terminal-db'
import { byString, num, parseJson, str } from './terminal-json'
import {
  SHARE_WINDOW_DAYS,
  queryRankings,
  rankingObservations,
  type RankingObservation,
} from './terminal-rankings'
import { PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'

export const SPEND_CAVEAT =
  'Implied, not observed: tokens OpenRouter routed in the window × each vendor’s published list price for the matched SKU. ' +
  'One aggregator’s channel, not market revenue; direct API and enterprise volume never route here. ' +
  'The rankings carry total tokens with no prompt/completion split, so every dollar figure is a range — every token at the input price (low) to every token at the output price (high). ' +
  'Models the catalog does not list, and OpenRouter free-tier variants, count in tokens and not in dollars; coverage says how much of each lab’s traffic was priceable.'

/** A stored price row as the join needs it. */
export interface SkuPrice {
  entity_key: string
  provider: BigFour
  model_slug: string
  tier: string | null
  input_per_mtok: number | null
  output_per_mtok: number | null
  effective_from: string | null
  source_url: string
  fetched_at: string
}

/** OpenRouter's vendor prefixes for the four labs. */
const VENDOR_PREFIX: Readonly<Record<string, BigFour>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'x-ai': 'xai',
}

/**
 * A slug's identity as a sorted bag of word/number tokens, so the two ways
 * the sides spell one model — OpenRouter's `claude-4.5-haiku-20251001`,
 * Anthropic's `claude-haiku-4-5` — compare equal: the trailing release date
 * is dropped, and `4.5` / `4-5` both read as the tokens 4 and 5.
 */
export function slugTokens(slug: string): string {
  const bare = slug
    .toLowerCase()
    .replace(/:free$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
  return bare
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

/** Vendor and bare slug of a rankings permaslug, or null for a non-lab vendor or the `other` row. */
export function splitPermaslug(
  permaslug: string,
): { provider: BigFour; slug: string; free: boolean } | null {
  const i = permaslug.indexOf('/')
  if (i === -1) return null
  const provider = VENDOR_PREFIX[permaslug.slice(0, i)]
  if (!provider) return null
  const slug = permaslug.slice(i + 1)
  return { provider, slug, free: slug.endsWith(':free') }
}

const priced = (r: SkuPrice) => r.input_per_mtok !== null || r.output_per_mtok !== null
const isStandard = (r: SkuPrice) => r.tier === null || r.tier === 'standard'

/** The catalog row a permaslug reads its price from: same lab, same token
 * bag, a current (no effective_from) standard-tier priced row first. */
export function matchSku(
  provider: BigFour,
  slug: string,
  catalog: readonly SkuPrice[],
): SkuPrice | null {
  const want = slugTokens(slug)
  const candidates = catalog
    .filter((r) => r.provider === provider && slugTokens(r.model_slug) === want)
    .sort(
      (a, b) =>
        Number(priced(b)) - Number(priced(a)) ||
        Number(isStandard(b)) - Number(isStandard(a)) ||
        Number(a.effective_from !== null) - Number(b.effective_from !== null) ||
        byString(a.entity_key, b.entity_key),
    )
  return candidates[0] ?? null
}

const spend = (tokens: number, perMtok: number | null) =>
  perMtok === null ? null : (tokens / 1_000_000) * perMtok

export interface SpendSummary {
  window: DateWindow | null
  providers: SpendProviderView[]
  totals: SpendData['totals']
  excluded: SpendData['excluded']
}

/** Pure: the whole panel from the stored observations and catalog rows. */
export function summarizeSpend(
  rows: readonly RankingObservation[],
  catalog: readonly SkuPrice[],
): SpendSummary {
  const dates = [...new Set(rows.map((r) => r.date))].sort(byString)
  const windowDates = dates.slice(-SHARE_WINDOW_DAYS)
  const inWindow = new Set(windowDates)
  const window: DateWindow | null = windowDates.length
    ? { from: windowDates[0]!, to: windowDates.at(-1)! }
    : null

  const tokensByModel = new Map<string, number>()
  let total = 0
  let otherTokens = 0
  for (const r of rows) {
    if (!inWindow.has(r.date)) continue
    total += r.total_tokens
    if (!splitPermaslug(r.model_permaslug)) {
      otherTokens += r.total_tokens
      continue
    }
    tokensByModel.set(
      r.model_permaslug,
      (tokensByModel.get(r.model_permaslug) ?? 0) + r.total_tokens,
    )
  }

  const byProvider = new Map<BigFour, SpendModel[]>(PROVIDER_ORDER.map((p) => [p, []]))
  for (const [permaslug, tokens] of tokensByModel) {
    const split = splitPermaslug(permaslug)!
    const sku = split.free ? null : matchSku(split.provider, split.slug, catalog)
    const usable = sku !== null && priced(sku)
    byProvider.get(split.provider)!.push({
      model_permaslug: permaslug,
      tokens,
      matched_key: sku?.entity_key ?? null,
      reason: split.free ? 'free' : sku === null ? 'unlisted' : usable ? null : 'unpriced',
      input_per_mtok: usable ? sku.input_per_mtok : null,
      output_per_mtok: usable ? sku.output_per_mtok : null,
      spend_low: usable ? spend(tokens, sku.input_per_mtok) : null,
      spend_high: usable ? spend(tokens, sku.output_per_mtok) : null,
      price_source_url: usable ? sku.source_url : null,
      price_fetched_at: usable ? sku.fetched_at : null,
    })
  }

  const labTokens = total - otherTokens
  const sums = PROVIDER_ORDER.map((provider) => {
    const models = byProvider
      .get(provider)!
      .sort((a, b) => b.tokens - a.tokens || byString(a.model_permaslug, b.model_permaslug))
    const tokens = models.reduce((n, m) => n + m.tokens, 0)
    const pricedTokens = models.reduce((n, m) => n + (m.spend_low !== null ? m.tokens : 0), 0)
    const low = models.reduce((n, m) => n + (m.spend_low ?? 0), 0)
    const high = models.reduce((n, m) => n + (m.spend_high ?? 0), 0)
    return { provider, models, tokens, pricedTokens, low, high }
  })
  const totalLow = sums.reduce((n, s) => n + s.low, 0)
  const totalHigh = sums.reduce((n, s) => n + s.high, 0)
  const totalPriced = sums.reduce((n, s) => n + s.pricedTokens, 0)

  const providers: SpendProviderView[] = sums.map((s) => ({
    provider: s.provider,
    display: PROVIDER_DISPLAY[s.provider],
    tokens: s.tokens,
    priced_tokens: s.pricedTokens,
    coverage: s.tokens > 0 ? s.pricedTokens / s.tokens : null,
    spend_low: s.low,
    spend_high: s.high,
    share_low: totalLow > 0 ? s.low / totalLow : null,
    share_high: totalHigh > 0 ? s.high / totalHigh : null,
    token_share: labTokens > 0 ? s.tokens / labTokens : null,
    models: s.models,
  }))

  // A lab routed tokens but none of its ranked models met a published price
  // (OpenAI's catalog page prints none): it is in the token share and out
  // of the dollar share, and the payload says so rather than printing 0%.
  const excluded: SpendData['excluded'] = providers
    .filter((p) => p.tokens > 0 && p.priced_tokens === 0)
    .map((p) => ({
      provider: p.provider,
      display: p.display,
      reason: p.models.every((m) => m.reason === 'unpriced' || m.reason === 'unlisted')
        ? p.models.some((m) => m.reason === 'unpriced')
          ? 'listed SKUs carry no published price on the vendor page'
          : 'no ranked model matched a catalog SKU'
        : 'no priced SKU matched',
    }))

  return {
    window,
    providers,
    excluded,
    totals: {
      tokens: total,
      other_tokens: otherTokens,
      priced_tokens: totalPriced,
      spend_low: totalLow,
      spend_high: totalHigh,
    },
  }
}

/** Every current price row, as the join reads it. */
export async function catalogRows(db: PipelineDb): Promise<SkuPrice[]> {
  const rows = await db
    .select({
      entity_key: tables.entities.entity_key,
      provider: tables.entities.provider,
      payload: tables.entities.payload,
      source_url: tables.entities.source_url,
      fetched_at: tables.entities.fetched_at,
    })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'model'))
  const out: SkuPrice[] = []
  for (const row of rows) {
    if (!(PROVIDER_ORDER as readonly string[]).includes(row.provider)) continue
    const p = parseJson(row.payload)
    const slug = str(p?.model_slug)
    if (!p || !slug) continue
    out.push({
      entity_key: row.entity_key,
      provider: row.provider as BigFour,
      model_slug: slug,
      tier: str(p.tier),
      input_per_mtok: num(p.input_per_mtok),
      output_per_mtok: num(p.output_per_mtok),
      effective_from: str(p.effective_from),
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    })
  }
  return out
}

export async function querySpend(db: PipelineDb, ctx: QueryContext): Promise<SpendData> {
  const [rows, catalog, rankings, stamps] = await Promise.all([
    rankingObservations(db),
    catalogRows(db),
    queryRankings(db, ctx),
    sourceStamps(db),
  ])
  const summary = summarizeSpend(rows, catalog)

  const priceSourceIds = ctx.registry.sources
    .filter((s) => s.axis === 'pricing-catalog')
    .map((s) => s.source_id)
  const price_sources: SourceRef[] = priceSourceIds
    .map((id) => {
      const stamp = stamps.get(id)
      return stamp
        ? {
            source_id: id,
            label: labelOf(id).label,
            source_url: stamp.newest.source_url,
            fetched_at: stamp.newest.fetched_at,
          }
        : null
    })
    .filter((s): s is SourceRef => s !== null)

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    status: rankings.status,
    window: summary.window,
    providers: summary.providers,
    totals: summary.totals,
    excluded: summary.excluded,
    rankings: { provenance: rankings.provenance, source: rankings.source, meta: rankings.meta },
    price_sources,
    caveat: SPEND_CAVEAT,
  }
}
