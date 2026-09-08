import { describe, expect, it } from 'vitest'

import { includeSources } from '../server/pipeline/sources'
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
    expect(registry.sources).toHaveLength(17)
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
      url: 'https://ai.google.dev/gemini-api/docs/pricing',
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
  })

  it('lists the deliberate cuts with their reasons', () => {
    const google = registry.cuts.find((c) => c.id === 'google-hiring')!
    expect(google.verdict).toContain('no public feed')
    expect(google.reason).toContain('auth-walled SPA')
    expect(google.reason).toContain('DeepMind Greenhouse board is vestigial')
    const xai = registry.cuts.find((c) => c.id === 'xai-status')!
    expect(xai.reason).toContain('403')
    expect(registry.cuts.map((c) => c.id)).toEqual([
      'google-hiring',
      'artificial-analysis',
      'lmarena',
      'compute-deals',
      'xai-status',
      'mistral',
    ])
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
