// Which model each latency probe sends to, settled at the start of every run.
//
// A flagship target names no model: the class map in effect says which
// family is the lab's flagship (utils/terminal-classes.ts, with the judge's
// decisions laid over it, pipeline/class-map.ts), and the newest OpenRouter
// catalog we stored (source openrouter-models) says which id serves it now
// and at what price. So a point release (gpt-6-astra → gpt-6.2-astra) is
// probed from the first run after the catalog lists it, and a re-mapped
// flagship from the first run after the decision.
//
// Nothing here falls back to an earlier id. A lab with no matching catalog
// row, or whose price would take the month over PROBE_MONTHLY_BUDGET_USD, is
// not probed on that run, and the run spools why.

import { parseOpenRouter, providerOfOpenRouterId } from '../parsers/openrouter'
import { latestSnapshot } from '#layers/pricing/server/pipeline/judge/class-map'
import {
  PROBE_MONTHLY_BUDGET_USD,
  monthlyCostCeiling,
  type ProbePrice,
  type ProbeTarget,
  type ProbeTargetSpec,
} from './targets'

/** One model in the OpenRouter catalog, as the openrouter-models parser reads it. */
export type OpenRouterModelRow = ReturnType<typeof parseOpenRouter>['rows'][number]

export const CATALOG_SOURCE_ID = 'openrouter-models'

/** Spooled per lab and run: no catalog row serves the class map's flagship, or it has no price. */
export const PROBE_MODEL_UNRESOLVED_KIND = 'probe_model_unresolved'
/** Spooled per lab and run: the flagship's catalog price would take the month over budget. */
export const PROBE_OVER_BUDGET_KIND = 'probe_over_budget'

export interface ProbeCatalog {
  rows: readonly OpenRouterModelRow[]
  source_url: string
  fetched_at: string
}

export interface ProbeSkip {
  lab: string
  kind: typeof PROBE_MODEL_UNRESOLVED_KIND | typeof PROBE_OVER_BUDGET_KIND
  detail: string
}

export interface ResolvedTargets {
  targets: ProbeTarget[]
  skipped: ProbeSkip[]
}

// ---- the matching rule -------------------------------------------------------

type Token = { word: string } | { version: number[] }

/**
 * A slug as words and version numbers: `gpt-6.2-astra` is gpt, 6.2, astra;
 * `claude-opus-5-5` is claude, opus, 5.5 (a dash between two numbers is a
 * point, as the class map writes Anthropic's ids); `qwen4-max` is qwen, 4, max.
 */
export function slugTokens(slug: string): Token[] {
  return [...slug.toLowerCase().matchAll(/[a-z]+|\d+(?:[.-]\d+)*/g)].map(([t]) =>
    /^\d/.test(t) ? { version: t.split(/[.-]/).map(Number) } : { word: t },
  )
}

const startsWith = (version: readonly number[], prefix: readonly number[]) =>
  prefix.length <= version.length && prefix.every((n, i) => version[i] === n)

/** 1, 1.0, 1.0.0: the release a catalog's unversioned name can stand for. */
const isFirstRelease = (version: readonly number[]) =>
  version[0] === 1 && version.slice(1).every((n) => n === 0)

/** Whether `id`'s tokens fill the family's, each version number extending the family's. */
function inFamily(family: readonly Token[], id: readonly Token[]): boolean {
  if (family.length !== id.length) return false
  return family.every((f, i) => {
    const t = id[i]!
    if ('word' in f) return 'word' in t && t.word === f.word
    return 'version' in t && startsWith(t.version, f.version)
  })
}

const compareVersions = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** Higher point release first, position by position. */
function compareReleases(a: readonly Token[], b: readonly Token[]) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if ('version' in x && 'version' in y) {
      const d = compareVersions(x.version, y.version)
      if (d !== 0) return d
    }
  }
  return 0
}

/**
 * The catalog row that serves a class-map flagship slug for a lab, or null.
 *
 * The slug names a family. An id is in it when its words are the slug's, in
 * order, and each of its version numbers starts with the slug's: the class
 * map's `gpt-6-astra` takes `gpt-6-astra` and `gpt-6.2-astra`, never
 * `gpt-6.2-astra-pro` (another word) or `gpt-7-astra` (another family).
 * The newest point release wins. A variant endpoint (`:batch`, `:free`) is
 * never the model. Where the slug ends in a family's first release, 1 or
 * 1.0, which the catalog may not print (Meta's `muse-wonder-1.0` is listed
 * `meta/muse-wonder`), the unversioned id is taken, and only when no id in
 * the family carries a version. A later release never falls back to an
 * unversioned id: `mistral-large-5` does not take `mistralai/mistral-large`,
 * which may be any earlier model.
 */
export function matchFlagship(
  lab: string,
  family: string,
  rows: readonly OpenRouterModelRow[],
): OpenRouterModelRow | null {
  const want = slugTokens(family)
  const last = want.at(-1)
  const unversioned =
    last && 'version' in last && isFirstRelease(last.version) ? want.slice(0, -1) : null
  let release: { row: OpenRouterModelRow; tokens: Token[] } | null = null
  let named: OpenRouterModelRow | null = null
  for (const row of rows) {
    const id = row.or_model_id
    if (id.includes(':') || providerOfOpenRouterId(id) !== lab) continue
    const tokens = slugTokens(id.slice(id.indexOf('/') + 1))
    if (inFamily(want, tokens)) {
      const d = release ? compareReleases(tokens, release.tokens) : 1
      if (d > 0 || (d === 0 && id < release!.row.or_model_id)) release = { row, tokens }
    } else if (unversioned && inFamily(unversioned, tokens) && tokens.length > 0) {
      if (!named || id < named.or_model_id) named = row
    }
  }
  return release?.row ?? named
}

// ---- one run's targets -------------------------------------------------------

/** USD per token to USD per million, without float noise. */
const perMillion = (perTok: number) => Math.round(perTok * 1e12) / 1e6

const priceOf = (row: OpenRouterModelRow): ProbePrice | null =>
  row.prompt_per_tok === null || row.completion_per_tok === null
    ? null
    : { input: perMillion(row.prompt_per_tok), output: perMillion(row.completion_per_tok) }

const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * Settle every target for one run: pinned ones as written, derived ones from
 * the class map's flagship and the catalog. Pinned targets are always
 * probed; derived ones are admitted in PROBE_TARGETS order while the month
 * stays within the budget.
 */
export function resolveProbeTargets(
  specs: readonly ProbeTargetSpec[],
  classMap: readonly ClassEntry[],
  catalog: ProbeCatalog | null,
  budget: number = PROBE_MONTHLY_BUDGET_USD,
): ResolvedTargets {
  const skipped: ProbeSkip[] = []
  const chosen = new Map<ProbeTargetSpec, ProbeTarget>()
  const derived: { spec: ProbeTargetSpec; target: ProbeTarget }[] = []

  for (const spec of specs) {
    if (spec.note !== null) {
      chosen.set(spec, { ...spec, chosen_from: null })
      continue
    }
    const unresolved = (detail: string) =>
      skipped.push({ lab: spec.lab, kind: PROBE_MODEL_UNRESOLVED_KIND, detail })
    const flagship = classMap.find((e) => e.provider === spec.lab && e.class === 'flagship')
    if (!flagship) {
      unresolved(`${spec.lab}: the class map has no flagship for this lab, so no model to probe.`)
      continue
    }
    if (!catalog) {
      unresolved(
        `${spec.lab}: no readable OpenRouter catalog (${CATALOG_SOURCE_ID}) is stored, so ${flagship.model_slug} cannot be matched to a model id.`,
      )
      continue
    }
    const row = matchFlagship(spec.lab, flagship.model_slug, catalog.rows)
    if (!row) {
      unresolved(
        `${spec.lab}: no model in the OpenRouter catalog of ${catalog.fetched_at} matches the class map's flagship ${flagship.model_slug}. Not probed this run.`,
      )
      continue
    }
    const list_price = priceOf(row)
    if (!list_price) {
      unresolved(
        `${spec.lab}: ${row.or_model_id} has no fixed price in the OpenRouter catalog of ${catalog.fetched_at}, so its cost cannot be held to the budget. Not probed this run.`,
      )
      continue
    }
    derived.push({
      spec,
      target: {
        ...spec,
        model: row.or_model_id,
        list_price,
        chosen_from: {
          family: flagship.model_slug,
          catalog_source_url: catalog.source_url,
          catalog_fetched_at: catalog.fetched_at,
        },
      },
    })
  }

  let month = monthlyCostCeiling([...chosen.values()])
  for (const { spec, target } of derived) {
    const cost = monthlyCostCeiling([target])
    if (month + cost > budget) {
      skipped.push({
        lab: spec.lab,
        kind: PROBE_OVER_BUDGET_KIND,
        detail: `${spec.lab}: ${target.model} at $${target.list_price.input} in / $${target.list_price.output} out per million tokens costs ${usd(cost)} a month, which would bring the probes to ${usd(month + cost)}, over the ${usd(budget)} budget. Not probed this run.`,
      })
      continue
    }
    month += cost
    chosen.set(spec, target)
  }

  return { targets: specs.flatMap((s) => chosen.get(s) ?? []), skipped }
}

/** The newest good OpenRouter catalog snapshot, parsed with its own provenance; null when none is readable. */
export async function loadProbeCatalog(
  db: PipelineDb,
  readRaw: RawReader,
): Promise<ProbeCatalog | null> {
  const snapshot = await latestSnapshot(db, readRaw, CATALOG_SOURCE_ID)
  if (!snapshot) return null
  try {
    const { source_url, fetched_at } = snapshot
    return {
      rows: parseOpenRouter(snapshot.text, { source_url, fetched_at }).rows,
      source_url,
      fetched_at,
    }
  } catch {
    return null
  }
}
