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
import {
  breadcrumbSchema,
  jsonLdGraph,
  organizationSchema,
  webPageSchema,
  websiteSchema,
} from '../shared/utils/schema'
import { absoluteUrl, canonicalPath, escapeXml, normalizeOrigin } from '../shared/utils/site'

const SITE: SiteContext = {
  appName: 'Frontier Terminal',
  appUrl: 'https://example.com',
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

  it('links a page back to the site graph', () => {
    const node = webPageSchema(SITE, {
      url: 'https://example.com/filings',
      title: 'Filings',
      description: 'SEC filings.',
    })
    expect(node?.isPartOf).toEqual({ '@id': 'https://example.com/#website' })
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
