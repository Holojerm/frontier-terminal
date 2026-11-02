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
// filing pages (/filings/[accession]) are enumerated from D1 here, each with
// its own lastmod — an alert row is append-only, so its created_at is exact; a
// SKU's is the date of its newest observation; a filing's is the date it was
// filed. The data pages (/prices, /hiring, a lab page, …) are dated by
// their own newest change row (server/utils/seo.ts › dataLastmods), not the
// deploy. A failed query degrades to the static list, build-dated, with a
// no-store header (crawlerCacheControl) rather than a 500.

import { db } from '@nuxthub/db'

import { filingPath, revenueFilings } from '#layers/terminal/shared/utils/terminal-filings'
import { alertPath } from '#layers/terminal/shared/utils/terminal-tiers'

import { crawlerPages, labScopedPages } from '#layers/terminal/server/utils/crawler-pages'
import { dataLastmods, sitemapResponse, type SitemapEntry } from '../utils/seo'
import {
  alertPermalinks,
  queryDataFreshness,
  queryPriceKeys,
} from '#layers/terminal/server/utils/terminal-db'
import { terminalPayload } from '#layers/terminal/server/utils/terminal-handler'
import { queryRevenue } from '#layers/terminal/server/utils/terminal-revenue'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  let dynamic: SitemapEntry[] = []
  let lastmods: Record<string, string> = {}
  let complete = true
  try {
    const [alerts, skus, freshness, revenue] = await Promise.all([
      alertPermalinks(db),
      queryPriceKeys(db),
      queryDataFreshness(db),
      // Through the KV entry /api/revenue fills, so the sitemap lists exactly
      // the filings the page's own fetch will find.
      terminalPayload('revenue', (ctx) => queryRevenue(db, ctx)),
    ])
    lastmods = dataLastmods(freshness, labScopedPages())
    dynamic = [
      ...alerts.map((alert) => ({
        path: alertPath(alert.id),
        // Append-only rows never change; the ticker ranks below the alerts.
        changefreq: 'yearly' as const,
        priority: alert.tier === 'alert' ? '0.6' : '0.3',
        lastmod: alert.created_at.slice(0, 10),
      })),
      ...skus.map((sku) => ({
        path: `/prices/${sku.entity_key}`,
        changefreq: 'daily' as const,
        priority: '0.6',
        lastmod: sku.lastmod,
      })),
      ...revenueFilings(revenue).map((filing) => ({
        path: filingPath(filing.accession_no),
        // A filing is fixed once filed; a later restatement is marked on it,
        // but the reported values never change.
        changefreq: 'yearly' as const,
        priority: '0.6',
        lastmod: filing.filed,
      })),
    ]
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'sitemap_dynamic_failed', error: String(error) }))
    complete = false
  }

  const { body, cacheControl } = sitemapResponse({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    buildDate: config.buildDate,
    lastmods,
    pages: crawlerPages(config.publicPages),
    dynamic,
    complete,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
