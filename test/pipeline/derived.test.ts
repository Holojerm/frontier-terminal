import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import type { FilingRow } from '../../server/pipeline/contracts'
import {
  deriveSources,
  derivedSourceId,
  openAiPricedSlugs,
  parseDerivedSourcesBlock,
  resolvedFilers,
} from '../../server/pipeline/derived'
import type { FetchOutcome, SourceFetcher } from '../../server/pipeline/fetch'
import { derivedKeyOf, laneFor } from '../../server/pipeline/lanes'
import { parseOpenAiModelPage } from '../../server/pipeline/parsers/pricing/openai-model-page'
import {
  filerNameOf,
  parsePendingFilersBlock,
  resolveFilers,
} from '../../server/pipeline/parsers/sec/pending-filers'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { sourceIdsForScope } from '../../server/pipeline/scopes'
import { includeSources } from '../../server/pipeline/sources'
import { terminalStamp } from '../../server/utils/terminal-cache'
import { queryContext, queryCoverage, queryPrices } from '../../server/utils/terminal-db'
import { queryRevenue } from '../../server/utils/terminal-revenue'
import { labelOf } from '../../server/utils/terminal-sources'
import { fixtureText, manifest } from './fixtures'

// The two things the store derives for itself: a lab's CIK from its own S-1
// (and the feeds that follow from it), and the OpenAI per-model pages from
// the pricing page. Pure halves first, then the refresh end-to-end against
// the workerd D1 with a fetcher that serves the derived URLs.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const pending = parsePendingFilersBlock(sourcesYaml)
const ALL = includeSources(sourcesYaml, manifest.fixtures)

const prov = {
  source_url: 'https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&forms=S-1',
  fetched_at: '2026-09-22T04:00:00Z',
}
const hit = (form: string, name: string, cik: string, date: string, adsh: string): FilingRow => ({
  accession_no: adsh,
  form,
  file_date: date,
  ciks: [cik],
  display_names: [`${name}  (CIK ${cik})`],
  whitelist_cik: null,
  ...prov,
})

describe('pending_filers', () => {
  it('reads the patterns and the exclusion list', () => {
    expect(pending.filers).toEqual([
      { provider: 'anthropic', name_pattern: '^Anthropic\\b' },
      { provider: 'openai', name_pattern: '^OpenAI\\b' },
    ])
    expect(pending.exclude).toContain('Fund')
    expect(pending.exclude).toContain('Acquisition')
  })

  it('reads the filer name off EDGAR’s display name', () => {
    expect(filerNameOf('SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)')).toBe(
      'SPACE EXPLORATION TECHNOLOGIES CORP',
    )
    expect(filerNameOf('Anthropic, PBC  (CIK 0009999999)')).toBe('Anthropic, PBC')
  })

  it('resolves from the earliest S-1-family hit whose filer matches; funds, mentions and Form D never do', () => {
    const rows = [
      hit('S-1', 'Cerebras Systems Inc.', '0001111111', '2026-05-01', '0000000000-26-000001'), // mentions Anthropic in text
      hit('S-1/A', 'Anthropic, PBC', '0009999999', '2026-10-03', '0000000000-26-000003'),
      hit('S-1', 'Anthropic, PBC', '0009999999', '2026-10-01', '0000000000-26-000002'),
      hit('S-1', 'Anthropic Capital Fund, LP', '0001931731', '2026-09-01', '0000000000-26-000000'),
      hit('D', 'OpenAI Startup Fund II, L.P.', '0002133720', '2026-08-26', '0000000000-26-000009'),
      hit('S-1', 'OpenAI Acquisition Corp.', '0008888888', '2026-09-15', '0000000000-26-000008'),
    ]
    const out = resolveFilers(rows, pending, new Set())
    expect(out).toEqual([
      {
        provider: 'anthropic',
        cik: '0009999999',
        name: 'Anthropic, PBC',
        resolved_form: 'S-1',
        resolved_accession: '0000000000-26-000002',
        resolved_file_date: '2026-10-01',
        ...prov,
      },
    ])
    // A lab the audited file already tags is never re-resolved.
    expect(resolveFilers(rows, pending, new Set(['anthropic']))).toEqual([])
  })

  it('refuses a drifted block', () => {
    expect(() =>
      parsePendingFilersBlock('pending_filers:\n  mistral:\n    name_pattern: x\n'),
    ).toThrow('unknown provider')
    expect(() =>
      parsePendingFilersBlock('pending_filers:\n  openai:\n    name_pattern: (\n'),
    ).toThrow()
    expect(() => parsePendingFilersBlock('sources:\n')).toThrow('no pending_filers block')
  })
})

describe('derived_sources', () => {
  it('reads the three templates with their caveat', () => {
    const templates = parseDerivedSourcesBlock(sourcesYaml)
    expect(templates.map((t) => [t.id, t.from])).toEqual([
      ['edgar-submissions', 'filer'],
      ['edgar-companyfacts', 'filer'],
      ['openai-model-md', 'openai-priced-model'],
    ])
    expect(templates[2]!.url).toBe('https://developers.openai.com/api/docs/models/{slug}.md')
    expect(templates[2]!.caveat).toContain('must equal the slug')
    expect(templates[0]!.caveat).toBeNull()
  })

  it('names lanes and keys by prefix, and labels derived ids by template', () => {
    expect(laneFor('edgar-companyfacts-anthropic')).toBeDefined()
    expect(laneFor('openai-model-md-gpt-5.6-sol')).toBeDefined()
    expect(laneFor('nothing-here')).toBeUndefined()
    expect(derivedKeyOf('openai-model-md-gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(derivedKeyOf('edgar-submissions-spcx')).toBeNull() // registered, not derived
    expect(labelOf('edgar-companyfacts-anthropic').label).toBe(
      'EDGAR XBRL company facts (anthropic, resolved filer)',
    )
    expect(labelOf('openai-model-md-gpt-5.6-sol')).toEqual({
      label: 'OpenAI model page (gpt-5.6-sol)',
      role: 'primary',
    })
  })
})

describe('the OpenAI model page parser', () => {
  it('reads the window, the cutoff and the $/MTok prices; refuses a page for another slug', () => {
    const text = fixtureText('fixtures/pricing/openai-model-gpt-5.6-sol.md')
    const { rows } = parseOpenAiModelPage(text, 'gpt-5.6-sol')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'openai',
      model_slug: 'gpt-5.6-sol',
      tier: null,
      context_window: '1,050,000',
      input_per_mtok: 4,
      cached_input_per_mtok: 0.4,
      output_per_mtok: 20,
      notes: 'Feb 16, 2026 knowledge cutoff',
    })
    expect(() => parseOpenAiModelPage(text, 'gpt-5.6-terra')).toThrow(
      'model page is for gpt-5.6-sol, derived for gpt-5.6-terra',
    )
    expect(() => parseOpenAiModelPage('# Nothing\n', null)).toThrow('Model ID')
  })
})

// ── end to end ──────────────────────────────────────────────────────────────

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-09-22T04:00:00Z')
const now = () => new Date((tick += 1000))
const run = (ids: readonly string[], fetcher: SourceFetcher, scope: 'edgar' | 'survey' = 'edgar') =>
  runRefresh({ db, raw, fetcher, sourcesYaml, now }, scope, ids)

const ANTHROPIC_CIK = '0009999999'

/** The committed fixtures by URL, plus the derived URLs a resolved Anthropic and the model pages need. */
function fetcher(overrides: Record<string, string | FetchOutcome> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  // SpaceX's real feeds with the CIK rewritten stand in for Anthropic's.
  const spcxSubs = fixtureText('fixtures/sec/edgar-submissions-spcx.json').replace(
    '"cik":"0001181412"',
    `"cik":"${ANTHROPIC_CIK}"`,
  )
  const spcxFacts = fixtureText('fixtures/sec/edgar-companyfacts-spcx.json').replace(
    '"cik":"0001181412"',
    `"cik":"${ANTHROPIC_CIK}"`,
  )
  byUrl.set(`https://data.sec.gov/submissions/CIK${ANTHROPIC_CIK}.json`, spcxSubs)
  byUrl.set(`https://data.sec.gov/api/xbrl/companyfacts/CIK${ANTHROPIC_CIK}.json`, spcxFacts)
  const modelPage = fixtureText('fixtures/pricing/openai-model-gpt-5.6-sol.md')
  return async (source) => {
    const override = overrides[source.source_id]
    if (override !== undefined && typeof override !== 'string') return override
    let text = override ?? byUrl.get(source.url)
    // Every other derived model page: the sol page with its id rewritten.
    const m = source.url.match(/\/models\/([^/]+)\.md$/)
    if (text === undefined && m) text = modelPage.replaceAll('gpt-5.6-sol', m[1]!)
    if (text === undefined) return { ok: false, status: 404, detail: 'HTTP 404' }
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const ftsWithAnthropicS1 = () => {
  const doc = JSON.parse(fixtureText('fixtures/sec/edgar-fts.json')) as {
    hits: { hits: unknown[] }
  }
  const s1 = {
    _source: {
      adsh: '0001628280-26-777777',
      form: 'S-1',
      file_date: '2026-10-01',
      ciks: [ANTHROPIC_CIK],
      display_names: [`Anthropic, PBC  (CIK ${ANTHROPIC_CIK})`],
    },
  }
  return JSON.stringify({ ...doc, hits: { ...doc.hits, hits: [s1, ...doc.hits.hits] } })
}

const ctx = async () =>
  queryContext(sourcesYaml, await terminalStamp(db), () => new Date('2026-09-22T12:00:00Z'))

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
  tick = Date.parse('2026-09-22T04:00:00Z')
})

describe('CIK resolution end to end', () => {
  it('an S-1 by a pending lab resolves its CIK, alerts critical, and derives its feeds for the next tick', async () => {
    // Baseline: the committed FTS fixtures resolve nobody.
    const ids = sourceIdsForScope('edgar', ALL)
    expect(ids).toContain('edgar-fts-openai')
    await run(ids, fetcher())
    expect(await resolvedFilers(db)).toEqual([])
    expect(await deriveSources(db, sourcesYaml)).toEqual([])

    // Anthropic files.
    const report = await run(['edgar-fts'], fetcher({ 'edgar-fts': ftsWithAnthropicS1() }))
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 2, alerts: 1 })
    expect(report.sources[0]!.detail).toBe(`resolved anthropic -> CIK ${ANTHROPIC_CIK}`)
    expect(await resolvedFilers(db)).toEqual([
      { provider: 'anthropic', cik: ANTHROPIC_CIK, name: 'Anthropic, PBC' },
    ])
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: 'cik-resolved', severity: 'critical' })
    expect(alert!.headline).toBe(
      `Anthropic, PBC filed S-1 (2026-10-01) — CIK ${ANTHROPIC_CIK} resolved for anthropic`,
    )
    expect(alert!.explanation).toContain('Accession 0001628280-26-777777')

    // The next tick knows two more sources, both in the edgar scope.
    const derived = await deriveSources(db, sourcesYaml)
    expect(derived).toEqual([
      {
        source_id: 'edgar-submissions-anthropic',
        url: `https://data.sec.gov/submissions/CIK${ANTHROPIC_CIK}.json`,
        ext: 'json',
      },
      {
        source_id: 'edgar-companyfacts-anthropic',
        url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${ANTHROPIC_CIK}.json`,
        ext: 'json',
      },
    ])
    const all = [...ALL, ...derived]
    const next = sourceIdsForScope('edgar', all)
    expect(next).toContain('edgar-companyfacts-anthropic')
    expect(sourceIdsForScope('survey', all)).toEqual(all.map((s) => s.source_id))

    const second = await run(next, fetcher())
    const byId = Object.fromEntries(second.sources.map((s) => [s.source_id, s]))
    expect(byId['edgar-submissions-anthropic']).toMatchObject({ status: 'baseline' })
    expect(byId['edgar-companyfacts-anthropic']).toMatchObject({ status: 'baseline' })
    expect(byId['edgar-companyfacts-anthropic']!.detail).toContain('4 entities')
    // The resolved CIK is whitelisted this tick: the facts land under anthropic as an issuer.
    const facts = (await db.select().from(schema.entities)).filter(
      (e) => e.source_id === 'edgar-companyfacts-anthropic',
    )
    expect(facts).toHaveLength(4)
    expect(facts.every((e) => e.provider === 'anthropic')).toBe(true)
    const filings = (await db.select().from(schema.entities)).filter(
      (e) => e.source_id === 'edgar-submissions-anthropic',
    )
    expect(filings.every((e) => JSON.parse(e.payload).whitelist_cik === ANTHROPIC_CIK)).toBe(true)

    // The FTS feed seen again with the S-1 (the tick in between re-read the
    // committed fixture): the lab is already resolved so the resolver leaves
    // it alone and the append-only lane records no removal. The one change is
    // the S-1 row itself gaining whitelist_cik — on the resolving tick the
    // CIK was not yet whitelisted — and a modified filing trips no floor.
    const again = await run(['edgar-fts'], fetcher({ 'edgar-fts': ftsWithAnthropicS1() }))
    expect(again.sources[0]).toMatchObject({
      status: 'ok',
      added: 0,
      modified: 1,
      removed: 0,
      alerts: 0,
    })
    expect(again.sources[0]!.detail).toBeNull()
    const flipped = (await db.select().from(schema.changes)).find(
      (c) => c.entity_key === 'filing:0001628280-26-777777' && c.change_type === 'modified',
    )!
    expect(JSON.parse(flipped.before_json!).whitelist_cik).toBeNull()
    expect(JSON.parse(flipped.after_json!).whitelist_cik).toBe(ANTHROPIC_CIK)
    expect(await db.select().from(schema.alerts)).toHaveLength(1)
    expect(await resolvedFilers(db)).toHaveLength(1)

    // /revenue: Anthropic is an issuer, resolved, with the filing it came from.
    const revenue = await queryRevenue(db, await ctx())
    const anthropic = revenue.providers.find((p) => p.provider === 'anthropic')!
    expect(anthropic.disclosure).toBe('issuer')
    expect(anthropic.filer).toMatchObject({
      ticker: null,
      cik: ANTHROPIC_CIK,
      relation: 'issuer',
      tagged_by: 'resolved',
      entity_name: 'SPACE EXPLORATION TECHNOLOGIES CORP.', // the stand-in facts payload names itself
      source_id: 'edgar-companyfacts-anthropic',
    })
    expect(anthropic.filer!.resolved_from).toEqual({
      form: 'S-1',
      accession_no: '0001628280-26-777777',
      file_date: '2026-10-01',
      filing_url: `https://www.sec.gov/Archives/edgar/data/${Number(ANTHROPIC_CIK)}/000162828026777777/`,
    })
    expect(anthropic.periods).toHaveLength(4)
    expect(anthropic.sources.map((s) => s.source_id)).toEqual([
      'edgar-companyfacts-anthropic',
      'edgar-submissions-anthropic',
    ])
    // xAI (tagged in the audited file) is untouched; OpenAI still has no disclosure.
    expect(revenue.providers.find((p) => p.provider === 'openai')!.disclosure).toBe('none')

    // Coverage lists the derived feeds after the registered ones, named by template.
    const coverage = await queryCoverage(db, await ctx())
    const derivedRows = coverage.sources.filter((s) => s.derived_from)
    expect(derivedRows.map((s) => [s.source_id, s.derived_from, s.axis, s.provider])).toEqual([
      ['edgar-companyfacts-anthropic', 'edgar-companyfacts', 'revenue', 'anthropic'],
      ['edgar-submissions-anthropic', 'edgar-submissions', 'sec', 'anthropic'],
    ])
    expect(coverage.sources.filter((s) => !s.derived_from)).toHaveLength(24)
  })
})

describe('OpenAI model pages end to end', () => {
  it('the pricing page derives one page per priced Standard SKU; the page row wins the catalog view with its window', async () => {
    await run(['openai-models-md', 'openai-pricing-md'], fetcher(), 'survey')
    const slugs = await openAiPricedSlugs(db)
    expect(slugs).toContain('gpt-5.6-sol')
    expect(slugs).toContain('gpt-4o-mini')
    expect(slugs).toHaveLength(37)
    const derived = await deriveSources(db, sourcesYaml)
    expect(derived.map((d) => d.source_id)).toEqual(
      slugs.map((s) => derivedSourceId('openai-model-md', s)),
    )
    expect(derived[0]!.ext).toBe('md')

    const report = await run(
      ['openai-model-md-gpt-5.6-sol', 'openai-model-md-gpt-4o-mini'],
      fetcher(),
      'survey',
    )
    expect(report.sources.map((s) => [s.source_id, s.status])).toEqual([
      ['openai-model-md-gpt-4o-mini', 'baseline'],
      ['openai-model-md-gpt-5.6-sol', 'baseline'],
    ])

    const prices = await queryPrices(db, await ctx())
    const sol = prices.rows.find((r) => r.entity_key === 'model:openai:gpt-5.6-sol')!
    expect(sol.source_id).toBe('openai-model-md-gpt-5.6-sol')
    expect(sol.context_window).toBe('1,050,000')
    expect(sol.input_per_mtok).toBe(4)
    expect(sol.also_listed_by).toEqual(['openai-models-md', 'openai-pricing-md'])
    expect(sol.source_url).toBe('https://developers.openai.com/api/docs/models/gpt-5.6-sol.md')
    // A page that is not for its slug fails the source, never stores under the wrong key.
    const wrong = await run(
      ['openai-model-md-gpt-5.6-terra'],
      fetcher({
        'openai-model-md-gpt-5.6-terra': fixtureText(
          'fixtures/pricing/openai-model-gpt-5.6-sol.md',
        ),
      }),
      'survey',
    )
    expect(wrong.sources[0]).toMatchObject({ status: 'failed' })
    expect(wrong.sources[0]!.detail).toBe(
      'model page is for gpt-5.6-sol, derived for gpt-5.6-terra',
    )
  })
})
