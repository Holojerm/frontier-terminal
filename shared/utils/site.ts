// Origin and URL helpers, shared by `app/` and `server/`.
//
// Lives in `shared/` because both halves need the same answer: the composable
// that writes <link rel="canonical"> in the browser and the Nitro route that
// writes <loc> into sitemap.xml must agree on what a page's URL is, or you
// publish two spellings of the same page and split its ranking between them.
//
// Everything here is pure — no runtime config, no request context — so the
// rules are testable without booting Nuxt (see test/seo.test.ts).

/** Strip trailing slashes so `appUrl` + path never produces a double slash. */
export function normalizeOrigin(url: string | undefined): string {
  return (url || '').replace(/\/+$/, '')
}

/**
 * The canonical spelling of a route path: leading slash, no trailing slash, no
 * query string, no hash. `/pricing/?ref=x` and `/pricing` are one page, and
 * only one of them belongs in a canonical tag or a sitemap.
 */
export function canonicalPath(path: string): string {
  const [withoutHash = ''] = path.split('#')
  const [withoutQuery = ''] = withoutHash.split('?')
  const trimmed = withoutQuery.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * Absolute URL for a route path. Returns an empty string when no origin is
 * configured — callers skip the tag entirely rather than emitting a relative
 * canonical, which crawlers treat as self-referential and ignore.
 */
export function absoluteUrl(origin: string | undefined, path = '/'): string {
  const base = normalizeOrigin(origin)
  if (!base) return ''
  const route = canonicalPath(path)
  return route === '/' ? base : `${base}${route}`
}

/**
 * Characters XML 1.0 has no spelling for — not even as a numeric reference.
 * Tab, newline and carriage return are the three C0 codes it does allow;
 * everything else below 0x20, the lone surrogates, and the two non-characters
 * at the end of the BMP make a document a parser must reject (XML 1.0 §2.2).
 *
 * This matters because the strings reaching escapeXml are not ours: an alert
 * headline is written by the judge model, a page title comes from a vendor.
 * One stray 0x0B in one entry would make the whole feed unreadable to every
 * reader at once, which is a strange way to lose an alerting channel. Dropped
 * rather than replaced: these carry no meaning to drop.
 */
// oxlint-disable-next-line no-control-regex -- matching the control range is the job
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu

/** XML/HTML text escape, for hand-built sitemap and JSON-LD payloads. */
export function escapeXml(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * One public page, as declared on the page itself via
 * `definePageMeta({ publicPage: … })` (see app/types/seo.d.ts), collected at
 * build time by the `pages:extend` hook in nuxt.config.ts.
 *
 * Two consumers, one declaration: sitemap.xml renders the crawl hints, and
 * llms.txt renders the summary. A page is public because it says so, not
 * because someone remembered to add it to a list in a second file.
 */
export interface PublicPage {
  path: string
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  priority: string
  /** Human title for llms.txt. */
  title: string
  /** One sentence, for llms.txt — what a model would find on this page. */
  summary: string
}

/**
 * Where a request should be redirected so that only one origin serves pages,
 * or null to serve it as-is.
 *
 * The Worker answers on *.workers.dev and on the custom domain; a canonical
 * tag tells crawlers which one counts, but a visitor who bookmarked the old
 * origin still lands on it. Only GET/HEAD page requests move: a 301 turns a
 * POST into a GET at the new location, which would break an MCP client or the
 * judge routine still configured with the workers.dev origin, so /api and
 * /mcp are left alone until every caller has been repointed.
 */
export function canonicalRedirect(
  origin: string | undefined,
  request: { method: string; host: string; path: string },
): string | null {
  const base = normalizeOrigin(origin)
  if (!base) return null
  let canonicalHost: string
  try {
    canonicalHost = new URL(base).host
  } catch {
    return null
  }
  const host = request.host.toLowerCase()
  if (host === canonicalHost) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (
    request.path.startsWith('/api/') ||
    request.path === '/api' ||
    request.path.startsWith('/mcp')
  ) {
    return null
  }
  // Only the origins this Worker is known to answer on. A stray Host header
  // from a scanner is not a reason to bounce it somewhere.
  const ours = host.endsWith('.workers.dev') || host === `www.${canonicalHost}`
  if (!ours) return null
  return `${base}${request.path}`
}
