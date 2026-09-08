// Committed fixtures, loaded through Vite `?raw` imports so they are readable
// inside workerd, where there is no filesystem. Keyed by repo-relative path —
// the same strings parsers register as fixturePath / sideFixturePaths — so the
// determinism harness resolves a registration straight to its bytes.

import manifestJson from '../../fixtures/manifest.json'
import anthropicGreenhouseDepartments from '../../fixtures/hiring/anthropic-greenhouse-departments.json?raw'
import anthropicGreenhouse from '../../fixtures/hiring/anthropic-greenhouse.json?raw'
import openaiAshby from '../../fixtures/hiring/openai-ashby.json?raw'
import xaiGreenhouseDepartments from '../../fixtures/hiring/xai-greenhouse-departments.json?raw'
import xaiGreenhouse from '../../fixtures/hiring/xai-greenhouse.json?raw'
import anthropicModelsOverview from '../../fixtures/pricing/anthropic-models-overview.md?raw'
import anthropicPricing from '../../fixtures/pricing/anthropic-pricing.md?raw'
import googlePricing from '../../fixtures/pricing/google-pricing.html?raw'
import openaiModels from '../../fixtures/pricing/openai-models.md?raw'
import openrouterModels from '../../fixtures/pricing/openrouter-models.json?raw'
import openrouterRankings from '../../fixtures/rankings/openrouter-rankings-daily.json?raw'
import xaiModels from '../../fixtures/pricing/xai-models.md?raw'
import edgarFts from '../../fixtures/sec/edgar-fts.json?raw'
import edgarSubmissionsSpcx from '../../fixtures/sec/edgar-submissions-spcx.json?raw'
import anthropicStatus from '../../fixtures/status/anthropic-status.json?raw'
import googleCloudStatus from '../../fixtures/status/google-cloud-status.json?raw'
import openaiStatus from '../../fixtures/status/openai-status.json?raw'
import sourcesYaml from '../../sources.yaml?raw'

import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'

export const manifest = manifestJson

const files: Readonly<Record<string, string>> = {
  'fixtures/hiring/anthropic-greenhouse-departments.json': anthropicGreenhouseDepartments,
  'fixtures/hiring/anthropic-greenhouse.json': anthropicGreenhouse,
  'fixtures/hiring/openai-ashby.json': openaiAshby,
  'fixtures/hiring/xai-greenhouse-departments.json': xaiGreenhouseDepartments,
  'fixtures/hiring/xai-greenhouse.json': xaiGreenhouse,
  'fixtures/pricing/anthropic-models-overview.md': anthropicModelsOverview,
  'fixtures/pricing/anthropic-pricing.md': anthropicPricing,
  'fixtures/pricing/google-pricing.html': googlePricing,
  'fixtures/pricing/openai-models.md': openaiModels,
  'fixtures/pricing/openrouter-models.json': openrouterModels,
  'fixtures/pricing/xai-models.md': xaiModels,
  'fixtures/rankings/openrouter-rankings-daily.json': openrouterRankings,
  'fixtures/sec/edgar-fts.json': edgarFts,
  'fixtures/sec/edgar-submissions-spcx.json': edgarSubmissionsSpcx,
  'fixtures/status/anthropic-status.json': anthropicStatus,
  'fixtures/status/google-cloud-status.json': googleCloudStatus,
  'fixtures/status/openai-status.json': openaiStatus,
  'sources.yaml': sourcesYaml,
}

/** Text of a committed file by repo-relative path. Throws on an unknown path
 * so a parser registered against a fixture nobody imported fails loudly. */
export function fixtureText(repoRelativePath: string): string {
  const text = files[repoRelativePath]
  if (text === undefined) {
    throw new Error(
      `no fixture imported for ${repoRelativePath} — add it to test/pipeline/fixtures.ts`,
    )
  }
  return text
}

/** Provenance recorded in fixtures/manifest.json for a source id — the tests'
 * expected values come from here, never retyped. For a constructed fixture
 * that is the documentation it was built from (fixture-provenance.ts). */
export function provenanceOf(sourceId: string): { source_url: string; fetched_at: string } {
  return fixtureProvenance(sourceId)
}
