// Daily PyPI downloads of a package, excluding known mirrors, from
// pypistats.org. pypistats is a third party over the PSF's BigQuery table
// (bigquery-public-data.pypi.file_downloads, CC BY 4.0); BigQuery itself
// needs a Google Cloud account. The API keeps about 180 days and asks bulk
// users to go to BigQuery instead, which a handful of packages a day is not.
// CI installs count like people, so read the trend, not the level.
//
// Older days come from ClickPy, ClickHouse's public copy of the same PSF
// table, walked back one window a run to the package's first day
// (pypiBackfill, PYPI_FIRST_DAY). The two don't always agree: over the 181
// days both held on 2026-11-22 they matched on 114 for every package (115
// for mistralai), and on the rest ClickPy differed by 0.7% to 0.8% on
// average and 3.2% at most, lower about twice as often as higher. A row's
// source_url says which one it came from. Terms and the comparison:
// docs/source-audit.md.

import type { CompanyId } from '#layers/core/shared/utils/companies'
import type { Observation, Recipe } from '#layers/core/server/recipes/contract'
import { npmBackfill } from './npm-downloads'

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

/**
 * The first day read of each package: its first day in ClickPy (read
 * 2026-11-22), or 2020-01-01 for openai. ClickPy has that name from
 * 2018-02-26, but 2018 and 2019 total about 4,100 downloads with days
 * missing, and every day from 2020-01-01 has a row. Each floor is a day
 * ClickPy has a row for, which is what ends the walk. Where a series starts
 * on /signals.
 */
export const PYPI_FIRST_DAY = {
  'pypi-openai': '2020-01-01',
  'pypi-anthropic': '2023-02-09',
  'pypi-google-genai': '2024-12-10',
  'pypi-mistralai': '2023-12-09',
  'pypi-xai-sdk': '2023-12-08',
  'pypi-claude-agent-sdk': '2025-09-28',
  'pypi-openai-agents': '2025-03-04',
} as const

type PypiRecipeId = keyof typeof PYPI_FIRST_DAY

/** The window before the oldest stored day, back to `floor`: npm's walk, 540 days a run. */
export const pypiBackfill = npmBackfill

/**
 * The installers pypistats' `without_mirrors` leaves out. The empty one (a
 * download whose client named no installer) has to go too: with it most
 * days run above pypistats' count.
 */
const MIRRORS = ['bandersnatch', 'z3c.pypimirror', 'Artifactory', 'devpi', '']

/**
 * One window of days from ClickPy, in pypistats' own shape so
 * extractPypiDownloads reads both. `demo` is the public instance's published
 * read-only user (github.com/ClickHouse/clickpy), held to 20 queries of one
 * shape an hour across every package (the 21st is an HTTP 500). A day with
 * no downloads has no row.
 */
export function clickpyUrl(pkg: string, r: { start: string; end: string }): string {
  const sql =
    `SELECT 'without_mirrors' AS category, toString(date) AS date, toUInt32(sum(count)) AS downloads ` +
    `FROM pypi.pypi_downloads_per_day_by_version_by_installer_by_type ` +
    `WHERE project = '${pkg}' AND date BETWEEN '${r.start}' AND '${r.end}' ` +
    `AND installer NOT IN (${MIRRORS.map((m) => `'${m}'`).join(', ')}) ` +
    `GROUP BY date ORDER BY date FORMAT JSON`
  return `https://sql-clickhouse.clickhouse.com/?user=demo&query=${encodeURIComponent(sql)}`
}

function pypiRecipe(id: PypiRecipeId, company: CompanyId, pkg: string, what: string): Recipe {
  return {
    id,
    company,
    description: `Daily PyPI downloads of ${pkg}, ${what}, without mirrors`,
    url: () => `https://pypistats.org/api/packages/${pkg}/overall?mirrors=false`,
    ext: 'json',
    extract: (body) => extractPypiDownloads(body, pkg),
    license:
      'CC BY 4.0 (PSF PyPI downloads dataset, docs.pypi.org/api/bigquery/), via pypistats.org, and via ClickPy (clickpy.clickhouse.com) for days before pypistats’ window',
    backfill: ({ oldest }) => {
      const past = pypiBackfill(oldest, PYPI_FIRST_DAY[id])
      // The download log's count for the day, not a recount of what survives.
      return past ? [{ url: clickpyUrl(pkg, past), date: past.end, retrospective: false }] : []
    },
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
