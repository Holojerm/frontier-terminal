import { describe, expect, test } from 'vitest'

import { includeSources } from '../../server/pipeline/sources'
import { fixtureText, manifest } from './fixtures'

// includeSources joins sources.yaml (the include verdicts) to
// fixtures/manifest.json (what was actually fetched). Pure function of both
// texts, so this suite runs it on the committed files exactly as the
// orchestrator would.

const sourcesYaml = fixtureText('sources.yaml')

describe('includeSources', () => {
  test('yields the 16 include-verdict sources in sources.yaml order, keyed by manifest source_id', () => {
    const sources = includeSources(sourcesYaml, manifest.fixtures)
    expect(sources.map((s) => s.source_id)).toEqual([
      'openai-models-md',
      'anthropic-models-md',
      'anthropic-pricing-md',
      'xai-models-md',
      'google-pricing-html',
      'openrouter-models',
      'openai-ashby',
      'anthropic-greenhouse',
      'anthropic-greenhouse-departments',
      'xai-greenhouse',
      'xai-greenhouse-departments',
      'edgar-fts',
      'edgar-submissions-spcx',
      'openai-status',
      'anthropic-status',
      'google-cloud-status',
    ])
  })

  test('URLs come from the manifest (the concrete fetch), not the yaml (the template)', () => {
    const byId = new Map(
      includeSources(sourcesYaml, manifest.fixtures).map((s) => [s.source_id, s]),
    )
    // sources.yaml names data.sec.gov/submissions/CIK{n}.json; the manifest
    // records the resolved SPCX fetch.
    expect(byId.get('edgar-submissions-spcx')!.url).toBe(
      'https://data.sec.gov/submissions/CIK0001181412.json',
    )
    // Likewise the full-text query string only exists in the manifest.
    expect(byId.get('edgar-fts')!.url).toBe(
      'https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&forms=S-1',
    )
    expect(byId.get('openai-models-md')!.ext).toBe('md')
    expect(byId.get('openai-ashby')!.ext).toBe('json')
    expect(byId.get('google-pricing-html')!.ext).toBe('html')
  })

  test('the cut block never yields a source', () => {
    const ids = includeSources(sourcesYaml, manifest.fixtures).map((s) => s.source_id)
    expect(ids).not.toContain('google-hiring')
    expect(ids).not.toContain('compute-deals')
    expect(ids).not.toContain('xai-status')
  })

  test('non-include verdicts are skipped; an include source must name a fixture the manifest knows', () => {
    const yaml = [
      'sources:',
      '  a:',
      '    verdict: include',
      '    fixture: fixtures/pricing/xai-models.md',
      '  b:',
      '    verdict: cut — no public feed',
      '    fixture: fixtures/nowhere.json',
      'cik_whitelist:',
      '  SPCX: "0001181412"',
    ].join('\n')
    expect(includeSources(yaml, manifest.fixtures).map((s) => s.source_id)).toEqual([
      'xai-models-md',
    ])

    const noFixture = yaml.replace('    fixture: fixtures/pricing/xai-models.md\n', '')
    expect(() => includeSources(noFixture, manifest.fixtures)).toThrow(
      'sources.yaml include source a has no fixture path',
    )

    const unknownFixture = yaml.replace(
      'fixtures/pricing/xai-models.md',
      'fixtures/pricing/gone.md',
    )
    expect(() => includeSources(unknownFixture, manifest.fixtures)).toThrow(
      'fixtures/manifest.json has no entry for fixture fixtures/pricing/gone.md (a)',
    )
  })

  test('a yaml with no sources block, or with zero include verdicts, throws rather than fetching nothing', () => {
    expect(() =>
      includeSources('cik_whitelist:\n  SPCX: "0001181412"\n', manifest.fixtures),
    ).toThrow('sources.yaml has no sources block')
    expect(() =>
      includeSources('sources:\n  a:\n    verdict: cut\n    fixture: x\n', manifest.fixtures),
    ).toThrow('sources.yaml yielded zero include sources')
  })
})
