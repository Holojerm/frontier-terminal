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
// Dynamic routes (`/provider/[slug]`) are the other half, and they cannot work
// that way: one route-table entry describes N URLs, so the hook skips them by
// design. When the pipeline adds them, query the records here and pass them as
// `dynamic` with a real per-URL `lastmod` — see sitemapResponse().

import { sitemapResponse } from '../utils/seo'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  const { body, cacheControl } = sitemapResponse({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    buildDate: config.buildDate,
    pages: config.publicPages ?? [],
    complete: true,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
