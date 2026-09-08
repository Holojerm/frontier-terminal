# SEO and AEO

The `useSeo()` one-call-per-page contract, how `publicPage` meta feeds both `sitemap.xml` and `llms.txt`, and the structured-data rules.

> **Load this when:** adding or editing a page, writing structured data, or changing crawler behaviour.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

- **Every page calls `useSeo()` exactly once.** It is the only thing that emits
  `<link rel="canonical">`, Open Graph, Twitter cards, and JSON-LD. `bun run seo:check`
  (part of `bun run ci`) fails the build on a page that skips it or that calls
  `useSeoMeta()`/`useHead()` to set SEO tags directly.
- **Public pages declare themselves**: `definePageMeta({ publicPage: { changefreq, priority, title, summary } })`.
  That one declaration is what puts a page in **both** `sitemap.xml` and `llms.txt` —
  there is no list to update. A page without it is in neither, which is the right
  default. `noindex: true` and `publicPage` are mutually exclusive and the gate enforces it.
- **A dynamic route cannot reach either file that way.** The collecting hook skips any path
  containing `:`, because `/provider/[slug]` is one pattern rather than N URLs. Enumerate those
  server-side in `server/routes/sitemap.xml.get.ts` and pass them as `dynamic` entries with a
  real per-URL `lastmod` — `sitemapResponse()` in `server/utils/seo.ts` takes them. The page
  still declares `publicPage` (the gate's invariant is per-page), with a comment saying the
  values are inert.
- **Never write JSON-LD for content that isn't rendered.** Structured data describing
  invisible content is a manual-action risk with Google and a lie an answer engine will repeat.
- **Numbers go into schema as numbers**, never display strings — a price is `12` and `USD`,
  not `'$12'`.
- Structured-data builders live in `shared/utils/schema.ts` and are pure functions of a
  `SiteContext` — add a node type there, unit-test it in `test/seo.test.ts`, then pass it via
  `useSeo({ schema: [...] })`.
- `NUXT_PUBLIC_INDEXABLE=false` makes robots.txt disallow everything, every page render
  `noindex`, and sitemap/llms.txt go empty. `NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false`
  blocks the named answer-engine crawlers (`server/utils/seo.ts` › `AI_CRAWLERS`); it defaults
  to **true** because the data is public and sourced, and being quotable is distribution.
