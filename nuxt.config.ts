// https://nuxt.com/docs/api/configuration/nuxt-config
import { execSync } from 'node:child_process'

import { useNitro, useNuxt } from '@nuxt/kit'

import type { PublicPage } from './shared/utils/site'

// ─── Security headers ────────────────────────────────────────────────────────
//
// This site loads nothing from a third party except Cloudflare's own Web
// Analytics beacon (injected at the edge) — no checkout, no bot challenge — so
// the policy is 'self' almost everywhere, and `test/csp/` pins it that way in a
// real Chromium: adding an external origin has to be a decision someone makes
// in this file, not a violation someone silences.
//
// Why `routeRules` and not a Nitro middleware: the only thing a middleware buys
// here is a per-request nonce, and we cannot spend one (see `script-src`). What
// it costs is a handler invocation on every request, including the static assets
// Cloudflare would otherwise serve without waking the Worker.

/**
 * Cloudflare Web Analytics. With it on for the zone (the default for a new
 * site), Cloudflare injects the beacon into every HTML response at the edge, so
 * no code in app/ loads it — and without these hosts every page logs a CSP
 * violation and the dashboard reads zero visits. `script-src` for
 * beacon.min.js, `connect-src` for the /cdn-cgi/rum reports, as listed on
 * Cloudflare's own CSP page. Cookieless.
 */
const CF_WEB_ANALYTICS = {
  script: ['https://static.cloudflareinsights.com'],
  connect: ['https://cloudflareinsights.com'],
} as const

// `nuxt dev` sets NODE_ENV=development, `nuxt build` sets production.
//
// The dev delta is exactly one source — `frame-src 'self'`, for the Nuxt
// DevTools panel — and keeping it that small is deliberate. test/csp/ runs
// against the production build, so it checks the policy that ships; a dev
// server that refuses what production refuses shows the same violation the
// moment a change causes it, not at the merge queue.
//
// Everything else Vite dev was assumed to need turned out to be unnecessary —
// see connect-src.
const isDev = process.env.NODE_ENV !== 'production'

const CSP: Record<string, string[]> = {
  'default-src': ["'self'"],

  // 'unsafe-inline' is load-bearing, and not something to quietly accept.
  //
  // Nuxt SSR emits two executable inline scripts on every page. The payload is
  // NOT one of them — it ships as `<script type="application/json">`, which the
  // browser never executes and CSP therefore never blocks. The two real ones are
  // @nuxtjs/color-mode's pre-paint FOUC guard (NuxtUI depends on it; removing it
  // makes every page flash the wrong theme) and Nuxt's runtime-config
  // serialization.
  //
  // Neither can be nonced: `routeRules` headers are static strings, and even
  // behind a middleware Nuxt has no API for stamping a nonce onto framework
  // injected script tags — the color-mode guard would stay unnonced and dark
  // mode would break instead.
  //
  // Neither can be safely hashed either, and this is the trap worth naming: the
  // color-mode guard's bytes change when that dependency updates, and the config
  // script's bytes contain `appName` and `appUrl`, so it changes on `bun run
  // rename` and on any [vars] edit. A hash allowlist would ship green through
  // lint, typecheck and this repo's own tests, then white-screen production
  // after a routine `bun update`.
  //
  // What survives: script-src still refuses every *external* origin except the
  // Web Analytics beacon, so an injected `<script src="//evil.tld/x.js">` does
  // not load. Paired with object-src/base-uri below, the classic bypasses stay
  // shut. test/csp/ pins the external-host list to exactly that one.
  'script-src': ["'self'", "'unsafe-inline'", ...CF_WEB_ANALYTICS.script],

  // Vue SSR emits inline style attributes and Vite dev injects <style> blocks;
  // there is no build flag that stops either.
  'style-src': ["'self'", "'unsafe-inline'"],

  // data: because the @nuxt/icon client bundle inlines icons as
  // `mask-image: url("data:image/svg+xml,…")`, which is img-src, not style-src.
  'img-src': ["'self'", 'data:'],

  // @nuxt/fonts downloads Inter and JetBrains Mono at build time and serves them
  // from /_fonts — there is deliberately no Google Fonts origin here, and if one
  // ever appears it means the build stopped self-hosting. Two families, not
  // three: DESIGN.md › Typography sets `font-display` to the same JetBrains Mono
  // that `font-mono` already loads, at a heavier weight.
  'font-src': ["'self'"],

  // No `ws:` for Vite's HMR socket, which is the obvious thing to add here and
  // measurably unnecessary: CSP3 has `'self'` match ws/wss on the document's own
  // host, and dropping it changed nothing in test/csp. It is also not a cheap
  // addition — `ws:` is a bare scheme source, so it would permit a socket to
  // *any* host, which is a strange thing to hand a dev server.
  'connect-src': ["'self'", ...CF_WEB_ANALYTICS.connect],

  // Nothing on this site frames anything, so production refuses every frame.
  // X-Frame-Options / frame-ancestors govern the opposite direction and do not
  // conflict with it — a common reason people delete one of the two.
  //
  // 'self' in dev is the one genuine dev/prod difference, and it is here to stop
  // this policy from getting itself deleted. Nuxt DevTools mounts its panel in a
  // same-origin iframe (/__nuxt_devtools__/client/), and frame-src does NOT fall
  // back to default-src's 'self' — a same-origin frame is refused unless listed.
  // Worse, a refused iframe still fires `load`, so the panel renders *blank*: it
  // reads as a broken DevTools, not as a CSP decision, and the natural next move
  // is to rip the header out. DevTools does not exist in a production build.
  'frame-src': isDev ? ["'self'"] : ["'none'"],

  'worker-src': ["'self'"],
  // Safari < 15.4 never shipped worker-src and falls back to child-src. Not
  // redundant with frame-src: frame-src is set explicitly above and wins for
  // frames in every browser that has it.
  'child-src': ["'self'"],

  // No <object>/<embed> anywhere in this app, and leaving it open is one of the
  // two standard ways to bypass a script-src that allows 'unsafe-inline'.
  'object-src': ["'none'"],
  // The other one: without this, injected markup can repoint every relative
  // script URL at an attacker's origin.
  'base-uri': ["'self'"],
  // There are no forms on this site; nothing legitimate submits anywhere.
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

const contentSecurityPolicy = Object.entries(CSP)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ')

const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy,
  // Two years is the preload-list minimum, but `preload` itself is deliberately
  // absent: it is a submission to a browser-vendor registry that ships in binary
  // releases and takes months to reverse. That is the app owner's call to make
  // on their own domain, not a default a template should make for them.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // Full URL to our own origin, origin-only to third parties, nothing at all on
  // an HTTPS→HTTP downgrade.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Redundant with frame-ancestors for modern browsers, kept for the ones that
  // only understand this.
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

// ─── Scheduled tasks ─────────────────────────────────────────────────────────
//
// Cron expression → task names. This map is the ONLY thing that connects a
// Cloudflare cron trigger to a task, and the join is an exact string match on
// the expression, so every key here must appear verbatim in `[triggers] crons`
// in wrangler.toml. A mismatch is silent: the Worker wakes on schedule and does
// nothing. `bun run crons:check` fails the build on one.
//
// Hoisted to a const so it can be handed to BOTH `nitro.scheduledTasks` (what
// runs) and `runtimeConfig.scheduledTasks` (what /api/status reports) — one
// map, so the dashboard compares the schedule Nitro will honour against the
// triggers Cloudflare says it registered.
//
//   */30       — ops:watch, layers/terminal/server/tasks/ops/watch.ts: the freshness and
//                launch-coverage checks (they spool ops events) and the 7-day prune of the spool.
//              — EDGAR tick, layers/companies/server/tasks/poll/edgar.ts: the SEC feeds and the
//                model catalogs, the two axes where latency is worth polling for.
//   0 */6      — full survey, layers/terminal/server/tasks/poll/survey.ts: every include
//                source but the careers and filings lanes'. Scope policy:
//                layers/core/server/pipeline/scopes.ts.
//   17 */6     — careers lane, layers/talent/server/tasks/poll/careers.ts: the ~20 MB
//                Google careers feed in an invocation of its own, so its memory
//                never shares the survey's 128 MB.
//   47 */6     — filings lane, layers/terminal/server/tasks/poll/filings.ts: the S-1
//                indexes and ~14 MB prospectuses, for the same reason.
//   */5        — launch tripwire, layers/models/server/tasks/poll/tripwire.ts: parses the
//                model catalogs, polls them only when they differ from the
//                store, and yields on the half-hour ticks above.
//              — cache:warm re-renders the public pages once per (build, poll
//                stamp) so readers hit warm KV payloads
//                (layers/core/server/utils/cache-warm.ts).
//   0 13 * * MON — weekly thesis digest email, and social:digest queues the
//                weekly what-moved thread. alerts:hiring-rollup writes one
//                hiring alert per lab for the week that just ended.
//   41 * * * * — events:sweep, the backstop for the EVENTS queue
//                (layers/core/server/utils/events.ts): the social and webhook
//                outboxes and the press briefs are driven by queue messages
//                emitted when alerts are written, not by a timer, and this
//                catches any message that was lost.
//              — bulk:build, and reliability:record, which rolls up source runs
//                and records filing detections for /data#reliability
//                (layers/reliability/server/pipeline/reliability/), and
//                reliability:deploys, which reads its deploy smoke results
//                from GitHub.
//              — prints:read, the Taiwan monthly revenue feeds, TSMC's revenue 6-Ks and
//                Korea Customs Service's export releases (layers/compute/server/prints/ingest.ts).
//   7 * * * *  — probes:latency, layers/reliability/server/tasks/probes/latency.ts: one
//                timed streaming request per lab, alone in its invocation so no
//                other task's requests queue in front of a probe.
//   0 4 * * *  — seo:indexnow submits the sitemap URLs changed since its last
//                accepted run to IndexNow (server/utils/indexnow.ts).
//              — hiring:listed reads the listed companies' job boards, one request
//                each, and streams Google's from the careers lane's archived copy
//                (layers/talent/server/listed-hiring/read.ts).
//   29 5 * * TUE — power:verify re-reads each utility, regulator and company page
//                the power-sites table cites and spools an ops event for a quote
//                that is gone (layers/compute/server/power/verify.ts).
//   53 */6     — power:grid-load streams EIA-930's six-month demand files and reads
//                ERCOT's large-load reports (layers/compute/server/power/grid-load.ts),
//                alone in its invocation for the long downloads.
//   23 * * * * — calls:read, the earnings-call reader: EDGAR exhibits, company
//                transcripts and AssemblyAI replays, and the XBRL that scores them
//                (layers/companies/server/calls/ingest.ts).
const SCHEDULED_TASKS: Record<string, string[]> = {
  '*/30 * * * *': ['ops:watch', 'poll:edgar'],
  '0 */6 * * *': ['poll:survey'],
  '17 */6 * * *': ['poll:careers'],
  '47 */6 * * *': ['poll:filings'],
  '*/5 * * * *': ['poll:tripwire', 'cache:warm', 'track-record:search'],
  '0 13 * * MON': ['theses:digest', 'social:digest', 'alerts:hiring-rollup'],
  '41 * * * *': [
    'events:sweep',
    'bulk:build',
    'reliability:record',
    'reliability:deploys',
    'prints:read',
  ],
  '7 * * * *': ['probes:latency'],
  '0 4 * * *': ['seo:indexnow', 'hiring:listed'],
  '29 5 * * TUE': ['power:verify'],
  '40 6 * * *': ['signals:prices'],
  '10 7 * * *': ['signals:run'],
  '53 */6 * * *': ['power:grid-load'],
  '23 * * * *': ['calls:read'],
}

/**
 * The commit this build came from, for /api/status. Workers Builds exports
 * WORKERS_CI_COMMIT_SHA and GitHub Actions GITHUB_SHA; a local build asks git.
 * Empty when none of those is available (a tarball, a shallow copy with no
 * .git) — reported as null by the route rather than guessed.
 */
function buildSha(): string {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (fromCi) return fromCi
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

export default defineNuxtConfig({
  // Nuxt 4 compatibility
  future: {
    compatibilityVersion: 4,
  },

  modules: [
    '@nuxt/ui',
    '@nuxthub/core',
    // nuxt-mcp rewrites `.mcp.json` — a *tracked* file — with the live dev
    // server URL every time a dev server boots. Helpful when you started that
    // server yourself; destructive in automation, where an agent boots one to
    // check a page. The run would finish with a dirty tree, and a
    // `git add -A` would sweep a throwaway port into the commit, clobbering the
    // `my-app.localhost` URL that `bun run rename` is responsible for.
    //
    // Gated on NUXT_DEVTOOLS=false, the switch for a dev server started by
    // automation (see `devtools` below). Options go in the
    // array form because nuxt-mcp registers `configKey: 'mcp'` without
    // augmenting `@nuxt/schema`, so a top-level `mcp:` key would not typecheck.
    ['nuxt-mcp', { updateConfig: process.env.NUXT_DEVTOOLS === 'false' ? false : 'auto' }],
  ],

  // NuxtUI v4 requires this CSS entry — without it, Tailwind utilities and
  // NuxtUI semantic tokens (text-foreground, bg-background, etc.) won't apply
  // and pages render unstyled. See app/assets/css/main.css.
  css: ['~/assets/css/main.css'],

  // Inline that CSS into the document instead of linking it. It is the only
  // render-blocking request, and as a <link> it starts alongside ~30 JS
  // modulepreloads that split the bandwidth: on a throttled phone it finished
  // ~1.7s after the HTML, and first paint waited for it (`bun run perf`,
  // 2026-11-04). Inline, the page paints from the HTML alone. The cost is ~21KB
  // compressed per document (`ui` and `fonts` below keep it there), which no
  // other request was saving: every page load fetched the same file cold.
  features: { inlineStyles: true },

  // Document-level defaults every page inherits.
  app: {
    head: {
      // Nuxt does not set this for you. Without it, screen readers guess the
      // pronunciation and translation tools guess the source language — and
      // Google treats a missing lang as a weak signal about who the page is for.
      htmlAttrs: { lang: 'en' },
      // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
      // anything but 0 on iOS — the `bottom-safe` / `right-safe` utilities in
      // main.css are inert without it (DESIGN.md › Accessibility › Viewport).
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      // Deliberately no `theme-color`: the correct value is the page
      // background, which lives in the token layer and differs per color mode.
      // Hardcoding a hex here would bypass DESIGN.md and be wrong in the dark.
      //
      // manifest.webmanifest's own `theme_color` is not the same decision
      // reversed. A manifest has no color mode either — same as a PNG — so it
      // isn't picking a light-vs-dark value out of the token layer; it's
      // reading DESIGN.md › Brand mark › Color roles (`manifest-theme`,
      // resolved at `bun run brand:generate` time, same pipeline as the
      // icons) the one time a fixed brand color is actually correct: the
      // launcher chrome Android paints once this is installed as an app.
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
        // Feed autodiscovery. layers/alerts/server/routes/alerts.xml.get.ts has existed since
        // the alerts axis shipped, but a feed reader finds a feed by reading
        // this tag off any page of the site — without it, /alerts.xml is a URL
        // you have to already know, which is the same as not publishing one.
        {
          rel: 'alternate',
          type: 'application/atom+xml',
          href: '/alerts.xml',
          title: 'Alerts',
        },
      ],
    },
  },

  // NuxtHub — Cloudflare D1, KV, R2, and Blob bindings
  hub: {
    db: 'sqlite', // D1 SQLite via Drizzle (auto-imports `db` and `schema` in server routes)
    kv: true, // KV store
    blob: true, // R2 — raw fetched payloads, so every derived datum has its source bytes
    // Cache layer, for `defineCachedFunction` / `defineCachedEventHandler`.
    //
    // The binding is named explicitly, and that is a bug fix rather than a
    // preference. `cache: true` on Cloudflare resolves to a KV binding called
    // `CACHE`, which this template's wrangler.toml does not declare — so every
    // cache read and write threw `Invalid binding 'CACHE': 'undefined'`.
    // Nitro catches those, so nothing broke loudly: the cache simply never
    // stored anything, while logging two errors per request into Cloudflare
    // Logs as `server_error`. Observed directly against `wrangler dev` on the
    // built Worker.
    //
    // Pointing it at the `KV` namespace that already exists costs a fork
    // nothing — no second namespace to create, no second placeholder id in
    // wrangler.toml. Sharing is safe: Nitro prefixes its entries with
    // `cache:`, which nothing else in this app writes.
    cache: { driver: 'cloudflare-kv-binding', binding: 'KV' },
  },

  ui: {
    // The design system is compiled from DESIGN.md into app/app.config.ts and
    // app/assets/css/main.css by /design-sync — nothing belongs here.
    //
    // Except this: Tailwind scans only the themes of the U-components the app
    // uses. Without it every page inlined the classes of all 125 of them
    // (calendars, editors, carousels): ~250KB of a 265KB stylesheet that rides in
    // every document (features.inlineStyles below). A component reached only by
    // a string name would lose its styles; there are none (`:is` here only
    // picks between plain elements).
    experimental: { componentDetection: true },
  },

  // The faces the pages set, and no others. Each face is an @font-face rule in
  // the inlined stylesheet, and the defaults (both styles, all seven subsets)
  // made 104 of them, 38KB of every document. Italic is synthesized for the
  // two <em>s that use it; Greek stays for Δ. Cyrillic and Vietnamese text
  // would fall back to the system face.
  fonts: {
    defaults: {
      weights: [400, 500, 600, 700],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext', 'greek'],
    },
  },

  // DESIGN.md › Identity: this app is dark-first. `system` still wins whenever a
  // visitor has expressed a preference; `fallback` only decides what to paint
  // when they have not, and painting the light theme at a terminal is the wrong
  // default. This is one of the four rules DESIGN.md cannot express as a token.
  colorMode: {
    preference: 'system',
    fallback: 'dark',
  },

  // TypeScript — follow Vite/Nuxt recommended defaults.
  //
  // typeCheck runs vue-tsc in-process on `nuxt dev`, and only there. Under
  // `nuxt build` it was a second vue-tsc pass, 6s of a 10s build (2026-11-20), in
  // a build that always follows `bun run typecheck`: the gates in `bun run ci`,
  // and Workers Builds' production command. NUXT_TYPECHECK=false skips it in dev.
  //
  // tsConfig.compilerOptions reach all four generated projects (app, server,
  // shared, node). The root tsconfig.json only references them, so an option
  // set there applies to nothing.
  typescript: {
    strict: true,
    typeCheck: isDev && process.env.NUXT_TYPECHECK !== 'false',
    tsConfig: {
      compilerOptions: {
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitReturns: true,
      },
    },
  },

  // Icons — DESIGN.md › Identity › Iconography. Every setting here exists so
  // that rendering an icon never leaves this origin. The collection itself is
  // the @iconify-json/lucide devDependency.
  //
  // clientBundle: each i-lucide-* literal the scanner finds is inlined into
  // the client bundle, which SSR consults first. The scanner skips .ts by
  // default (a performance default, not a limit), but an icon name kept as
  // data in a .ts file and rendered by `:icon` / `<UIcon :name>` is a real
  // pattern. Unbundled, each of those costs one server-side `[Icon] failed to
  // load icon lucide:*` per render and one browser round trip to
  // /api/_nuxt_icon/lucide.json. Scanning the source trees' .ts too means
  // there is no hand-kept list to drift. Prose that happens to look like
  // `ci-browser` is matched, unresolvable, and silently skipped — only a
  // hand-listed `clientBundle.icons` entry can fail the build.
  //
  // serverBundle: `auto` resolves to `remote` on the cloudflare_module preset,
  // so the Worker answered /api/_nuxt_icon by fetching whole collections from
  // cdn.jsdelivr.net at request time. Bundling lucide (+81 kB gzip) makes
  // the endpoint self-contained. Not `'local'`: that takes every installed
  // @iconify-json/* package, and a fork with @iconify-json/logos measured
  // 3.38 MB gzip — over the 3 MB Worker limit on the free plan.
  //
  // fallbackToApi off: with lucide bundled, a miss means a collection that is
  // not installed. The default answers that with a fetch to api.iconify.design
  // — from the Worker, and from the browser too — which hides the mistake
  // behind a third-party request. A warning is the better failure.
  icon: {
    clientBundle: {
      scan: {
        // The module's own defaults, plus the source trees' .ts files.
        globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}', '{app,server,shared}/**/*.ts'],
      },
    },
    serverBundle: { collections: ['lucide'] },
    fallbackToApi: false,
  },

  // DevTools. Disabled when NUXT_DEVTOOLS=false: the devtools panel injects its
  // own markup into every page, so axe run against a dev server would report
  // violations that aren't in this app's code.
  devtools: { enabled: process.env.NUXT_DEVTOOLS !== 'false' },

  experimental: {
    // Teach Nuxt's build-time definePageMeta scanner about our own key, so the
    // `pages:resolved` hook below can read it. Without this the key is dropped
    // during extraction and every page looks private.
    extraPageMetaExtractionKeys: ['publicPage'],
  },

  hooks: {
    // /design-system is the dev-only style guide (app/pages/design-system.vue)
    // used to verify DESIGN.md changes actually landed. Strip it from the
    // production route table so it never ships to users.
    // Put server/error.ts at the head of Nitro's error-handler chain, ahead of
    // Nuxt's (it un-flags `fatal` on 4xx so a missing slug is not logged as a
    // Workers issue). In a hook rather than `nitro.errorHandler`: setting that
    // key makes Nuxt skip registering its own handler, and the error pages
    // with it. By this hook Nuxt has already added its handler, so ours is
    // prepended to it.
    'nitro:config'(nitroConfig) {
      const existing = nitroConfig.errorHandler ? [nitroConfig.errorHandler].flat() : []
      nitroConfig.errorHandler = [`${useNuxt().options.serverDir}/error`, ...existing]
    },

    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const index = pages.findIndex((page) => page.path === '/design-system')
      if (index !== -1) pages.splice(index, 1)
    },

    // Derive sitemap.xml and llms.txt from the route table rather than from
    // hand-kept lists inside the Nitro routes. Pages opt in with
    // `definePageMeta({ publicPage: … })` (app/types/seo.d.ts); anything
    // without that key is absent from both, which is the right default because
    // most pages added to an app are private.
    //
    // Three details this depends on, all of them easy to get subtly wrong:
    //
    //   * `pages:resolved`, not `pages:extend`. Nuxt statically extracts
    //     definePageMeta *between* the two hooks, so `page.meta` is still null
    //     in `pages:extend` — the earlier hook sees every page as unmarked.
    //   * `experimental.extraPageMetaExtractionKeys` above. Without it the
    //     extractor ignores `publicPage` and records only a "there was a
    //     dynamic key here" marker, so this hook silently collects nothing.
    //   * Nitro is already initialised by the time this runs, so setting
    //     `nuxt.options.runtimeConfig` alone is too late — the value is read
    //     from the Nitro instance. Both are set below.
    //
    // Each of those fails by producing an *empty* sitemap rather than an error,
    // which is why test/seo.test.ts asserts the rendering and `bun run ci`
    // builds. If the sitemap ever goes empty, start here.
    'pages:resolved'(pages) {
      const entries: PublicPage[] = []
      const collect = (list: typeof pages) => {
        for (const page of list) {
          // Build-time page meta is typed `unknown` per key; app/types/seo.d.ts
          // declares this key's shape for `definePageMeta`.
          const meta = page.meta?.publicPage as Omit<PublicPage, 'path'> | undefined
          // Dynamic segments have no single URL to publish — a route like
          // /posts/[id] is one pattern, not N pages. Those need a D1 query in
          // server/routes/sitemap.xml.get.ts, not a route-table entry.
          if (meta && page.path && !page.path.includes(':')) {
            entries.push({ path: page.path, ...meta })
          }
          if (page.children?.length) collect(page.children)
        }
      }
      collect(pages)
      entries.sort((a, b) => a.path.localeCompare(b.path))

      useNuxt().options.runtimeConfig.publicPages = entries
      useNitro().options.runtimeConfig.publicPages = entries
    },
  },

  // Runtime config — public vars go in public, secrets stay private
  runtimeConfig: {
    // Filled by the `pages:resolved` hook above from
    // `definePageMeta({ publicPage })`. Server-only: sitemap.xml and llms.txt
    // are the only readers, so it stays out of the client bundle.
    publicPages: [] as PublicPage[],
    // Stamped at build time and used as <lastmod> for every sitemap URL.
    // Per-page dates would be better, but the honest source for those is git
    // history, which CI clones shallowly — a plausible-looking wrong date is
    // worse than a coarse right one, and crawlers discount lastmod that always
    // says "today", which is what `new Date()` at request time produces.
    buildDate: new Date().toISOString().slice(0, 10),
    // The cron map Nitro runs, exposed so /api/status can report it. Server-only.
    scheduledTasks: SCHEDULED_TASKS,
    // ── Fleet (the portfolio dashboard) ─────────────────────────────────────
    // Bearer the dashboard presents to /api/fleet. Unset = that route 404s, so
    // an app that has not opted in advertises nothing. 32+ characters; generate
    // with `openssl rand -base64 32` and set via `wrangler secret put
    // NUXT_FLEET_TOKEN`. `_PREVIOUS` is only set during a rotation — see
    // server/utils/fleet-auth.ts for the three-step.
    fleetToken: '',
    fleetTokenPrevious: '',
    // Bearer the ops-triage routine presents to GET /api/ops/events. Unset = that
    // route 404s. Its own secret, not the fleet token: different consumer, rotated
    // separately. `wrangler secret put NUXT_OPS_TOKEN`; 32+ characters.
    opsToken: '',
    // IndexNow key, public by design (/indexnow-key.txt serves it). Set in
    // wrangler.toml [vars] as NUXT_INDEXNOW_KEY. See server/utils/indexnow.ts.
    indexnowKey: '',
    // The press list (layers/press/server/pipeline/press.ts): JSON array of
    // { name, outlet, email?, tips_email?, priority }. A Worker secret because it
    // names people and this repo is public. `wrangler secret put NUXT_PRESS_LIST`.
    pressList: '',
    // The from address on press notes, on a domain verified in Resend. With
    // NUXT_RESEND_API_KEY set, notes go straight to reporters; without, the
    // owner gets a brief of mailto: links (layers/press/server/pipeline/press.ts).
    pressEmailFrom: '',
    // SEC fair-access policy requires a contact email in the User-Agent of
    // every request to sec.gov hosts. Empty = the EDGAR sources are skipped
    // with a 'failed' run, never fetched anonymously (layers/core/server/pipeline/fetch.ts).
    // A Worker secret: `wrangler secret put NUXT_SEC_CONTACT_EMAIL`.
    secContactEmail: '',
    // Bearer the mini's GDELT and relay jobs (scripts/gdelt-search.ts, scripts/relay-fetch.ts)
    // present to /api/gdelt/* and /api/relay/* (layers/press/server/utils/gdelt-auth.ts). The same value is the
    // repository secret GDELT_TOKEN and the mini's ~/agent-jobs/.gdelt-token. Unset = those routes 404 and no GDELT file
    // is read. `wrangler secret put NUXT_GDELT_TOKEN`; 32+ chars.
    gdeltToken: '',
    // OpenRouter API key for the usage-rankings dataset (the demand-share axis,
    // layers/core/server/pipeline/fetch.ts). Sent as a bearer to openrouter.ai/api/v1/datasets/*
    // only. Empty = that source is recorded 'skipped' every tick and the panel
    // says "not configured"; nothing is fetched anonymously. The hourly latency
    // probes (layers/reliability/server/pipeline/probes/) spend this key's credit on
    // openrouter.ai/api/v1/chat/completions; empty = no probe runs. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_OPENROUTER_API_KEY`.
    openrouterApiKey: '',
    // AssemblyAI key for the earnings calls a company posts only as audio
    // (layers/companies/server/calls/assemblyai.ts), sent as the Authorization header to
    // api.assemblyai.com only. Empty = replays are neither submitted nor collected; the
    // text documents are still read. A Worker secret:
    // `op read "op://Agents/assemblyai/credential" | bunx wrangler secret put NUXT_ASSEMBLYAI_API_KEY`.
    assemblyaiApiKey: '',
    // Bearer for GitHub's search API, which the coding-agent PR recipes read
    // (layers/adoption/server/recipes/github-agent-prs.ts). A fine-grained
    // token with no permissions is enough: public data only. Empty = those
    // recipes record 'skipped'; nothing is fetched anonymously.
    githubToken: '',
    // Public vars (access via useRuntimeConfig().public.myVar)
    // NUXT_PUBLIC_APP_NAME in wrangler.toml [vars] overrides this at runtime
    public: {
      appName: 'Frontier Terminal',
      // Profiles of this site beyond the repo (which fleet.json supplies),
      // emitted as Organization.sameAs so the entity is not confused with another
      // "Frontier Terminal". Env: NUXT_PUBLIC_SAME_AS (JSON array).
      sameAs: ['https://x.com/frontierterm'] as string[],
      // Stamped at build time; /api/status reports it so a dashboard can tell
      // which commit is live. Public because a sha is not a secret and a
      // footer may want to show it.
      buildSha: buildSha(),
      // One sentence describing the product. Used as the landing page's meta
      // description, as the blockquote in /llms.txt, and as the schema.org
      // description — so an answer engine reads the same claim everywhere
      // rather than three paraphrases it has to reconcile.
      appDescription:
        'Fundamentals on the frontier AI labs and the public companies around them, from API prices and hiring to filings, revenue, demand, and compute. Every number links to its source and shows when we read it.',
      // The app's canonical public origin, no trailing slash. Absolute links in
      // sitemap.xml, robots.txt, and og: tags are built from this.
      appUrl: 'http://localhost:3000',
      // The origin of a separate MCP worker (the template's mcp/ directory),
      // which this app does not have: its MCP endpoint is the app's own /mcp
      // route (layers/terminal/server/routes/mcp.ts), and llms.txt already names
      // it. Leave this empty. Set, it would add a second "MCP server" section to
      // llms.txt and make /.well-known/ai-catalog.json point at a Server Card
      // that nothing here serves.
      mcpUrl: '',
      // Set false to make robots.txt disallow everything, every page render
      // `noindex`, and sitemap.xml/llms.txt go empty — for any deploy that
      // must not compete with production in the index.
      indexable: true,
      // Whether AI crawlers and answer-engine fetchers (GPTBot, ClaudeBot,
      // PerplexityBot, Google-Extended, …) may read the public pages.
      //
      // Default true, and deliberately so: the data here is public and sourced,
      // and being quotable by an answer engine is distribution. Set false
      // (NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false) to block the named crawlers.
      // Either way it is a decision you made, which is the point of the flag.
      allowAiCrawlers: true,
    },
  },

  // Security headers on every response — see the block above nuxt.config's
  // default export for how each CSP source was verified.
  //
  // '/**' rather than a page-only pattern on purpose. The headers are inert on
  // JSON (a CSP does not apply to a fetch response body), so scoping would buy
  // nothing, while the two that DO matter off-document — nosniff on
  // /og.png and HSTS on every API call — are exactly the ones a narrower
  // pattern would drop. It also means a route added later is covered by
  // default rather than by remembering to come back here.
  routeRules: {
    '/**': { headers: securityHeaders },
    // The track record became a tab on /alerts; the old page's links still land.
    '/track-record': { redirect: { to: '/alerts?tab=track-record', statusCode: 301 } },
  },

  // Nitro — Cloudflare Workers preset for production build
  nitro: {
    // cloudflare_module plus one export: `$DurableObject`, a Durable Object that
    // runs this app inside it. The latency probes run in one, made with a
    // location hint, so they leave from one place (wrangler.toml › Probe
    // placement). Every other handler is cloudflare_module's.
    preset: 'cloudflare-durable',
    // The worker preset minifies the server bundle with terser, in-process: about
    // 1.4 GB of the build's 4.8 GB peak and half its CPU (2026-11-20). The browser
    // suites build on a 5 GB VM (test/server/start.ts), and minifying the server
    // changes none of the markup or headers they check, so their build skips it.
    // Deploys keep the preset's default.
    minify: process.env.BROWSER_SUITE_BUILD === '1' ? false : undefined,
    experimental: {
      // Turns on Nitro's task layer: server/tasks/ is scanned, `defineTask` is
      // auto-imported, and `import.meta._tasks` becomes true — which is the
      // flag the cloudflare_module preset's `scheduled()` handler checks before
      // it calls runCronTasks(). Without this, a cron trigger would fire, the
      // handler would run, and no task would execute.
      tasks: true,
    },

    // Cron expression → task names. Declared once as SCHEDULED_TASKS at the top
    // of this file (so /api/status can report the same map) — the rules for
    // keeping it in step with wrangler.toml are written there.
    //
    // Empty under `nuxt dev`, where Nitro would otherwise run these on its own
    // croner clock. That is not a harmless extra: the tripwire and EDGAR ticks
    // fetch the live vendor pages into the local database, so a dev server
    // that happens to be up across a :00/:05/:30 mark grows /prices from an
    // empty state to ~300 rows mid-run. The browser suites then ran against
    // `dev:app`, and axe on that populated table blew the 30s test budget
    // (Browser suites red on main, 2026-10-05) — a result that depended on the
    // wall clock and the vendors' networks. They run on the build under
    // `wrangler dev` now, which never fires a cron. Tasks stay runnable on demand
    // through the dev task endpoint (/_nitro/tasks/<name>).
    scheduledTasks: isDev ? {} : SCHEDULED_TASKS,
  },

  compatibilityDate: '2025-09-01',
})
