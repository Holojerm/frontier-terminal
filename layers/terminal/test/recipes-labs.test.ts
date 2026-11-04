import { describe, expect, it } from 'vitest'

import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import epochTimelines from '~~/fixtures/recipes/epoch-data-center-timelines.csv?raw'
import githubCount from '~~/fixtures/recipes/github-prs-copilot.json?raw'
import npmClaudeCode from '~~/fixtures/recipes/npm-claude-code.json?raw'
import pypiAnthropic from '~~/fixtures/recipes/pypi-anthropic.json?raw'
import { GITHUB_TOKEN_UNSET, createFetcher, needsGithubToken } from '../server/pipeline/fetch'
import { parseCsv } from '../server/theses/recipes/csv'
import { extractSites, extractTimelines } from '../server/theses/recipes/epoch-data-centers'
import {
  GITHUB_AGENT_RECIPES,
  extractSearchCount,
  githubPrRecipe,
} from '../server/theses/recipes/github-agent-prs'
import { NPM_LAB_RECIPES, extractDownloads } from '../server/theses/recipes/npm-downloads'
import { PYPI_LAB_RECIPES, extractPypiDownloads } from '../server/theses/recipes/pypi-downloads'
import { RECIPES } from '../server/theses/recipes/registry'

// The lab demand and supply recipes audited 2026-11-04 (docs/source-audit.md),
// against fixtures fetched that morning. Golden values are the sources' own.

const NOW = new Date('2026-11-04T06:00:00Z')

describe('package downloads', () => {
  it('reads a scoped npm package day by day', () => {
    const obs = extractDownloads(npmClaudeCode)
    expect(obs.find((o) => o.date === '2026-10-22')).toMatchObject({
      key: '@anthropic-ai/claude-code',
      value: 2_471_039,
    })
  })

  it('asks npm for each lab package by its own name, with the window the runner expects', () => {
    const codex = NPM_LAB_RECIPES.find((r) => r.id === 'npm-codex')!
    expect(codex.url({ now: NOW, newest: null })).toBe(
      'https://api.npmjs.org/downloads/range/2025-05-13:2026-11-03/@openai/codex',
    )
    expect(codex.url({ now: NOW, newest: '2026-11-02' })).toBe(
      'https://api.npmjs.org/downloads/range/2026-10-26:2026-11-03/@openai/codex',
    )
    expect(NPM_LAB_RECIPES.some((r) => r.company === 'xai')).toBe(false)
  })

  it('reads PyPI downloads without mirrors', () => {
    const obs = extractPypiDownloads(pypiAnthropic, 'anthropic')
    expect(obs).toHaveLength(210)
    expect(obs.at(-1)).toMatchObject({ key: 'anthropic', date: '2026-11-03', value: 8_599_385 })
    expect(() => extractPypiDownloads('{"data":[]}', 'anthropic')).toThrow(/without_mirrors/)
    expect(PYPI_LAB_RECIPES.find((r) => r.company === 'xai')!.url({ now: NOW, newest: null })).toBe(
      'https://pypistats.org/api/packages/xai-sdk/overall?mirrors=false',
    )
  })
})

describe('GitHub agent pull requests', () => {
  it('counts the day before the run, and only a complete search', () => {
    const recipe = githubPrRecipe('t', 'anthropic', 'Test', 'author:app/copilot-swe-agent')
    expect(decodeURIComponent(recipe.url({ now: NOW, newest: null }))).toBe(
      'https://api.github.com/search/issues?q=is:pr author:app/copilot-swe-agent created:2026-11-03&per_page=1',
    )
    expect(recipe.extract(githubCount, { date: '2026-11-03' })).toEqual([
      { key: 'Test', date: '2026-11-02', value: 1815, payload: {} },
    ])
    expect(() =>
      extractSearchCount('{"total_count":9,"incomplete_results":true}', 'Test', '2026-11-02'),
    ).toThrow(/incomplete/)
  })

  it('carries one recipe per lab agent, each searching what that agent leaves', () => {
    expect(GITHUB_AGENT_RECIPES.map((r) => [r.id, r.company])).toEqual([
      ['github-prs-claude-code', 'anthropic'],
      ['github-prs-codex', 'openai'],
      ['github-prs-jules', 'google'],
    ])
    for (const r of GITHUB_AGENT_RECIPES)
      expect(needsGithubToken(r.url({ now: NOW, newest: null })))
  })

  it('is skipped without a token, and sends it to the search API only', async () => {
    const calls: { url: string; authorization: string | null }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(githubCount, { status: 200 })
    }) as typeof globalThis.fetch
    const app = {
      secContactEmail: '',
      appUrl: 'https://example.test',
      fetch,
      sleep: async () => {},
    }
    const search = { source_id: 's', url: 'https://api.github.com/search/issues?q=x', ext: 'json' }
    const other = { source_id: 'o', url: 'https://api.github.com/repos/a/b', ext: 'json' }

    expect(await createFetcher(app)(search)).toEqual({
      ok: false,
      status: null,
      detail: GITHUB_TOKEN_UNSET,
      skipped: true,
    })
    expect(calls).toHaveLength(0)

    const keyed = createFetcher({ ...app, githubToken: ' gh-test ' })
    expect((await keyed(search)).ok).toBe(true)
    expect((await keyed(other)).ok).toBe(true)
    expect(calls).toEqual([
      { url: search.url, authorization: 'Bearer gh-test' },
      { url: other.url, authorization: null },
    ])
  })
})

describe('Epoch AI data centers', () => {
  it('reads every site, multi-line source fields and all, with owner and users verbatim', () => {
    const sites = extractSites(epochSites, { date: '2026-11-04' })
    expect(sites).toHaveLength(96)
    expect(sites.find((s) => s.key === 'Colossus 2')).toMatchObject({
      date: '2026-11-04',
      value: 946,
      payload: {
        owner: 'SpaceXAI #confident',
        users: 'Anthropic #confident, Cursor #confident, SpaceXAI #confident',
      },
    })
  })

  it('reads each dated estimate and marks the ones after the run as projected', () => {
    const rows = extractTimelines(epochTimelines, { date: '2026-11-04' })
    expect(rows).toHaveLength(575)
    expect(rows.filter((r) => r.payload.projected)).toHaveLength(94)
    expect(
      rows.find((r) => r.key === 'QTS Eagle Mountain' && r.date === '2027-07-01'),
    ).toMatchObject({ value: 411, payload: { h100e: 346_968.16574027285, projected: true } })
  })

  it('fails on a renamed column rather than storing blanks', () => {
    const renamed = epochSites.replace('Current power (MW)', 'Power now (MW)')
    expect(() => extractSites(renamed, { date: '2026-11-04' })).toThrow(/Current power/)
  })
})

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      { a: 'x, y', b: 'say "hi"\nthere' },
    ])
  })

  it('refuses a ragged row or an open quote', () => {
    expect(() => parseCsv('a,b\n1\n')).toThrow(/fields/)
    expect(() => parseCsv('a\n"open\n')).toThrow(/unterminated/)
  })
})

describe('registry', () => {
  it('runs every new recipe once, under a unique id', () => {
    const ids = RECIPES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      'ramp-ai-index',
      'npm-claude-code',
      'pypi-xai-sdk',
      'github-prs-jules',
      'epoch-data-center-timelines',
    ]) {
      expect(ids).toContain(id)
    }
  })
})
