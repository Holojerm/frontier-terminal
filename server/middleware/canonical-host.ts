// One origin for pages. The rule itself is `canonicalRedirect` in
// shared/utils/site.ts, kept pure so test/seo.test.ts can pin it down; this
// file only feeds it the request.
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const url = getRequestURL(event)
  const target = canonicalRedirect(config.public.appUrl, {
    method: event.method,
    host: url.host,
    path: url.pathname + url.search,
  })
  if (target) return sendRedirect(event, target, 301)
})
