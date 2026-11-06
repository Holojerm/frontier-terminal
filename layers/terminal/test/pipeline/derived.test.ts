import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { FilingRow } from '../../server/pipeline/contracts'
import {
  deriveSources,
  derivedSourceId,
  googlePricedSlugs,
  openAiPricedSlugs,
  parseDerivedSourcesBlock,
  resolvedFilers,
} from '../../server/pipeline/derived'
import type { FetchOutcome, SourceFetcher } from '../../server/pipeline/fetch'
import { derivedKeyOf, laneFor } from '../../server/pipeline/lanes'
import { parseGoogleModelPage } from '../../server/pipeline/parsers/pricing/google-model-page'
import { parseOpenAiModelPage } from '../../server/pipeline/parsers/pricing/openai-model-page'
import {
  filerNameOf,
  parsePendingFilersBlock,
  resolveFilers,
} from '../../server/pipeline/parsers/sec/pending-filers'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { CAREERS_SOURCES, sourceIdsForScope } from '../../server/pipeline/scopes'
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
      parsePendingFilersBlock('pending_filers:\n  cohere:\n    name_pattern: x\n'),
    ).toThrow('unknown provider')
    expect(() =>
      parsePendingFilersBlock('pending_filers:\n  openai:\n    name_pattern: (\n'),
    ).toThrow()
    expect(() => parsePendingFilersBlock('sources:\n')).toThrow('no pending_filers block')
  })
})

describe('derived_sources', () => {
  it('reads the eight templates with their caveat', () => {
    const templates = parseDerivedSourcesBlock(sourcesYaml)
    expect(templates.map((t) => [t.id, t.from])).toEqual([
      ['edgar-submissions', 'filer'],
      ['edgar-companyfacts', 'filer'],
      ['xbrl-segment', 'segment-filing'],
      ['filing-index', 'registration-filing'],
      ['prospectus-revenue', 'registration-document'],
      ['openai-model-md', 'openai-priced-model'],
      ['google-model-md', 'google-priced-model'],
      ['openai-misalignment-report', 'openai-misalignment-report'],
    ])
    expect(templates[7]!.url).toBe('https://alignment.openai.com/misalignment-reports/{slug}/')
    expect(templates[7]!.caveat).toContain('Discovery / Discovered / Discovery date')
    expect(templates[6]!.url).toBe('https://aistudio.google.com/docs/models/{slug}.md')
    expect(templates[6]!.caveat).toContain('reads as absent')
    expect(templates[5]!.url).toBe('https://developers.openai.com/api/docs/models/{slug}.md')
    expect(templates[5]!.caveat).toContain('must equal the slug')
    expect(templates[4]!.caveat).toContain('tags no financial XBRL')
    expect(templates[3]!.caveat).toContain('primary document')
    expect(templates[2]!.caveat).toContain('not the lab')
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
    expect(laneFor('google-model-md-gemini-4-argon')).toBeDefined()
    expect(derivedKeyOf('google-model-md-gemini-4-argon')).toBe('gemini-4-argon')
    expect(labelOf('google-model-md-gemini-4-argon').label).toBe(
      'Google model page (gemini-4-argon)',
    )
  })
})

describe('the Google model page parser', () => {
  it('reads the unified context window and keeps the whole token-limits cell as the note', () => {
    const text = fixtureText('fixtures/pricing/google-model-gemini-4-argon.md')
    const { rows } = parseGoogleModelPage(text, 'gemini-4-argon')
    expect(rows).toEqual([
      {
        provider: 'google',
        model_slug: 'gemini-4-argon',
        tier: 'standard',
        context_window: '1,048,576',
        input_per_mtok: null,
        cached_input_per_mtok: null,
        output_per_mtok: null,
        currency: 'USD',
        effective_from: null,
        effective_until: null,
        notes:
          'Context window (unified input and output token limit) 1,048,576 Max output 65,536 (default synchronous) / up to 1,048,576 (with long decode)',
        source_url: 'https://aistudio.google.com/docs/models/gemini-4-argon.md',
        fetched_at: '2026-11-03T16:24:36Z',
      },
    ])
  })

  // Excerpt of the live gemini-robotics-er-2-preview page (2026-11-02): the
  // common "Input token limit" wording, and one page carrying two models.
  const robotics = [
    '### Gemini Robotics ER 2 Preview',
    '',
    '| Property | Description |',
    '|---|---|',
    '| Model code | `gemini-robotics-er-2-preview` |',
    '| Token limits^[\\[\\*\\]](https://ai.google.dev/gemini-api/docs/tokens)^ | **Input token limit** 131,072 **Output token limit** 65,536 |',
    '| Latest update | July 2026 |',
    '',
    '### Gemini Robotics ER 2 Streaming Preview',
    '',
    '| Property | Description |',
    '|---|---|',
    '| Model code | `gemini-robotics-er-2-streaming-preview` |',
    '| Token limits^[\\[\\*\\]](https://ai.google.dev/gemini-api/docs/tokens)^ | **Input token limit** 32,768 **Output token limit** 8,192 |',
    '',
  ].join('\n')

  it('reads the table whose model code is the derived slug; refuses a page for another slug', () => {
    const [row] = parseGoogleModelPage(robotics, 'gemini-robotics-er-2-streaming-preview').rows
    expect(row).toMatchObject({
      context_window: '32,768',
      notes: 'Input token limit 32,768 Output token limit 8,192',
    })
    expect(() => parseGoogleModelPage(robotics, 'gemini-2.5-pro')).toThrow(
      'model page is for gemini-robotics-er-2-preview, gemini-robotics-er-2-streaming-preview, derived for gemini-2.5-pro',
    )
    expect(() => parseGoogleModelPage('# Nothing\n', 'gemini-2.5-pro')).toThrow('Model code')
  })

  // Excerpt of the live AI Studio gemini-robotics-er-2-preview page
  // (2026-11-03): the Markdoc rendering, a bare `{% table %}` per model, and
  // the footnote as a plain link rather than inside `{% sup %}`.
  const markdocCard = (code: string, input: string) =>
    [
      '  {% table %}',
      '  * Property',
      '  * Description',
      '',
      '  ---',
      '',
      '  *   {% section class="model-property" %}',
      '  {% icon name="id_card" /%}Model code',
      '',
      '  {% /section %}',
      '',
      `  * \`${code}\``,
      '',
      '  ---',
      '',
      '  *   {% section class="model-property" %}',
      '  {% icon name="token_auto" /%}Token limits[[*]](/docs/tokens)',
      '',
      '  {% /section %}',
      '',
      `  *   **Input token limit** ${input}`,
      '',
      '  **Output token limit** 65,536',
      '',
      '  {% /table %}',
      '',
    ].join('\n')
  const roboticsMarkdoc =
    markdocCard('gemini-robotics-er-2-preview', '131,072') +
    markdocCard('gemini-robotics-er-1.6-preview', '32,768')

  it('reads the Markdoc rendering the same way, table by model code', () => {
    const [row] = parseGoogleModelPage(roboticsMarkdoc, 'gemini-robotics-er-1.6-preview').rows
    expect(row).toMatchObject({
      context_window: '32,768',
      notes: 'Input token limit 32,768 Output token limit 65,536',
    })
    expect(() => parseGoogleModelPage(roboticsMarkdoc, 'gemini-2.5-pro')).toThrow(
      'model page is for gemini-robotics-er-2-preview, gemini-robotics-er-1.6-preview, derived for gemini-2.5-pro',
    )
  })

  it('a card without a token-limits row stores no window rather than guessing one', () => {
    const page = '| Property | Description |\n|---|---|\n| Model code | `gemini-3.5-transcribe` |\n'
    expect(parseGoogleModelPage(page, 'gemini-3.5-transcribe').rows[0]).toMatchObject({
      context_window: null,
      notes: null,
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
  const googlePage = fixtureText('fixtures/pricing/google-model-gemini-4-argon.md')
  return async (source) => {
    const override = overrides[source.source_id]
    if (override !== undefined && typeof override !== 'string') return override
    let text = override ?? byUrl.get(source.url)
    // Every other derived model page: the sol (or argon) page with its id rewritten.
    // Both vendors end in /models/<slug>.md, so Google's host is matched first.
    const g = source.url.match(/^https:\/\/aistudio\.google\.com\/docs\/models\/([^/]+)\.md$/)
    if (text === undefined && g) text = googlePage.replaceAll('gemini-4-argon', g[1]!)
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
    schema.sourceStats,
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
    // The tick also carries the model catalogs (scopes.ts), so the OpenAI
    // model pages derive too; this test is about the EDGAR ones.
    const edgarOnly = (sources: Awaited<ReturnType<typeof deriveSources>>) =>
      sources.filter((s) => s.source_id.startsWith('edgar-'))
    expect(edgarOnly(await deriveSources(db, sourcesYaml))).toEqual([])

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
    const derived = edgarOnly(await deriveSources(db, sourcesYaml))
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
    expect(sourceIdsForScope('survey', all)).toEqual(
      all.map((s) => s.source_id).filter((id) => !CAREERS_SOURCES.includes(id)),
    )
    expect(sourceIdsForScope('survey', all)).toContain('edgar-companyfacts-anthropic')

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
    expect(coverage.sources.filter((s) => !s.derived_from)).toHaveLength(45)
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

  it('a derived page that 404s is absent, not failed — said once, and shown on the coverage panel', async () => {
    await run(['openai-models-md', 'openai-pricing-md'], fetcher(), 'survey')
    const missing = 'openai-model-md-gpt-4o-mini'
    const gone: FetchOutcome = { ok: false, status: 404, detail: 'HTTP 404' }

    // OpenAI prices SKUs whose model page it never published. That is a fact
    // about the catalogue, not breakage here, so it is its own status.
    const first = await run([missing], fetcher({ [missing]: gone }), 'survey')
    expect(first.sources[0]).toMatchObject({ status: 'absent', detail: 'HTTP 404' })
    expect((await db.select().from(schema.opsEvents)).map((o) => o.kind)).toEqual(['source_absent'])

    // Still absent next tick, and still absent the tick after: the mail is
    // for the transition, because five of these never change again.
    await run([missing], fetcher({ [missing]: gone }), 'survey')
    await run([missing], fetcher({ [missing]: gone }), 'survey')
    expect((await db.select().from(schema.opsEvents)).map((o) => o.kind)).toEqual(['source_absent'])

    // Keying the panel on snapshots hid these entirely — a 404 snapshots
    // nothing — so a reader could not see that the SKU has no page.
    const coverage = await queryCoverage(db, await ctx())
    const row = coverage.sources.find((c) => c.source_id === missing)
    expect(row).toBeDefined()
    expect(row!.newest_snapshot).toBeNull()
    expect(row!.snapshot_count).toBe(0)
    expect(row!.derived_from).toBe('openai-model-md')
    expect(row!.last_run).toMatchObject({ status: 'absent', detail: 'HTTP 404' })
    expect(row!.url).toBe('https://developers.openai.com/api/docs/models/gpt-4o-mini.md')
  })

  it('an audited url that 404s is still a failure — the audit recorded that it resolved', async () => {
    const report = await run(
      ['openai-pricing-md'],
      fetcher({ 'openai-pricing-md': { ok: false, status: 404, detail: 'HTTP 404' } }),
      'survey',
    )
    expect(report.sources[0]).toMatchObject({ status: 'failed' })
    expect((await db.select().from(schema.opsEvents)).map((o) => o.kind)).toContain('source_failed')
  })
})

describe('Google model pages end to end', () => {
  it('the pricing page derives one page per priced Standard SKU; every tier of the slug shows its window, citing the page', async () => {
    await run(['google-pricing-html'], fetcher(), 'survey')
    const slugs = await googlePricedSlugs(db)
    expect(slugs).toContain('gemini-2.5-pro')
    expect(slugs).toContain('gemini-embedding-001')
    // An untabbed table is the Standard tier: the Live and native-audio models get pages too.
    expect(slugs).toContain('gemini-2.5-flash-native-audio-preview-12-2025')
    expect(slugs).toContain('gemini-3.8-live')
    const derived = (await deriveSources(db, sourcesYaml)).filter((d) =>
      d.source_id.startsWith('google-model-md-'),
    )
    expect(derived.map((d) => d.source_id)).toEqual(
      slugs.map((s) => derivedSourceId('google-model-md', s)),
    )
    expect(derived[0]!.ext).toBe('md')

    const pro = 'google-model-md-gemini-2.5-pro'
    const report = await run([pro], fetcher(), 'survey')
    expect(report.sources.map((s) => [s.source_id, s.status])).toEqual([[pro, 'baseline']])

    const prices = await queryPrices(db, await ctx())
    const url = 'https://aistudio.google.com/docs/models/gemini-2.5-pro.md'
    const standard = prices.rows.find(
      (r) => r.entity_key === 'model:google:gemini-2.5-pro:standard',
    )!
    // The pricing page keeps the row — it carries the prices — and the
    // window it does not print is the model page's, cited as such.
    expect(standard.source_id).toBe('google-pricing-html')
    expect(standard.input_per_mtok).not.toBeNull()
    expect(standard.also_listed_by).toEqual([pro])
    expect(standard.context_window).toBe('1,048,576')
    expect(standard.context_window_source).toMatchObject({ source_id: pro, source_url: url })
    const batch = prices.rows.find((r) => r.entity_key === 'model:google:gemini-2.5-pro:batch')!
    expect(batch.context_window_source).toMatchObject({ source_id: pro, source_url: url })
    // No page fetched for this slug yet, so no window and nothing cited.
    const flash = prices.rows.find(
      (r) => r.entity_key === 'model:google:gemini-2.5-flash:standard',
    )!
    expect(flash.context_window).toBeNull()
    expect(flash.context_window_source).toBeNull()
    // The model page never becomes its own catalog row.
    expect(prices.rows.filter((r) => r.source_id === pro)).toEqual([])

    // A priced id Google wrote no page for is absent, not failed.
    const missing = 'google-model-md-gemini-embedding-001'
    const gone = await run(
      [missing],
      fetcher({ [missing]: { ok: false, status: 404, detail: 'HTTP 404' } }),
      'survey',
    )
    expect(gone.sources[0]).toMatchObject({ status: 'absent' })
    const coverage = await queryCoverage(db, await ctx())
    expect(coverage.sources.find((c) => c.source_id === missing)).toMatchObject({
      provider: 'google',
      axis: 'pricing-catalog',
      derived_from: 'google-model-md',
    })
  })
})
