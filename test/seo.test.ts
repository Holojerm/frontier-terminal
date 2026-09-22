// The SEO/AEO layer: URL identity, structured data, and the two crawler files.
//
// All of it is pure functions on purpose. The failure mode for SEO code is that
// it is silently wrong for months — nothing throws when a canonical URL grows a
// trailing slash or a sitemap goes empty. These tests are the only thing that
// notices.

import { describe, expect, it } from 'vitest'

import {
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemap,
  crawlerCacheControl,
  llmsTxtResponse,
  sitemapResponse,
  AI_CRAWLERS,
  CRAWLER_CACHE_CONTROL,
  DEGRADED_CACHE_CONTROL,
} from '../server/utils/seo'
import type { SiteContext } from '../shared/utils/schema'
import { canonicalRedirect } from '../shared/utils/site'
import {
  articleSchema,
  breadcrumbSchema,
  dataCatalogSchema,
  datasetSchema,
  jsonLdGraph,
  organizationSchema,
  webPageSchema,
  websiteSchema,
} from '../shared/utils/schema'
import { DATA_LICENSE } from '../shared/utils/license'
import { absoluteUrl, canonicalPath, escapeXml, normalizeOrigin } from '../shared/utils/site'

const SITE: SiteContext = {
  appName: 'Frontier Terminal',
  appUrl: 'https://example.com',
  repoUrl: 'https://github.com/Holojerm/frontier-terminal',
}

describe('canonicalPath', () => {
  it('collapses the spellings of one page to a single URL', () => {
    // Every one of these is the same page. If they canonicalise differently,
    // the ranking for that page is split across them.
    expect(canonicalPath('/filings')).toBe('/filings')
    expect(canonicalPath('/filings/')).toBe('/filings')
    expect(canonicalPath('/filings///')).toBe('/filings')
    expect(canonicalPath('/filings?ref=twitter')).toBe('/filings')
    expect(canonicalPath('/filings#latest')).toBe('/filings')
    expect(canonicalPath('/filings/?utm_source=x#latest')).toBe('/filings')
  })

  it('keeps the root as a bare slash', () => {
    expect(canonicalPath('/')).toBe('/')
    expect(canonicalPath('')).toBe('/')
  })

  it('adds the leading slash a relative path is missing', () => {
    expect(canonicalPath('filings')).toBe('/filings')
  })
})

describe('absoluteUrl', () => {
  it('joins without doubling the slash, however appUrl was written', () => {
    expect(absoluteUrl('https://example.com', '/filings')).toBe('https://example.com/filings')
    expect(absoluteUrl('https://example.com/', '/filings')).toBe('https://example.com/filings')
    expect(absoluteUrl('https://example.com///', '/filings')).toBe('https://example.com/filings')
  })

  it('renders the root without a trailing slash', () => {
    expect(absoluteUrl('https://example.com', '/')).toBe('https://example.com')
  })

  it('returns empty when no origin is configured', () => {
    // A relative canonical is treated as self-referential and ignored, so the
    // caller must be able to tell there is nothing worth emitting.
    expect(absoluteUrl('', '/filings')).toBe('')
    expect(absoluteUrl(undefined, '/filings')).toBe('')
  })
})

describe('normalizeOrigin / escapeXml', () => {
  it('strips trailing slashes and survives undefined', () => {
    expect(normalizeOrigin('https://example.com//')).toBe('https://example.com')
    expect(normalizeOrigin(undefined)).toBe('')
  })

  it('escapes the five XML entities', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  // A headline is written by the judge model and a title comes from a vendor
  // page; either can carry a byte XML 1.0 cannot spell, and one of those in
  // one entry makes the whole feed unparseable.
  it('drops the control characters XML 1.0 forbids, keeping tab/newline/return', () => {
    const vertical = String.fromCharCode(0x0b)
    const nul = String.fromCharCode(0)
    expect(escapeXml(`a${vertical}b${nul}c`)).toBe('abc')
    expect(escapeXml('tab\tnl\ncr\r')).toBe('tab\tnl\ncr\r')
  })

  // The `u` flag is load-bearing: without it the surrogate range in the strip
  // pattern eats both halves of every astral character.
  it('keeps astral characters whole and drops a lone surrogate', () => {
    const rocket = String.fromCodePoint(0x1f680)
    expect(escapeXml(`ship ${rocket} it`)).toBe(`ship ${rocket} it`)
    expect(escapeXml(`lone${String.fromCharCode(0xd800)}x`)).toBe('lonex')
  })
})

describe('jsonLdGraph', () => {
  it('drops null nodes so a builder can decline without the caller branching', () => {
    const parsed = JSON.parse(jsonLdGraph([{ '@type': 'Thing' }, null, undefined]))
    expect(parsed['@graph']).toHaveLength(1)
  })

  it('escapes < so a value cannot close the script tag it is embedded in', () => {
    // The realistic path here is an appName or a description containing markup.
    const json = jsonLdGraph([{ '@type': 'Thing', name: '</script><script>alert(1)</script>' }])
    expect(json).not.toContain('</script>')
    expect(json).toContain('\\u003c')
    // Still valid JSON carrying the original text — escaped, not mangled.
    expect(JSON.parse(json)['@graph'][0].name).toBe('</script><script>alert(1)</script>')
  })
})

describe('organizationSchema / websiteSchema / webPageSchema', () => {
  it('anchors the organization at a stable @id, named after the site', () => {
    const node = organizationSchema(SITE)
    expect(node?.['@id']).toBe('https://example.com/#organization')
    expect(node?.name).toBe('Frontier Terminal')
  })

  it('links the website to its publisher', () => {
    expect(websiteSchema(SITE)?.publisher).toEqual({ '@id': 'https://example.com/#organization' })
  })

  it('returns null with no origin, rather than emitting relative @ids', () => {
    expect(organizationSchema({ ...SITE, appUrl: '' })).toBeNull()
    expect(websiteSchema({ ...SITE, appUrl: '' })).toBeNull()
    expect(
      webPageSchema({ ...SITE, appUrl: '' }, { url: '', title: 't', description: 'd' }),
    ).toBeNull()
    expect(breadcrumbSchema({ ...SITE, appUrl: '' }, [{ name: 'Home', path: '/' }])).toBeNull()
  })

  it('points the organization at the repo, which is the only other place it exists', () => {
    expect(organizationSchema(SITE)?.sameAs).toEqual([
      'https://github.com/Holojerm/frontier-terminal',
    ])
    expect(organizationSchema({ ...SITE, repoUrl: '' })).not.toHaveProperty('sameAs')
  })

  it('links a page back to the site graph', () => {
    const node = webPageSchema(SITE, {
      url: 'https://example.com/filings',
      title: 'Filings',
      description: 'SEC filings.',
    })
    expect(node?.isPartOf).toEqual({ '@id': 'https://example.com/#website' })
  })

  it('carries the poll tick as dateModified, and omits the field rather than faking it', () => {
    const page = { url: 'https://example.com/prices', title: 'Prices', description: 'Prices.' }
    expect(
      webPageSchema(SITE, { ...page, dateModified: '2026-09-22T06:00:00Z' })?.dateModified,
    ).toBe('2026-09-22T06:00:00Z')
    // A page whose data has never been fetched must not claim a date. A
    // dateModified that is always present and always "now" is the thing that
    // teaches a crawler to discard the field entirely.
    expect(webPageSchema(SITE, { ...page, dateModified: null })).not.toHaveProperty('dateModified')
    expect(webPageSchema(SITE, page)).not.toHaveProperty('dateModified')
  })

  it('numbers a breadcrumb trail from 1 with absolute items', () => {
    const node = breadcrumbSchema(SITE, [
      { name: 'Home', path: '/' },
      { name: 'Filings', path: '/filings/' },
    ])
    expect(node?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com' },
      { '@type': 'ListItem', position: 2, name: 'Filings', item: 'https://example.com/filings' },
    ])
  })
})

describe('datasetSchema / dataCatalogSchema', () => {
  const TABLE = {
    url: 'https://example.com/data',
    slug: 'prices_latest',
    name: 'Frontier Terminal — prices_latest',
    description: 'Every SKU currently listed.',
    dateModified: '2026-09-22T06:00:00Z',
    temporalCoverage: '2026-01-01/..',
    variableMeasured: ['input_per_mtok', 'output_per_mtok'],
    rows: 412,
    distribution: [
      { encodingFormat: 'text/csv', contentUrl: 'https://example.com/export/prices_latest.csv' },
    ],
  }

  it('gives sibling datasets on one page distinct @ids', () => {
    expect(datasetSchema(SITE, TABLE)?.['@id']).toBe(
      'https://example.com/data#dataset-prices_latest',
    )
    // A page carrying exactly one dataset needs no slug.
    expect(datasetSchema(SITE, { ...TABLE, slug: undefined })?.['@id']).toBe(
      'https://example.com/data#dataset',
    )
  })

  it('files every dataset in the one catalog and under the stated license', () => {
    const node = datasetSchema(SITE, TABLE)
    expect(node?.includedInDataCatalog).toEqual({ '@id': 'https://example.com/data#data-catalog' })
    expect(node?.license).toBe(DATA_LICENSE.url)
    expect(node?.isAccessibleForFree).toBe(true)
    expect(dataCatalogSchema(SITE, { description: 'Everything.' })?.['@id']).toBe(
      'https://example.com/data#data-catalog',
    )
  })

  it('turns a download into a DataDownload with a real contentUrl', () => {
    expect(datasetSchema(SITE, TABLE)?.distribution).toEqual([
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/csv',
        contentUrl: 'https://example.com/export/prices_latest.csv',
      },
    ])
  })

  it('omits every optional field rather than emitting an empty one', () => {
    // An empty variableMeasured or a zero-length distribution is a claim that
    // the dataset measures nothing and can't be downloaded — worse than silence.
    const bare = datasetSchema(SITE, {
      url: 'https://example.com/prices/claude-opus',
      name: 'n',
      description: 'd',
      variableMeasured: [],
      distribution: [],
      dateModified: null,
      temporalCoverage: null,
      rows: null,
    })
    for (const field of [
      'variableMeasured',
      'distribution',
      'dateModified',
      'temporalCoverage',
      'size',
    ]) {
      expect(bare).not.toHaveProperty(field)
    }
  })

  it('returns null with no origin', () => {
    expect(datasetSchema({ ...SITE, appUrl: '' }, TABLE)).toBeNull()
    expect(dataCatalogSchema({ ...SITE, appUrl: '' }, { description: 'd' })).toBeNull()
  })
})

describe('articleSchema', () => {
  const ALERT = {
    url: 'https://example.com/alerts/abc',
    headline: 'Anthropic cut Opus output pricing',
    description: 'Output per million tokens fell from $75 to $60.',
    datePublished: '2026-09-20T12:00:00Z',
    citation: [
      'https://anthropic.com/pricing',
      'https://anthropic.com/pricing',
      'https://openai.com/api/pricing',
    ],
  }

  it('attributes the piece to the site organization and dates it', () => {
    const node = articleSchema(SITE, ALERT)
    expect(node?.author).toEqual({ '@id': 'https://example.com/#organization' })
    expect(node?.datePublished).toBe('2026-09-20T12:00:00Z')
    // An append-only row was never revised; the two dates agreeing is the truth.
    expect(node?.dateModified).toBe('2026-09-20T12:00:00Z')
  })

  it('dedupes citations — several change rows routinely share one source URL', () => {
    expect(articleSchema(SITE, ALERT)?.citation).toEqual([
      'https://anthropic.com/pricing',
      'https://openai.com/api/pricing',
    ])
  })

  it('omits citation entirely when there is nothing to cite', () => {
    expect(articleSchema(SITE, { ...ALERT, citation: [] })).not.toHaveProperty('citation')
    expect(articleSchema({ ...SITE, appUrl: '' }, ALERT)).toBeNull()
  })
})

describe('buildSitemap', () => {
  const PAGE = {
    path: '/filings',
    changefreq: 'daily' as const,
    priority: '0.8',
    lastmod: '2026-08-22',
  }
  const RECORD = {
    path: '/provider/openai',
    changefreq: 'daily' as const,
    priority: '0.5',
    lastmod: '2026-06-18',
  }
  const BASE = { appUrl: 'https://example.com', indexable: true, entries: [PAGE, RECORD] }

  it('gives each entry its own lastmod rather than one build date', () => {
    // A crawler that sees every URL change on every deploy stops believing any
    // of them, so an entry that knows its real revision date has to be able to
    // say it.
    const xml = buildSitemap(BASE)
    expect(xml).toContain('<loc>https://example.com/provider/openai</loc>')
    expect(xml).toContain('<lastmod>2026-06-18</lastmod>')
    expect(xml).toContain('<lastmod>2026-08-22</lastmod>')
    expect(xml.match(/<url>/g)).toHaveLength(2)
  })

  it('emits well-formed but empty XML when there is nothing to publish', () => {
    // Empty, never broken: a malformed sitemap is a crawl error that lingers in
    // Search Console, while an empty one is simply a true statement.
    for (const input of [
      { ...BASE, entries: [] },
      { ...BASE, indexable: false },
      { ...BASE, appUrl: '' },
    ]) {
      const xml = buildSitemap(input)
      expect(xml).toContain('<urlset')
      expect(xml).not.toContain('<url>')
    }
  })

  it('escapes the location and never doubles the origin slash', () => {
    const xml = buildSitemap({
      ...BASE,
      appUrl: 'https://example.com/',
      entries: [{ ...PAGE, path: '/search?q=a&b' }],
    })
    expect(xml).not.toContain('example.com//')
    expect(xml).toContain('<loc>https://example.com/search</loc>')
  })

  it('escapes every value in the row, not just the URL', () => {
    // `lastmod` looks like it cannot contain markup, but nothing enforces its
    // shape at runtime once a dynamic entry is built from a database row. One
    // `<` there would break the document for every crawler, not just for the
    // row that caused it.
    const xml = buildSitemap({
      ...BASE,
      entries: [{ ...PAGE, lastmod: '2026-06-18<!--', priority: '0.5 & up' }],
    })
    expect(xml).toContain('<lastmod>2026-06-18&lt;!--</lastmod>')
    expect(xml).toContain('<priority>0.5 &amp; up</priority>')
    expect(xml).not.toContain('<!--')
  })
})

describe('the crawler files when a dynamic query fails', () => {
  // Both routes deliberately keep serving when a query feeding them cannot be
  // read: a document missing its dynamic URLs beats a 500. The danger is the
  // second half of that decision. A crawler cannot tell "the query failed" from
  // "the pages were deleted", so serving the degraded answer with the usual
  // one-hour public cache turns a momentary D1 blip into an hour of Google
  // believing the pages were removed.
  //
  // These assert the pairing at the only seam a test can reach. The routes
  // themselves cannot be imported here (the pool has no Nitro auto-imports),
  // which is exactly why every decision they make was moved into the two
  // functions below.
  const PAGES = [
    {
      path: '/filings',
      changefreq: 'daily' as const,
      priority: '0.8',
      title: 'Filings',
      summary: 'Every SEC filing by a tracked lab, with its source URL.',
    },
  ]
  const DYNAMIC = [
    {
      path: '/provider/openai',
      changefreq: 'daily' as const,
      priority: '0.5',
      lastmod: '2026-06-18',
    },
  ]
  const SITEMAP = {
    appUrl: 'https://example.com',
    indexable: true,
    buildDate: '2026-08-22',
    pages: PAGES,
    dynamic: DYNAMIC,
  }
  const LLMS = {
    appName: 'Frontier Terminal',
    appUrl: 'https://example.com',
    description: 'Tracking the frontier AI labs.',
    pages: PAGES,
  }

  it('caches sitemap.xml for an hour only when the dynamic list is trustworthy', () => {
    expect(sitemapResponse({ ...SITEMAP, complete: true }).cacheControl).toBe(CRAWLER_CACHE_CONTROL)
    const degraded = sitemapResponse({ ...SITEMAP, dynamic: [], complete: false })
    expect(degraded.cacheControl).toBe(DEGRADED_CACHE_CONTROL)
    // Still a real document — the static pages survive the query going dark.
    expect(degraded.body).toContain('<loc>https://example.com/filings</loc>')
    expect(degraded.body).not.toContain('/provider/')
  })

  it('stamps static pages with the build date', () => {
    const { body } = sitemapResponse({ ...SITEMAP, complete: true })
    expect(body).toContain('<lastmod>2026-08-22</lastmod>')
    expect(body).toContain('<lastmod>2026-06-18</lastmod>')
  })

  it('applies the same rule to llms.txt', () => {
    expect(llmsTxtResponse({ ...LLMS, complete: true }).cacheControl).toBe(CRAWLER_CACHE_CONTROL)
    expect(llmsTxtResponse({ ...LLMS, complete: false }).cacheControl).toBe(DEGRADED_CACHE_CONTROL)
  })

  it('names the two cache policies once, so a route cannot invent a third', () => {
    expect(crawlerCacheControl(true)).toBe('public, max-age=3600')
    expect(crawlerCacheControl(false)).toBe('no-store')
  })
})

describe('buildLlmsTxt', () => {
  const INPUT = {
    appName: 'Frontier Terminal',
    appUrl: 'https://example.com/',
    description: 'Tracking the frontier AI labs.',
    pages: [
      {
        path: '/',
        changefreq: 'daily' as const,
        priority: '1.0',
        title: 'Overview',
        summary: 'What the terminal tracks.',
      },
    ],
  }

  it('is a map, not a mirror: one link plus one sentence per page', () => {
    const text = buildLlmsTxt(INPUT)
    expect(text).toContain('# Frontier Terminal')
    expect(text).toContain('> Tracking the frontier AI labs.')
    expect(text).toContain('- [Overview](https://example.com): What the terminal tracks.')
    expect(text).toContain('Not investment advice.')
  })

  it('omits the Pages heading when nothing is declared public', () => {
    expect(buildLlmsTxt({ ...INPUT, pages: [] })).not.toContain('## Pages')
  })

  it('names the bulk tables so a model can fetch numbers instead of rendering prose', () => {
    const text = buildLlmsTxt({
      ...INPUT,
      tables: [{ name: 'prices_latest', description: 'Every SKU currently listed.' }],
    })
    expect(text).toContain(
      '- [prices_latest](https://example.com/export/prices_latest.csv): Every SKU currently listed. Also JSON at https://example.com/export/prices_latest.json.',
    )
    expect(text).toContain('https://example.com/alerts.xml')
  })

  it('omits the Data heading rather than printing an empty one', () => {
    expect(buildLlmsTxt(INPUT)).not.toContain('## Data')
    expect(buildLlmsTxt({ ...INPUT, tables: [] })).not.toContain('## Data')
  })

  it('states the terms and the exact attribution line a reuser should copy', () => {
    const text = buildLlmsTxt({
      ...INPUT,
      repoUrl: 'https://github.com/Holojerm/frontier-terminal',
    })
    expect(text).toContain('## License')
    expect(text).toContain(DATA_LICENSE.url)
    // The string we ask for, not one the reuser has to compose.
    expect(text).toContain(
      'Attribution: Source: Frontier Terminal (https://example.com). Licensed under CC BY 4.0.',
    )
    expect(text).toContain('https://github.com/Holojerm/frontier-terminal')
    expect(text).toContain('https://example.com/license')
  })
})

describe('buildRobotsTxt', () => {
  const BASE = { appUrl: 'https://example.com', indexable: true, allowAiCrawlers: true }

  it('disallows everything when not indexable or when no origin is configured', () => {
    for (const input of [
      { ...BASE, indexable: false },
      { ...BASE, appUrl: '' },
    ]) {
      const text = buildRobotsTxt(input)
      expect(text).toContain('Disallow: /\n')
      expect(text).not.toContain('Sitemap:')
    }
  })

  it('keeps crawlers off the API and points them at the sitemap', () => {
    const text = buildRobotsTxt(BASE)
    expect(text).toContain('Allow: /')
    expect(text).toContain('Disallow: /api/')
    expect(text).toContain('Sitemap: https://example.com/sitemap.xml')
  })

  it('names every answer-engine crawler and flips them all with one flag', () => {
    const allowed = buildRobotsTxt(BASE)
    const blocked = buildRobotsTxt({ ...BASE, allowAiCrawlers: false })
    for (const { agent } of AI_CRAWLERS) {
      expect(allowed).toContain(`User-agent: ${agent}\nAllow: /`)
      expect(blocked).toContain(`User-agent: ${agent}\nDisallow: /`)
    }
  })
})

describe('canonicalRedirect', () => {
  const origin = 'https://frontierterm.com'
  const get = (host: string, path = '/pricing') => ({ method: 'GET', host, path })

  it('moves page requests off the workers.dev origin', () => {
    expect(canonicalRedirect(origin, get('frontier-terminal.jeremy-ettlinger.workers.dev'))).toBe(
      'https://frontierterm.com/pricing',
    )
    expect(canonicalRedirect(origin, get('www.frontierterm.com', '/?ref=x'))).toBe(
      'https://frontierterm.com/?ref=x',
    )
  })

  it('serves the canonical host as-is', () => {
    expect(canonicalRedirect(origin, get('frontierterm.com'))).toBeNull()
    expect(canonicalRedirect(origin, get('FrontierTerm.com'))).toBeNull()
  })

  it('leaves /api, /mcp and non-GET requests where they are', () => {
    const host = 'frontier-terminal.jeremy-ettlinger.workers.dev'
    expect(canonicalRedirect(origin, get(host, '/api/status'))).toBeNull()
    expect(canonicalRedirect(origin, get(host, '/mcp'))).toBeNull()
    expect(canonicalRedirect(origin, { method: 'POST', host, path: '/' })).toBeNull()
  })

  it('ignores hosts that are not ours and an unset origin', () => {
    expect(canonicalRedirect(origin, get('evil.example'))).toBeNull()
    expect(canonicalRedirect('', get('x.workers.dev'))).toBeNull()
  })
})
