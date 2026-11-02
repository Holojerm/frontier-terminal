// Tells core's crawler documents what only the terminal knows: the URLs that
// exist as rows (an alert permalink, a SKU, a revenue filing), and the one
// private path robots.txt should skip. Registered here so server/routes/
// sitemap.xml.get.ts and robots.txt.get.ts carry no product query (the registry
// is server/utils/public-pages.ts).
//
// The static pages (/prices, a lab page, a thesis) are not sources: they come
// from the route table and from crawler-pages.ts, and the sitemap route dates
// them from the freshness rows.

import { registerPublicPageSource, registerRobotsDisallow } from '#server/utils/public-pages'

import { terminalPagesSource } from '../utils/terminal-page-source'

export default defineNitroPlugin(() => {
  registerPublicPageSource(terminalPagesSource)
  // The MCP endpoint is not a page.
  registerRobotsDisallow(['/mcp'])
})
