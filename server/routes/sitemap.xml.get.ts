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
// alert permalinks (/alerts/:id), the SKU pages (/prices/[key]) and the
// filing pages (/filings/[accession]) are registered as a public page source
// by the terminal layer (layers/terminal/server/utils/terminal-page-source.ts)
// and collected through server/utils/public-pages.ts, each with its own lastmod.
// The data pages (/prices, /hiring, a lab page, …) are dated by their own
// newest change row (server/utils/seo.ts › dataLastmods), not the deploy. A
// failed query degrades to the static list, build-dated, with a no-store header
// (crawlerCacheControl) rather than a 500.

import { db } from '@nuxthub/db'

import { crawlerPages, labScopedPages } from '#layers/terminal/server/utils/crawler-pages'
import { queryDataFreshness } from '#layers/terminal/server/utils/terminal-db'
import { collectPublicPages } from '../utils/public-pages'
import { dataLastmods, sitemapResponse } from '../utils/seo'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  let lastmods: Record<string, string> = {}
  let complete = true
  try {
    lastmods = dataLastmods(await queryDataFreshness(db), labScopedPages())
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'sitemap_dynamic_failed', error: String(error) }))
    complete = false
  }

  const dynamic = await collectPublicPages(db, { buildDate: config.buildDate })

  const { body, cacheControl } = sitemapResponse({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    buildDate: config.buildDate,
    lastmods,
    pages: crawlerPages(config.publicPages),
    dynamic: dynamic.entries,
    complete: complete && dynamic.complete,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
