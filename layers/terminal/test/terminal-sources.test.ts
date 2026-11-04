import { describe, expect, it } from 'vitest'

import { includeSources } from '../server/pipeline/sources'
import { RECIPES } from '../server/theses/recipes/registry'
import { SOURCE_LABELS, labelOf, readSourceRegistry } from '../server/utils/terminal-sources'
import { fixtureText, manifest } from './pipeline/fixtures'

// The UI reads caveats straight out of sources.yaml. These tests pin that
// the narrow reader recovers the audit's words intact, and that the one
// hand-kept map (labels) cannot silently fall behind the registry.

const yaml = fixtureText('sources.yaml')
const registry = readSourceRegistry(yaml)
const byId = Object.fromEntries(registry.sources.map((s) => [s.source_id, s]))

describe('readSourceRegistry', () => {
  it('yields exactly the include sources the pipeline fetches, by fixture id', () => {
    const pipelineIds = includeSources(yaml, manifest.fixtures)
      .map((s) => s.source_id)
      .sort()
    expect(registry.sources.map((s) => s.source_id).sort()).toEqual(pipelineIds)
    expect(registry.sources).toHaveLength(35)
    // The one id sources.yaml spells differently from the manifest.
    expect(byId['edgar-submissions-spcx']!.yaml_id).toBe('edgar-submissions')
  })

  it('recovers folded caveats whole, in the audit’s words', () => {
    const xai = byId['xai-greenhouse']!.caveat!
    expect(xai).toContain('Every row carries company_name "SpaceXAI"')
    expect(xai).toContain('no aerospace or launch function')
    expect(xai).not.toContain('\n')
    // The join table carries the bound's honest limit.
    expect(byId['xai-greenhouse-departments']!.caveat).toContain('they do not prove none is')

    expect(byId['openrouter-models']!.caveat).toContain('never source of record')
    expect(byId['openai-models-md']!.caveat).toContain('Cloudflare-403')
    // A single-line caveat and a null one.
    expect(byId['anthropic-models-md']!.caveat).toBe(
      'Catalog fields (context window, cutoff); pair with anthropic-pricing-md for prices.',
    )
    expect(byId['anthropic-greenhouse-departments']!.caveat).toBeNull()
  })

  it('carries axis, provider, url and verdict per source', () => {
    expect(byId['google-pricing-html']).toMatchObject({
      axis: 'pricing-catalog',
      provider: 'google',
      url: 'https://aistudio.google.com/docs/pricing.md',
    })
    expect(byId['google-pricing-html']!.verdict).toMatch(/^include/)
    expect(byId['edgar-fts']).toMatchObject({ axis: 'sec', provider: 'all' })
    expect(byId['openrouter-models']!.axis).toBe('pricing-cross-check')
    expect(byId['google-cloud-status']).toMatchObject({ axis: 'status', provider: 'google' })
    expect(byId['google-cloud-status']!.caveat).toContain('equals "Vertex AI"')
    expect(byId['openrouter-rankings-daily']).toMatchObject({
      axis: 'demand-share',
      provider: 'all',
      license: 'CC BY 4.0 (openrouter.ai/docs/cookbook/administration/data-api, read 2026-09-08)',
      citation:
        'Source: OpenRouter (openrouter.ai/rankings), as of {meta.as_of}. Licensed under CC BY 4.0.',
    })
    expect(byId['openai-models-md']!.license).toBeNull()
    expect(byId['meta-pricing-md']).toMatchObject({
      axis: 'pricing-catalog',
      provider: 'meta',
      url: 'https://dev.meta.ai/docs/pricing-rate-limits.md',
    })
  })

  it('lists the deliberate cuts with their reasons', () => {
    const meta = registry.cuts.find((c) => c.id === 'meta-hiring')!
    expect(meta.verdict).toContain('no public feed')
    expect(meta.reason).toContain('Collection of data on Facebook through automated means')
    const status = registry.cuts.find((c) => c.id === 'meta-status')!
    expect(status.reason).toContain('current state')
    expect(registry.cuts.map((c) => c.id)).toEqual([
      'artificial-analysis',
      'lmarena',
      'compute-deals',
      'anthropic-disclosures',
      'google-disclosures',
      'xai-disclosures',
      'meta-hiring',
      'meta-status',
      'meta-disclosures',
      'mistral-disclosures',
      'gpu-runpod',
      'gpu-aws',
      'gpu-google-cloud',
      'gpu-vultr',
      'gpu-jarvislabs',
      'gpu-scaleway',
      'gpu-fluidstack-hyperbolic',
      'gpu-aggregators',
      'vscode-marketplace',
      'open-vsx',
      'github-commit-search',
      'kalshi',
      'polymarket',
      'google-rate-limits',
      'mistral-rate-limits',
      'xai-pay-bands',
      'mistral-pay-bands',
      'alphabet-anthropic-stake',
    ])
  })

  it('carries an audit entry for every recipe in the registry, at the URL each fetches', () => {
    // No exemptions: a recipe with no entry has no terms reading or rights,
    // and /contact would list it under no licence group.
    const audited = new Map(registry.recipes.map((r) => [r.recipe_id, r]))
    for (const recipe of RECIPES) {
      const entry = audited.get(recipe.id)
      expect(entry, recipe.id).toBeDefined()
      expect(entry!.verdict).toMatch(/^include/)
      expect(entry!.terms, recipe.id).toBeTruthy()
      expect(entry!.rights, recipe.id).not.toBeNull()
      const url = recipe.url({ now: new Date(), newest: null })
      // A URL that carries the run's dates is registered as a template on the same host.
      if (entry!.url.includes('{'))
        expect(new URL(entry!.url).host, recipe.id).toBe(new URL(url).host)
      else expect(entry!.url, recipe.id).toBe(url)
    }
    expect([...audited.keys()].sort()).toEqual(RECIPES.map((r) => r.id).sort())
  })

  it('records the terms reading and the licensing stance for every source and audited recipe', () => {
    // A fund's compliance review asks this per source; a source registered
    // without it would ship data nobody has checked the right to serve.
    for (const s of registry.sources) {
      expect(s.terms, s.yaml_id).toMatch(/robots\.txt/)
      expect(s.rights, s.yaml_id).not.toBeNull()
    }
    for (const r of registry.recipes) expect(r.rights, r.recipe_id).not.toBeNull()
    expect(byId['openrouter-rankings-daily']!.rights).toBe('upstream')
    expect(byId['openrouter-rankings-daily']!.terms).toContain('competing free API')
    const recipeRights = Object.fromEntries(registry.recipes.map((r) => [r.recipe_id, r.rights]))
    expect(recipeRights['ramp-ai-index']).toBe('not-cleared')
    // The Cloudflare thesis's recipes, which predate the block.
    expect(recipeRights).toMatchObject({
      'sec-revenue-net': 'ours',
      'sec-revenue-akam': 'ours',
      'sec-revenue-fsly': 'ours',
      'npm-wrangler': 'upstream',
      'greenhouse-cloudflare': 'ours',
      'cloudflare-changelog-ai': 'not-cleared',
    })
    expect(() =>
      readSourceRegistry(yaml.replace('    rights: ours\n', '    rights: ours-ish\n')),
    ).toThrow(/unknown rights ours-ish/)
  })

  it('fails loudly on a file with no sources block', () => {
    expect(() => readSourceRegistry('cut:\n  x:\n    verdict: cut\n')).toThrow(
      'zero include sources',
    )
  })
})

describe('labels', () => {
  it('every include source has a label, so the registry cannot outgrow the map unnoticed', () => {
    for (const source of registry.sources) {
      expect(SOURCE_LABELS[source.source_id], source.source_id).toBeDefined()
    }
    for (const id of Object.keys(SOURCE_LABELS)) {
      expect(byId[id], `label for unknown source ${id}`).toBeDefined()
    }
  })

  it('names an unlabeled source by its id rather than throwing', () => {
    expect(labelOf('something-new')).toEqual({ label: 'something-new', role: 'primary' })
    expect(labelOf('openrouter-models').role).toBe('cross-check')
  })
})
