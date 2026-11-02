// The sitemap URLs that exist only as rows, as a public page source. Enumerated
// from D1 with each URL's own lastmod: an alert row is append-only, so its
// created_at is exact; a SKU's is the date of its newest observation; a
// filing's is the date it was filed.
//
// No llmsHeading on purpose: llms.txt stays a static map (llmsTxtInput in
// crawler-pages.ts, shared with the MCP `describe` tool) and never wakes D1.

import { filingPath, revenueFilings } from '../../shared/utils/terminal-filings'
import { alertPath } from '../../shared/utils/terminal-tiers'

import type { PublicPageSource } from '#server/utils/public-pages'

import { alertPermalinks, queryPriceKeys } from './terminal-db'
import { terminalPayload } from './terminal-handler'
import { queryRevenue } from './terminal-revenue'

export const terminalPagesSource: PublicPageSource = {
  key: 'terminal',
  list: async (db) => {
    const [alerts, skus, revenue] = await Promise.all([
      alertPermalinks(db),
      queryPriceKeys(db),
      // Through the KV entry /api/revenue fills, so the sitemap lists exactly
      // the filings the page's own fetch will find.
      terminalPayload('revenue', (ctx) => queryRevenue(db, ctx)),
    ])
    return [
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
  },
}
