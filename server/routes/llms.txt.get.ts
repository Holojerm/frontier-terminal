// GET /llms.txt
//
// The llmstxt.org convention: a Markdown map of the site for a model with a
// limited context window, at a fixed well-known path.
//
// Worth having even though nothing is obligated to fetch it. It costs one
// generated route, it is derived from the same `definePageMeta({ publicPage })`
// declarations as sitemap.xml — so it cannot drift out of date on its own — and
// the alternative is letting a model infer the shape of the site from whichever
// page it happened to land on.
//
// The bulk tables and the licence are named here as well as on their pages: a
// model that wants the numbers rather than the prose should be able to find
// /export/prices_latest.csv and learn the terms it may be reused under without
// rendering anything.
//
// Suppressed on non-indexable deploys for the same reason robots.txt is.

import manifest from '../../fleet.json'
import { llmsTxtResponse } from '../utils/seo'
import { EXPORT_TABLES } from '../utils/terminal-export'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')

  if (config.public.indexable === false || !config.public.appUrl) {
    setResponseStatus(event, 404)
    return 'Not found\n'
  }

  const { body, cacheControl } = llmsTxtResponse({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    description: config.public.appDescription,
    pages: config.publicPages ?? [],
    tables: Object.values(EXPORT_TABLES).map((table) => ({
      name: table.name,
      description: table.description,
    })),
    repoUrl: manifest.links.github ?? '',
    complete: true,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
