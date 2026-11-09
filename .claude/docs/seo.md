# SEO and AEO

The `useSeo()` one-call-per-page contract, how `publicPage` meta feeds both `sitemap.xml` and `llms.txt`, and the structured-data rules.

> **Load this when:** adding or editing a page, writing structured data, or changing crawler behaviour.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

- **Every page calls `useSeo()` exactly once.** It is the only thing that emits
  `<link rel="canonical">`, Open Graph, Twitter cards, and JSON-LD. `bun run seo:check`
  (part of `bun run ci`) fails the build on a page that skips it or that calls
  `useSeoMeta()`/`useHead()` to set SEO tags directly.
- **Public pages declare themselves**: `definePageMeta({ publicPage: { changefreq, priority, title, summary } })`.
  That one declaration is what puts a page in **both** `sitemap.xml` and `llms.txt` —
  there is no list to update. A page without it is in neither, which is the right
  default. `noindex: true` and `publicPage` are mutually exclusive and the gate enforces it.
- **Every `publicPage` value is a literal.** Nuxt reads `definePageMeta` by static extraction;
  an imported constant makes it drop the whole key, and the page leaves both files with no
  error (`/theses` did, for a month). The gate fails a non-literal value.
- **The URL list crawlers see is `crawlerPages()`** in `layers/terminal/server/utils/crawler-pages.ts`: the
  route-table pages plus the lab and thesis pages. sitemap.xml, `/llms.txt`, and the MCP
  `describe` tool all read it, so the three cannot list different sites.
- **Sitemap `lastmod` for a data page is its newest change row**, not the deploy:
  `PAGE_ENTITY_TYPES` in `server/utils/seo.ts` maps each axis page to the `changes.entity_type`s
  it renders, a lab page reads its own provider's rows, and `/` and `/data` read everything.
  A new axis page adds its row there. Pages it cannot date keep the build date.
- **A dynamic route cannot reach either file that way.** The collecting hook skips any path
  containing `:`, because `/provider/[slug]` is one pattern rather than N URLs. Any set of URLs
  the app owns as data is registered, not hand-added to the routes: from a Nitro plugin,
  `registerPublicPageSource({ key, list(db, { buildDate }), llmsHeading?, defaults? })`
  (`server/utils/public-pages.ts`) puts each returned `{ path, title?, description?, lastmod? }`
  in `sitemap.xml` with its own `lastmod`. The alert, SKU and filing pages are one source,
  `layers/terminal/server/utils/terminal-page-source.ts`, registered by
  `layers/terminal/server/plugins/public-pages.ts`; it sets no `llmsHeading` because `/llms.txt`
  is a static map that never wakes D1. SKU pages go through `sitemapPriceKeys()`: every base SKU,
  but a tier variant (`:batch`, `:flex`, …) only once its price has a history, so templated
  near-duplicates are not most of the sitemap. A source that throws is logged, skipped, and makes the
  sitemap `no-store`. `registerRobotsDisallow(['/mcp'])` adds private paths to `robots.txt`.
  The page still declares `publicPage` (the gate's invariant is per-page), with a comment
  saying the values are inert.
- **Never write JSON-LD for content that isn't rendered.** Structured data describing
  invisible content is a manual-action risk with Google and a lie an answer engine will repeat.
- **Numbers go into schema as numbers**, never display strings — a price is `12` and `USD`,
  not `'$12'`.
- Structured-data builders live in `shared/utils/schema.ts` and are pure functions of a
  `SiteContext` — add a node type there, unit-test it in `test/seo.test.ts`, then pass it via
  `useSeo({ schema: [...] })`. A page building `@id`s calls `usePageUrl()` for the base rather
  than assembling the canonical a second time by hand.
- **A page showing data passes `dateModified`**: `Stamp.as_of`, the poll tick, never the render
  time. `useSeo()` must therefore be called *after* the `await useFetch` it reads from. Omit the
  field rather than fake it — a page that always claims to have changed today teaches a crawler
  to discard the field.
- **A table of rows is a `Dataset`, not prose that happens to contain numbers.** `/data` emits one
  `DataCatalog` plus one `datasetSchema()` per exportable table, built from the same
  `coverage.exports` the page renders; `/prices/[key]` emits one for the price series. Every
  `distribution` must be a URL that actually resolves — a 404 in a DataDownload is worse than
  omitting it.
- **An axis page whose table has an export emits its own `Dataset`** (`/prices`, `/revenue`,
  `/incidents`, `/rankings`, `/disclosures`), with `exportDistribution()` for the downloads and
  `variableMeasured` naming real export columns. A lab page sets `about` to
  `labOrganizationSchema()`, so the lab is an entity in the graph rather than a string.
- **Titles carry the query, H1s carry the name.** `useSeo({ title })` is what a search result
  and an answer engine's citation print, so it names what an analyst types ("AI lab revenue
  from SEC filings", "Anthropic: API pricing, revenue, hiring, outages"); the page's `<h1>` stays
  the short label.
- **The lede is the quotable sentence.** Lab and SKU pages open with plain sentences built from
  the figures beside them (`layers/terminal/shared/utils/terminal-ledes.ts`): lab, number, unit,
  date. Answer engines quote a sentence, not a tile. A missing figure drops its sentence. A
  price is dated exactly only when we saw it change, otherwise "since at least".
- **A dated claim is an `Article`.** Alert permalinks use `articleSchema()` with `citation` set to
  the source URLs of the change rows the page renders, so a quote lands back on the primary
  documents.
- **Licensing is stated once**, in `shared/utils/license.ts`, and read from there by `/license`,
  `/llms.txt`, and every `license` field in the graph. The three-way split is load-bearing: the
  code is MIT, the compilation is CC BY 4.0, and the underlying facts belong to their publishers
  and are not ours to license. `SourceCoverage.license` carries each source's own stated terms
  verbatim from `sources.yaml`; where a source states none, `/license` says nothing rather than
  inventing terms on its behalf.
- `/llms.txt` also names the bulk tables (from `EXPORT_TABLES`, compile-time constants, so the
  section can never be half-true) and the licence. Row counts stay out of it: a number there is
  stale the moment the next poll runs.
- **A new public page needs adding to `ROUTES` in `test/a11y/accessibility.spec.ts`** — the sweep
  has a coverage test that fails when a page reaches the sitemap without reaching axe.
- `NUXT_PUBLIC_INDEXABLE=false` makes robots.txt disallow everything, every page render
  `noindex`, and sitemap/llms.txt go empty. `NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false`
  blocks the named answer-engine crawlers (`server/utils/seo.ts` › `AI_CRAWLERS`); it defaults
  to **true** because the data is public and sourced, and being quotable is distribution.
- **IndexNow** (template, `server/utils/indexnow.ts`): `seo:indexnow` runs on the `0 4 * * *` cron,
  reads the served `/sitemap.xml`, and submits every URL whose `lastmod` is on or after its last
  accepted run, so Bing (and ChatGPT search, Copilot, DuckDuckGo behind it) recrawls the day's
  alerts and price moves. The key is `NUXT_INDEXNOW_KEY` in `wrangler.toml` `[vars]`, served at
  `/indexnow-key.txt`; it is public by design.
- **`Organization.sameAs`** is the repo (from `fleet.json`) followed by
  `runtimeConfig.public.sameAs` (the X account). Another project is also called "Frontier
  Terminal"; these links are what tell an engine which entity is ours.
- **Search Console / Bing Webmaster verification** is a one-time, owner-login step: the
  template's `.claude/docs/seo.md` › "Search console verification" has the DNS runbook.

## Share cards (og:image)

Every public page gets its own 1200x630 card, drawn at **build time** by `scripts/og-images.ts` into
`public/og/` (gitignored) with `satori` and `@resvg/resvg-js`, and served as a static asset, so the
Worker bundle does not grow. `bun run build` runs it before `nuxt build` and `--check` after.

- **Static pages** declaring a literal `publicPage` are carded from its `title` and `summary`, and
  `useSeo()` links `/og/<route>.png` on its own. The home page keeps the site card, `public/og.png`.
- **Dynamic routes** are listed in `layers/terminal/og-cards.ts` (labs, tear sheets, compare pairs,
  theses, from the same lists `crawlerPages()` reads) and each page passes
  `image: ogCardPath(...)` to `useSeo()`. A new dynamic page registers its cards in the same change, or its
  preview is a broken link. Alert, SKU and filing pages keep the site card.
- **Titles only, no live numbers.** A card is drawn once per build; a price on it would be stale by
  the next poll.
- Colors are the `og-*` roles resolved by `bun run brand:generate`; fonts are `@fontsource` packages
  (Inter and JetBrains Mono), so the build needs no network. `public/og/` is absent under `bun dev`;
  run `bun run og:build` to see the cards locally.
