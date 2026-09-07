// GET /llms.txt
//
// The llmstxt.org convention: one Markdown file at a fixed path that tells a
// model what this site is and which URLs are worth fetching. robots.txt says
// what a crawler *may* read; llms.txt says what is worth reading.
//
// Worth having even though nothing is obligated to fetch it. It costs one
// generated route, it is derived from the same `definePageMeta({ publicPage })`
// declarations as sitemap.xml — so it cannot drift out of date on its own — and
// the alternative is letting a model infer the shape of the site from whichever
// page it happened to land on.
//
// Suppressed on non-indexable deploys for the same reason robots.txt is.

import { llmsTxtResponse } from '../utils/seo'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')

  if (!config.public.appUrl || config.public.indexable === false) {
    setResponseStatus(event, 404)
    return 'Not found\n'
  }

  const { body, cacheControl } = llmsTxtResponse({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    description: config.public.appDescription,
    pages: config.publicPages ?? [],
    complete: true,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
