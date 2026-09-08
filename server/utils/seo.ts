// Bodies for /robots.txt, /sitemap.xml and /llms.txt, as pure functions.
//
// Split out of the routes so they can be asserted directly (test/seo.test.ts)
// rather than by booting a Worker and parsing text. These three files are the
// only place the app tells crawlers what it wants, and they are exactly the
// kind of thing that breaks silently — nobody notices a wrong robots.txt until
// traffic is already gone.

import type { PublicPage } from '#shared/utils/site'
import { absoluteUrl, escapeXml, normalizeOrigin } from '#shared/utils/site'

/**
 * The crawlers behind answer engines and model training, named explicitly.
 *
 * They are listed rather than left to `User-agent: *` for one reason: a policy
 * you can read is a policy you can change. Whoever forks this should be able to
 * see which bots they are admitting and flip one flag, instead of discovering
 * months later that a wildcard made the decision for them.
 *
 * `purpose` is documentation for that decision, not something robots.txt emits.
 */
export const AI_CRAWLERS: { agent: string; purpose: string }[] = [
  { agent: 'GPTBot', purpose: 'OpenAI — model training' },
  { agent: 'OAI-SearchBot', purpose: 'OpenAI — ChatGPT Search index' },
  { agent: 'ChatGPT-User', purpose: 'OpenAI — fetches a page a user linked' },
  { agent: 'ClaudeBot', purpose: 'Anthropic — model training' },
  { agent: 'Claude-SearchBot', purpose: 'Anthropic — search index' },
  { agent: 'Claude-User', purpose: 'Anthropic — fetches a page a user linked' },
  { agent: 'PerplexityBot', purpose: 'Perplexity — search index' },
  { agent: 'Perplexity-User', purpose: 'Perplexity — fetches a page a user linked' },
  { agent: 'Google-Extended', purpose: 'Google — Gemini training and AI Overviews grounding' },
  { agent: 'Applebot-Extended', purpose: 'Apple — model training' },
  { agent: 'meta-externalagent', purpose: 'Meta — model training' },
  { agent: 'Bytespider', purpose: 'ByteDance — model training' },
  { agent: 'CCBot', purpose: 'Common Crawl — corpus most open models train on' },
]

/** Paths no crawler should spend budget on: the JSON API and the MCP endpoint are not pages. */
const DISALLOWED = ['/api/', '/mcp']

export interface RobotsInput {
  appUrl: string
  indexable: boolean
  allowAiCrawlers: boolean
}

export function buildRobotsTxt(input: RobotsInput): string {
  const appUrl = normalizeOrigin(input.appUrl)

  // A preview build has no business in a search index — and worse, an indexed
  // preview URL competes with production for the same content. Same when no
  // canonical origin is configured: without one the Sitemap line would be
  // unresolvable anyway.
  if (!input.indexable || !appUrl) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n')
  }

  const lines = ['User-agent: *', 'Allow: /', ...DISALLOWED.map((path) => `Disallow: ${path}`), '']

  lines.push(
    input.allowAiCrawlers
      ? '# Answer engines and model crawlers are allowed on the public pages.'
      : '# Answer engines and model crawlers are blocked (NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false).',
  )

  for (const { agent } of AI_CRAWLERS) {
    lines.push(`User-agent: ${agent}`)
    if (input.allowAiCrawlers) {
      lines.push('Allow: /', ...DISALLOWED.map((path) => `Disallow: ${path}`))
    } else {
      lines.push('Disallow: /')
    }
    lines.push('')
  }

  lines.push(`Sitemap: ${appUrl}/sitemap.xml`, '')
  return lines.join('\n')
}

/** One `<url>` in sitemap.xml. `lastmod` is per-entry — see below. */
export interface SitemapEntry {
  path: string
  changefreq: PublicPage['changefreq']
  priority: string
  /** `YYYY-MM-DD`. */
  lastmod: string
}

export interface SitemapInput {
  appUrl: string
  indexable: boolean
  entries: SitemapEntry[]
}

const EMPTY_SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'

/**
 * /sitemap.xml.
 *
 * `lastmod` arrives per entry rather than being stamped here, so a URL that
 * knows its own revision date (a data page keyed on a fetch timestamp) can say
 * so. A static page has only the build date — the honest per-page alternative
 * is git history, which CI clones shallowly (nuxt.config.ts › runtimeConfig.buildDate).
 * Telling a crawler that an unchanged page changed today is how a site teaches
 * Google to ignore its lastmod entirely.
 *
 * An empty but well-formed document rather than a 404 when there is nothing to
 * publish: a broken sitemap is a crawl error, an empty one is a fact.
 */
export function buildSitemap(input: SitemapInput): string {
  const appUrl = normalizeOrigin(input.appUrl)

  // No canonical origin means every <loc> would be relative, which is invalid.
  // Preview deploys are suppressed for the same reason robots.txt is.
  if (!appUrl || !input.indexable || input.entries.length === 0) return EMPTY_SITEMAP

  // Every value is escaped, including the three that "cannot" contain markup.
  // `changefreq` and `priority` come from a typed page declaration and
  // `lastmod` is shaped like a date, but escaping the whole row costs nothing
  // and means a hand-edited value can never produce a sitemap that fails to parse.
  const urls = input.entries
    .map((entry) => {
      const loc = escapeXml(absoluteUrl(appUrl, entry.path))
      const lastmod = escapeXml(entry.lastmod)
      const changefreq = escapeXml(entry.changefreq)
      const priority = escapeXml(entry.priority)
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
}

/** What a complete crawler document may be cached for. One hour. */
export const CRAWLER_CACHE_CONTROL = 'public, max-age=3600'

/** What an incomplete one may be cached for. Nothing. */
export const DEGRADED_CACHE_CONTROL = 'no-store'

/**
 * Cache-Control for sitemap.xml and llms.txt, given whether the document is
 * complete.
 *
 * The pairing is the point, and getting it wrong is worse than not degrading at
 * all. If a D1 query feeding either document fails, the route still serves — a
 * document missing its dynamic URLs beats a 500. But "the URLs are missing" and
 * "the URLs were deleted" are the same bytes to a crawler, so caching that
 * answer publicly for an hour turns a five-second D1 blip into an hour of
 * Google believing the pages were removed. `no-store` makes the degraded
 * document exactly as durable as the failure that produced it.
 *
 * Applies only to degradation, not to suppression: an empty sitemap on a
 * non-indexable deploy is a deliberate, stable answer and stays cacheable.
 */
export function crawlerCacheControl(complete: boolean): string {
  return complete ? CRAWLER_CACHE_CONTROL : DEGRADED_CACHE_CONTROL
}

/** A crawler document plus how long it may be believed. */
export interface CrawlerDocument {
  body: string
  cacheControl: string
}

export interface SitemapResponseInput {
  appUrl: string
  indexable: boolean
  /** `runtimeConfig.buildDate` — the lastmod every static page shares. */
  buildDate: string
  /** Collected from `definePageMeta({ publicPage })` at build time. */
  pages: PublicPage[]
  /** URLs with no route-table entry — one per dynamic record, with its own lastmod. */
  dynamic?: SitemapEntry[]
  /** False when a query feeding `dynamic` failed — see crawlerCacheControl(). */
  complete: boolean
}

/**
 * Everything /sitemap.xml decides, as one function of plain data.
 *
 * The route is deliberately left with nothing but config reads and two
 * assignments. That is not tidiness: the bug this shape prevents is a degraded
 * document going out with the cacheable header, which is invisible in review
 * (two adjacent, individually-correct lines) and cannot be reached by a test
 * as long as it lives inside `defineEventHandler` — the vitest pool has no
 * Nitro auto-imports.
 */
export function sitemapResponse(input: SitemapResponseInput): CrawlerDocument {
  const entries: SitemapEntry[] = [
    ...input.pages.map((page) => ({
      path: page.path,
      changefreq: page.changefreq,
      priority: page.priority,
      lastmod: input.buildDate,
    })),
    ...(input.dynamic ?? []),
  ]

  return {
    body: buildSitemap({ appUrl: input.appUrl, indexable: input.indexable, entries }),
    cacheControl: crawlerCacheControl(input.complete),
  }
}

export interface LlmsTxtInput {
  appName: string
  appUrl: string
  /** One-paragraph description of the site, used as the blockquote. */
  description: string
  pages: PublicPage[]
}

/**
 * /llms.txt — the llmstxt.org convention: a short, stable, Markdown map of the
 * site for a model that has limited context and no patience for navigation.
 *
 * It is a map, not a mirror. Every line is a link plus one sentence saying what
 * is behind it, so a model can decide what to fetch rather than guessing from a
 * rendered page full of buttons. Duplicating the pages' actual content here
 * would create a second copy to keep in sync, and a stale number in a
 * machine-readable file is worse than no file.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const appUrl = normalizeOrigin(input.appUrl)
  const sections: string[] = [`# ${input.appName}`, '', `> ${input.description}`, '']

  if (input.pages.length > 0) {
    sections.push('## Pages', '')
    for (const page of input.pages) {
      sections.push(`- [${page.title}](${absoluteUrl(appUrl, page.path)}): ${page.summary}`)
    }
    sections.push('')
  }

  sections.push(
    '## Agents',
    '',
    `- [MCP endpoint](${appUrl}/mcp): read-only tools over the same data — overview, prices and price history, hiring and its history, releases, incidents, demand share, alerts, coverage, status — with provenance on every row. Streamable HTTP, no auth. \`claude mcp add --transport http frontier-terminal ${appUrl}/mcp\``,
    '',
    '## About',
    '',
    '- Not investment advice. Every figure carries the URL it was read from and when.',
    '- Structured data for each page is published as schema.org JSON-LD in the page head.',
    '',
  )

  return sections.join('\n')
}

/**
 * Everything /llms.txt decides once it has chosen to answer at all.
 *
 * The same shape as `sitemapResponse()`, and for the same reason: the pairing
 * of a possibly-degraded body with its Cache-Control is the part worth testing,
 * and it cannot be tested inside the route. Suppression (no origin, or a
 * non-indexable deploy) stays in the route, because that is a 404 rather than
 * a document.
 */
export function llmsTxtResponse(input: LlmsTxtInput & { complete: boolean }): CrawlerDocument {
  return {
    body: buildLlmsTxt(input),
    cacheControl: crawlerCacheControl(input.complete),
  }
}
