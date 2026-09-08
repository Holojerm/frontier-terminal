// GET /sitemap.xml
//
// The URL list is NOT maintained here. Static pages declare their own
// membership with `definePageMeta({ publicPage: … })`; the `pages:resolved`
// hook in nuxt.config.ts collects those at build time into
// `runtimeConfig.publicPages`, and this route renders whatever the route table
// actually contained.
//
// That indirection exists because a hand-kept array is a second place to
// remember. Add a page, ship it, and it is simply never in the sitemap —
// nothing fails, nobody notices. Now the page that exists is the page that
// gets listed, and `scripts/check-seo.ts` fails the build if an indexable page
// forgets to declare itself.
//
// Dynamic routes are the other half, and they cannot work that way: one
// route-table entry describes N URLs, so the hook skips them by design. The
// alert permalinks (/alerts/:id) are enumerated from D1 here, each with its
// own lastmod — an alert row is append-only, so its created_at is exact. A
// failed query degrades to the static list with a no-store header
// (server/utils/seo.ts › crawlerCacheControl) rather than a 500.

import { db } from '@nuxthub/db'

import { alertPath } from '#shared/utils/terminal-tiers'

import { sitemapResponse, type SitemapEntry } from '../utils/seo'
import { alertPermalinks } from '../utils/terminal-db'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  let dynamic: SitemapEntry[] = []
  let complete = true
  try {
    dynamic = (await alertPermalinks(db)).map((alert) => ({
      path: alertPath(alert.id),
      // Append-only rows never change; the ticker ranks below the alerts.
      changefreq: 'yearly',
      priority: alert.tier === 'alert' ? '0.6' : '0.3',
      lastmod: alert.created_at.slice(0, 10),
    }))
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'sitemap_dynamic_failed', error: String(error) }))
    complete = false
  }

  const { body, cacheControl } = sitemapResponse({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    buildDate: config.buildDate,
    pages: config.publicPages ?? [],
    dynamic,
    complete,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
