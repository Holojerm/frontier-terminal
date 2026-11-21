// The sitemap URLs that exist only as rows, as a public page source: the filing pages,
// each dated the day it was filed.
//
// Alert permalinks and SKU pages are left out. They were 1,547 of 1,632 URLs: an alert
// restates a change already on its axis page, and a SKU page is one row of /prices over
// time. Listing them spent crawl budget the lab, price and compare pages need; crawlers
// still reach them through the pages that link them.
//
// No llmsHeading: llms.txt stays a static map (llmsTxtInput in crawler-pages.ts, shared
// with the MCP `describe` tool) and never wakes D1.

export const terminalPagesSource: PublicPageSource = {
  key: 'terminal',
  list: async (db) => {
    // Through the KV entry /api/revenue fills, so the sitemap lists exactly
    // the filings the page's own fetch will find.
    const revenue = await terminalPayload('revenue', (ctx) => queryRevenue(db, ctx))
    return revenueFilings(revenue).map((filing) => ({
      path: filingPath(filing.accession_no),
      // A filing is fixed once filed; a later restatement is marked on it,
      // but the reported values never change.
      changefreq: 'yearly' as const,
      priority: '0.6',
      lastmod: filing.filed,
    }))
  },
}
