// The sitemap URLs that exist only as rows, as a public page source. Enumerated
// from D1 with each URL's own lastmod: a SKU's is the date of its newest
// observation; a filing's is the date it was filed.
//
// Alert permalinks are left out. They were 915 of 1,632 URLs, each a short
// page restating a change already on its axis page, so they spent crawl budget
// the lab, price and compare pages need. Crawlers still reach them through the
// feed and the pages that link them.
//
// No llmsHeading on purpose: llms.txt stays a static map (llmsTxtInput in
// crawler-pages.ts, shared with the MCP `describe` tool) and never wakes D1.

import { filingPath, revenueFilings } from '../../shared/utils/terminal-filings'

import type { PublicPageSource } from '#server/utils/public-pages'

import { queryPriceKeys, sitemapPriceKeys } from './terminal-prices'
import { terminalPayload } from './terminal-handler'
import { queryRevenue } from './terminal-revenue'

export const terminalPagesSource: PublicPageSource = {
  key: 'terminal',
  list: async (db) => {
    const [skus, revenue] = await Promise.all([
      queryPriceKeys(db),
      // Through the KV entry /api/revenue fills, so the sitemap lists exactly
      // the filings the page's own fetch will find.
      terminalPayload('revenue', (ctx) => queryRevenue(db, ctx)),
    ])
    return [
      ...sitemapPriceKeys(skus).map((sku) => ({
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
  },
}
