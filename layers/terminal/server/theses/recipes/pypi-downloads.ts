// Daily PyPI downloads of a package, excluding known mirrors, from
// pypistats.org. pypistats is a third party over the PSF's BigQuery table
// (bigquery-public-data.pypi.file_downloads, CC BY 4.0); BigQuery itself
// needs a Google Cloud account. The API keeps 180 days and asks bulk users
// to go to BigQuery instead, which a handful of packages a day is not.
// CI installs count like people, so read the trend, not the level.

import type { CompanyId } from '../../../shared/utils/companies'
import type { Observation, Recipe } from './contract'

export function extractPypiDownloads(body: string, pkg: string): Observation[] {
  const doc = JSON.parse(body) as {
    package?: string
    data?: { category: string; date: string; downloads: number }[]
  }
  if (!Array.isArray(doc.data)) throw new Error('not a pypistats overall series')
  const rows = doc.data.filter((d) => d.category === 'without_mirrors')
  if (rows.length === 0) throw new Error('no without_mirrors rows')
  return rows.map((d) => ({ key: pkg, date: d.date, value: d.downloads, payload: {} }))
}

export function pypiRecipe(id: string, company: CompanyId, pkg: string, what: string): Recipe {
  return {
    id,
    company,
    description: `Daily PyPI downloads of ${pkg}, ${what}, without mirrors`,
    url: () => `https://pypistats.org/api/packages/${pkg}/overall?mirrors=false`,
    ext: 'json',
    extract: (body) => extractPypiDownloads(body, pkg),
    license:
      'CC BY 4.0 (PSF PyPI downloads dataset, docs.pypi.org/api/bigquery/), via pypistats.org',
  }
}

export const PYPI_LAB_RECIPES: readonly Recipe[] = [
  pypiRecipe('pypi-openai', 'openai', 'openai', 'the OpenAI SDK'),
  pypiRecipe('pypi-anthropic', 'anthropic', 'anthropic', 'the Anthropic SDK'),
  pypiRecipe('pypi-google-genai', 'google', 'google-genai', 'the Gemini SDK'),
  pypiRecipe('pypi-mistralai', 'mistral', 'mistralai', 'the Mistral SDK'),
  pypiRecipe('pypi-xai-sdk', 'xai', 'xai-sdk', 'the xAI SDK'),
  pypiRecipe('pypi-claude-agent-sdk', 'anthropic', 'claude-agent-sdk', 'the Claude Agent SDK'),
  pypiRecipe('pypi-openai-agents', 'openai', 'openai-agents', 'the OpenAI Agents SDK'),
]
