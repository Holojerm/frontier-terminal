// https://nuxt.com/docs/api/configuration/nuxt-config
import { execSync } from 'node:child_process'

import { useNitro, useNuxt } from '@nuxt/kit'

import type { PublicPage } from './shared/utils/site'

// ─── Security headers ────────────────────────────────────────────────────────
//
// The only third-party load is Cloudflare's Web Analytics beacon (injected at
// the edge), so the policy is 'self' almost everywhere, and `test/csp/` pins it
// in a real Chromium: adding an external origin is a decision made in this file.
//
// `routeRules` rather than a Nitro middleware: a middleware would only buy a
// per-request nonce, which can't be used (see `script-src`), and it would wake
// the Worker for static assets Cloudflare otherwise serves directly.

/**
 * Cloudflare Web Analytics. With it on for the zone (the default for a new
 * site), Cloudflare injects the beacon into every HTML response at the edge, so
 * no code in app/ loads it; without these hosts every page logs a CSP violation
 * and the dashboard reads zero visits. `script-src` for beacon.min.js,
 * `connect-src` for the /cdn-cgi/rum reports, per Cloudflare's own CSP page.
 * Cookieless.
 */
const CF_WEB_ANALYTICS = {
  script: ['https://static.cloudflareinsights.com'],
  connect: ['https://cloudflareinsights.com'],
} as const

// `nuxt dev` sets NODE_ENV=development, `nuxt build` sets production.
//
// The only dev delta is `frame-src 'self'`, for the Nuxt DevTools panel.
// test/csp/ runs against the production build, so a dev server that refuses
// what production refuses shows a violation the moment a change causes it,
// not at the merge queue.
const isDev = process.env.NODE_ENV !== 'production'

const CSP: Record<string, string[]> = {
  'default-src': ["'self'"],

  // 'unsafe-inline' is required. Nuxt SSR emits two executable inline scripts
  // per page (the payload is `<script type="application/json">`, which CSP never
  // blocks): @nuxtjs/color-mode's pre-paint FOUC guard (NuxtUI depends on it)
  // and Nuxt's runtime-config serialization.
  //
  // Neither can be nonced: `routeRules` headers are static strings, and Nuxt has
  // no API for stamping a nonce onto framework-injected script tags. Neither can
  // be hashed: the color-mode guard changes when that dependency updates, and
  // the config script contains `appName` and `appUrl`, so it changes on `bun run
  // rename` and any [vars] edit. A hash allowlist would pass every check here,
  // then white-screen production after a routine `bun update`.
  //
  // script-src still refuses every external origin but the Web Analytics
  // beacon, and with object-src/base-uri below the classic bypasses stay shut.
  // test/csp/ pins the external-host list to that one.
  'script-src': ["'self'", "'unsafe-inline'", ...CF_WEB_ANALYTICS.script],

  // Vue SSR emits inline style attributes and Vite dev injects <style> blocks;
  // there is no build flag that stops either.
  'style-src': ["'self'", "'unsafe-inline'"],

  // data: because the @nuxt/icon client bundle inlines icons as
  // `mask-image: url("data:image/svg+xml,…")`, which is img-src, not style-src.
  'img-src': ["'self'", 'data:'],

  // @nuxt/fonts downloads Inter and JetBrains Mono at build time and serves them
  // from /_fonts, so a Google Fonts origin here would mean the build stopped
  // self-hosting. DESIGN.md › Typography sets `font-display` to the same
  // JetBrains Mono that `font-mono` loads, at a heavier weight.
  'font-src': ["'self'"],

  // No `ws:` for Vite's HMR socket: CSP3 has `'self'` match ws/wss on the
  // document's own host (test/csp passes without it), and `ws:` is a bare scheme
  // source that would allow a socket to any host.
  'connect-src': ["'self'", ...CF_WEB_ANALYTICS.connect],

  // Nothing on this site frames anything, so production refuses every frame.
  // X-Frame-Options / frame-ancestors govern the opposite direction.
  //
  // Dev allows 'self' for Nuxt DevTools' same-origin iframe
  // (/__nuxt_devtools__/client/). frame-src does not fall back to default-src's
  // 'self', and a refused iframe still fires `load`, so the panel renders blank
  // and reads as broken DevTools rather than a CSP block.
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
  // One year is the preload-list minimum. `preload` is left off: it submits to
  // a browser-vendor registry that ships in binary releases and takes months to
  // reverse, so it is the domain owner's call, not a template default.
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
// Cron expression → task names. A Cloudflare cron trigger reaches a task only
// by exact string match on the expression, so every key must appear verbatim
// in wrangler.toml's `[triggers] crons`. A mismatch is silent (the Worker wakes
// and does nothing); `bun run crons:check` fails the build on one.
//
// One const feeds both `nitro.scheduledTasks` (what runs) and
// `runtimeConfig.scheduledTasks` (what /api/status reports), so the dashboard
// compares Nitro's schedule against the triggers Cloudflare registered.
//
//   */30       — ops:watch, layers/terminal/server/tasks/ops/watch.ts: the freshness and
//                launch-coverage checks (they spool ops events) and the 7-day spool prune.
//              — EDGAR tick, layers/companies/server/tasks/poll/edgar.ts: the SEC feeds and
//                the model catalogs, the two axes where latency is worth polling for.
//   0 */6      — full survey, layers/terminal/server/tasks/poll/survey.ts: every include
//                source but the careers and filings lanes'. Scope policy:
//                layers/core/server/pipeline/scopes.ts.
//   17 */6     — careers lane, layers/talent/server/tasks/poll/careers.ts: the ~20 MB
//                Google careers feed in its own invocation, so it never shares the
//                survey's 128 MB.
//   47 */6     — filings lane, layers/terminal/server/tasks/poll/filings.ts: the S-1
//                indexes and ~14 MB prospectuses, for the same reason.
//   */5        — launch tripwire, layers/models/server/tasks/poll/tripwire.ts: parses the
//                model catalogs, polls them only when they differ from the store, and
//                yields on the half-hour ticks above.
//              — cache:warm re-renders the public pages once per (build, poll stamp)
//                so readers hit warm KV payloads (layers/core/server/utils/cache-warm.ts).
//   0 13 * * MON — the weekly thesis digest email; social:digest queues the weekly
//                what-moved thread; alerts:hiring-rollup writes one hiring alert per
//                lab for the week that just ended.
//   41 * * * * — events:sweep, the backstop for the EVENTS queue
//                (layers/core/server/utils/events.ts): the social and webhook outboxes
//                and the press briefs run on queue messages emitted when alerts are
//                written, and this catches any message that was lost.
//              — bulk:build; reliability:record, which rolls up source runs and records
//                filing detections for /data#reliability
//                (layers/reliability/server/pipeline/reliability/); reliability:deploys,
//                which reads its deploy smoke results from GitHub.
//              — prints:read, the Taiwan monthly revenue feeds, TSMC's revenue 6-Ks and
//                Korea Customs Service's export releases (layers/compute/server/prints/ingest.ts).
//   7 * * * *  — probes:latency, layers/reliability/server/tasks/probes/latency.ts: one
//                timed streaming request per lab, alone in its invocation so no other
//                task's requests queue in front of a probe.
//   0 4 * * *  — seo:indexnow submits the sitemap URLs changed since its last accepted
//                run to IndexNow (server/utils/indexnow.ts).
//              — hiring:listed reads the listed companies' job boards, one request each,
//                and streams Google's from the careers lane's archived copy
//                (layers/talent/server/listed-hiring/read.ts).
//   29 5 * * TUE — power:verify re-reads each page the power-sites table cites and
//                spools an ops event for a quote that is gone
//                (layers/compute/server/power/verify.ts).
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
 * Empty when none is available (a tarball, a copy with no .git); the route
 * reports null rather than guessing.
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
    // nuxt-mcp rewrites the tracked `.mcp.json` with the live dev server URL on
    // every boot. In automation (an agent booting a server to check a page) that
    // leaves a dirty tree, and a `git add -A` would commit a throwaway port over
    // the `my-app.localhost` URL that `bun run rename` owns. Gated on
    // NUXT_DEVTOOLS=false, the switch for a dev server started by automation (see
    // `devtools` below). Array form because nuxt-mcp registers `configKey: 'mcp'`
    // without augmenting `@nuxt/schema`, so a top-level `mcp:` key won't typecheck.
    ['nuxt-mcp', { updateConfig: process.env.NUXT_DEVTOOLS === 'false' ? false : 'auto' }],
  ],

  // NuxtUI v4 needs this CSS entry: without it Tailwind utilities and NuxtUI's
  // semantic tokens don't apply and pages render unstyled. See app/assets/css/main.css.
  css: ['~/assets/css/main.css'],

  // Inline that CSS instead of linking it. It is the only render-blocking
  // request, and as a <link> it shares bandwidth with ~30 JS modulepreloads: on a
  // throttled phone it finished ~1.7s after the HTML and first paint waited for
  // it (`bun run perf`). Inline, the page paints from the HTML alone, for ~21KB
  // compressed per document (`ui` and `fonts` below keep it there).
  features: { inlineStyles: true },

  app: {
    head: {
      // Nuxt doesn't set this. Without it screen readers guess the pronunciation
      // and translation tools guess the source language.
      htmlAttrs: { lang: 'en' },
      // viewport-fit=cover makes env(safe-area-inset-*) nonzero on iOS; the
      // `bottom-safe` / `right-safe` utilities in main.css need it
      // (DESIGN.md › Accessibility › Viewport).
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      // No `theme-color`: the right value is the page background, which lives in
      // the token layer and differs per color mode, so a hex here would be wrong
      // in the dark. manifest.webmanifest's `theme_color` is fixed because a
      // manifest has no color mode: the launcher chrome Android paints for the
      // installed app reads DESIGN.md › Brand mark › Color roles
      // (`manifest-theme`, resolved by `bun run brand:generate`).
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
        // Feed autodiscovery: a feed reader finds /alerts.xml
        // (layers/alerts/server/routes/alerts.xml.get.ts) by reading this tag off
        // any page of the site.
        {
          rel: 'alternate',
          type: 'application/atom+xml',
          href: '/alerts.xml',
          title: 'Alerts',
        },
      ],
    },
  },

  // NuxtHub: Cloudflare D1, KV and R2 (blob) bindings
  hub: {
    db: 'sqlite', // D1 SQLite via Drizzle (auto-imports `db` and `schema` in server routes)
    kv: true, // KV store
    blob: true, // R2 — raw fetched payloads, so every derived datum has its source bytes
    // Cache layer for `defineCachedFunction` / `defineCachedEventHandler`.
    //
    // The binding is named explicitly: `cache: true` on Cloudflare resolves to a
    // KV binding called `CACHE`, which wrangler.toml doesn't declare, so every
    // cache read and write threw `Invalid binding 'CACHE': 'undefined'`. Nitro
    // catches those, so the cache silently stored nothing while logging two
    // `server_error`s per request. Sharing the `KV` namespace is safe: Nitro
    // prefixes its entries with `cache:`, which nothing else in this app writes.
    cache: { driver: 'cloudflare-kv-binding', binding: 'KV' },
  },

  ui: {
    // The design system is compiled from DESIGN.md into app/app.config.ts and
    // app/assets/css/main.css by /design-sync; only this belongs here. Tailwind
    // scans only the themes of the U-components the app uses. Without it every
    // page inlined the classes of all 125 (~250KB of a 265KB stylesheet in every
    // document, per features.inlineStyles above). A component reached only by a
    // string name would lose its styles; there are none (`:is` here only picks
    // between plain elements).
    experimental: { componentDetection: true },
  },

  // Only the faces the pages set. Each face is an @font-face rule in the inlined
  // stylesheet, and the defaults (both styles, all seven subsets) made 104 of
  // them, 38KB of every document. Italic is synthesized for the two <em>s that
  // use it; Greek stays for Δ. Cyrillic and Vietnamese fall back to the system face.
  fonts: {
    defaults: {
      weights: [400, 500, 600, 700],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext', 'greek'],
    },
  },

  // DESIGN.md › Identity: this app is dark-first. `system` still wins when a
  // visitor has a preference; `fallback` only decides what to paint when they
  // have none. One of the four rules DESIGN.md can't express as a token.
  colorMode: {
    preference: 'system',
    fallback: 'dark',
  },

  // typeCheck runs vue-tsc in-process on `nuxt dev` only. Under `nuxt build` it
  // was a second vue-tsc pass (6s of a 10s build) in a build that always follows
  // `bun run typecheck`. NUXT_TYPECHECK=false skips it in dev.
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

  // Icons (DESIGN.md › Identity › Iconography). Every setting here keeps icon
  // rendering on this origin. The collection is the @iconify-json/lucide devDependency.
  //
  // clientBundle: each i-lucide-* literal the scanner finds is inlined into the
  // client bundle, which SSR consults first. The scanner skips .ts by default,
  // but icon names kept as data in .ts files and rendered by `:icon` /
  // `<UIcon :name>` are common; unbundled, each costs a server-side `[Icon]
  // failed to load icon lucide:*` per render and a browser round trip to
  // /api/_nuxt_icon/lucide.json. Scanning .ts means no hand-kept list. Prose that
  // looks like `ci-browser` is matched, unresolvable and skipped; only a
  // hand-listed `clientBundle.icons` entry can fail the build.
  //
  // serverBundle: `auto` resolves to `remote` on the cloudflare_module preset, so
  // the Worker fetched whole collections from cdn.jsdelivr.net per request.
  // Bundling lucide (+81 kB gzip) makes the endpoint self-contained. Not
  // `'local'`: that takes every installed @iconify-json/* package, and a fork
  // with @iconify-json/logos measured 3.38 MB gzip, over the free plan's 3 MB
  // Worker limit.
  //
  // fallbackToApi off: with lucide bundled, a miss means a collection that isn't
  // installed, and the default would hide that behind a fetch to
  // api.iconify.design from the Worker and the browser. A warning is the better failure.
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

  // DevTools. Disabled when NUXT_DEVTOOLS=false: the panel injects its own markup
  // into every page, so axe against a dev server would report violations that
  // aren't in this app's code.
  devtools: { enabled: process.env.NUXT_DEVTOOLS !== 'false' },

  experimental: {
    // Teach Nuxt's build-time definePageMeta scanner about our own key, so the
    // `pages:resolved` hook below can read it. Without this the key is dropped
    // during extraction and every page looks private.
    extraPageMetaExtractionKeys: ['publicPage'],
  },

  hooks: {
    // /design-system is the dev-only style guide (app/pages/design-system.vue);
    // strip it from the production route table.
    // Put server/error.ts at the head of Nitro's error-handler chain, ahead of
    // Nuxt's (it un-flags `fatal` on 4xx so a missing slug isn't logged as a
    // Workers issue). A hook rather than `nitro.errorHandler`: setting that key
    // makes Nuxt skip registering its own handler, and the error pages with it.
    'nitro:config'(nitroConfig) {
      const existing = nitroConfig.errorHandler ? [nitroConfig.errorHandler].flat() : []
      nitroConfig.errorHandler = [`${useNuxt().options.serverDir}/error`, ...existing]
    },

    'pages:extend'(pages) {
      if (process.env.NODE_ENV !== 'production') return
      const index = pages.findIndex((page) => page.path === '/design-system')
      if (index !== -1) pages.splice(index, 1)
    },

    // Derive sitemap.xml and llms.txt from the route table. Pages opt in with
    // `definePageMeta({ publicPage: … })` (app/types/seo.d.ts); anything without
    // that key is absent from both.
    //
    // Three things this depends on, each failing as an empty sitemap, not an error:
    //   * `pages:resolved`, not `pages:extend`: Nuxt extracts definePageMeta
    //     between the two, so `page.meta` is still null in `pages:extend`.
    //   * `experimental.extraPageMetaExtractionKeys` above, or the extractor
    //     records only a "dynamic key here" marker for `publicPage`.
    //   * Nitro is already initialised here, so setting
    //     `nuxt.options.runtimeConfig` alone is too late; both are set below.
    //
    // test/seo.test.ts asserts the rendering. If the sitemap ever goes empty, start here.
    'pages:resolved'(pages) {
      const entries: PublicPage[] = []
      const collect = (list: typeof pages) => {
        for (const page of list) {
          // Build-time page meta is typed `unknown` per key; app/types/seo.d.ts
          // declares this key's shape for `definePageMeta`.
          const meta = page.meta?.publicPage as Omit<PublicPage, 'path'> | undefined
          // A dynamic segment like /posts/[id] has no single URL to publish; those
          // need a D1 query in server/routes/sitemap.xml.get.ts.
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

  runtimeConfig: {
    // Filled by the `pages:resolved` hook above from
    // `definePageMeta({ publicPage })`. Server-only: sitemap.xml and llms.txt
    // are the only readers, so it stays out of the client bundle.
    publicPages: [] as PublicPage[],
    // Build date, used as <lastmod> for every sitemap URL. Per-page dates would
    // need git history, which CI clones shallowly, and a plausible wrong date is
    // worse than a coarse right one; crawlers also discount a lastmod that
    // always says "today".
    buildDate: new Date().toISOString().slice(0, 10),
    // The cron map Nitro runs, exposed so /api/status can report it. Server-only.
    scheduledTasks: SCHEDULED_TASKS,
    // ── Fleet (the portfolio dashboard) ─────────────────────────────────────
    // Bearer the dashboard presents to /api/fleet; unset, that route 404s. 32+
    // characters (`openssl rand -base64 32`, then `wrangler secret put
    // NUXT_FLEET_TOKEN`). `_PREVIOUS` is set only during a rotation (see
    // server/utils/fleet-auth.ts).
    fleetToken: '',
    fleetTokenPrevious: '',
    // Bearer the ops-triage routine presents to GET /api/ops/events; unset, that
    // route 404s. Separate from the fleet token (different consumer, rotated
    // separately). `wrangler secret put NUXT_OPS_TOKEN`; 32+ characters.
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
    // with a 'failed' run, never fetched anonymously (layers/core/server/utils/pipeline-fetch.ts).
    // A Worker secret: `wrangler secret put NUXT_SEC_CONTACT_EMAIL`.
    secContactEmail: '',
    // Bearer the mini's GDELT and relay jobs (scripts/gdelt-search.ts, scripts/relay-fetch.ts)
    // present to /api/gdelt/* and /api/relay/* (layers/press/server/utils/gdelt-auth.ts). The same value is the
    // repository secret GDELT_TOKEN and the mini's ~/agent-jobs/.gdelt-token. Unset = those routes 404 and no GDELT file
    // is read. `wrangler secret put NUXT_GDELT_TOKEN`; 32+ chars.
    gdeltToken: '',
    // OpenRouter API key for the usage-rankings dataset (the demand-share axis,
    // layers/core/server/utils/pipeline-fetch.ts). Sent as a bearer to openrouter.ai/api/v1/datasets/*
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
      // which commit is live.
      buildSha: buildSha(),
      // One sentence describing the product: the landing page's meta
      // description, the /llms.txt blockquote and the schema.org description,
      // so an answer engine reads the same claim everywhere.
      appDescription:
        'Fundamentals on the frontier AI labs and the public companies around them, from API prices and hiring to filings, revenue, demand, and compute. Every number links to its source and shows when we read it.',
      // The app's canonical public origin, no trailing slash. Absolute links in
      // sitemap.xml, robots.txt, and og: tags are built from this.
      appUrl: 'http://localhost:3000',
      // Origin of a separate MCP worker (the template's mcp/ directory). Leave it
      // empty: this app's MCP endpoint is its own /mcp route
      // (layers/core/server/routes/mcp.ts), already named in llms.txt. Set, it
      // would add a second "MCP server" section to llms.txt and point
      // /.well-known/ai-catalog.json at a Server Card nothing here serves.
      mcpUrl: '',
      // false makes robots.txt disallow everything, every page render `noindex`,
      // and sitemap.xml/llms.txt go empty: for any deploy that must not compete
      // with production in the index.
      indexable: true,
      // Whether AI crawlers and answer-engine fetchers (GPTBot, ClaudeBot,
      // PerplexityBot, Google-Extended, …) may read the public pages. The data is
      // public and sourced, and being quotable is distribution.
      // NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false blocks the named crawlers.
      allowAiCrawlers: true,
    },
  },

  // Security headers on every response (see the Security headers block above).
  // '/**' rather than a page-only pattern: the headers are inert on JSON, but
  // nosniff on /og.png and HSTS on every API call need it, and a route added
  // later is covered by default.
  routeRules: {
    '/**': { headers: securityHeaders },
    // The track record became a tab on /alerts; the old page's links still land.
    '/track-record': { redirect: { to: '/alerts?tab=track-record', statusCode: 301 } },
  },

  nitro: {
    // cloudflare_module plus one export: `$DurableObject`, a Durable Object that
    // runs this app inside it. The latency probes run in one, made with a
    // location hint, so they leave from one place (wrangler.toml › Probe
    // placement). Every other handler is cloudflare_module's.
    preset: 'cloudflare-durable',
    // The preset minifies the server bundle with terser in-process: about 1.4 GB
    // of the build's 4.8 GB peak and half its CPU. The browser suites build on a
    // 5 GB VM (test/server/start.ts), and minifying changes none of the markup or
    // headers they check, so their build skips it. Deploys keep the default.
    minify: process.env.BROWSER_SUITE_BUILD === '1' ? false : undefined,
    experimental: {
      // Turns on Nitro's task layer: server/tasks/ is scanned, `defineTask` is
      // auto-imported, and `import.meta._tasks` becomes true, which the
      // cloudflare_module preset's `scheduled()` handler checks before calling
      // runCronTasks(). Without it a cron trigger fires and no task runs.
      tasks: true,
    },

    // SCHEDULED_TASKS, declared above with its rules for matching wrangler.toml.
    // Empty under `nuxt dev`, where Nitro would run them on its own croner clock
    // and the tripwire and EDGAR ticks would fill the local database from live
    // vendor pages mid-session. Run a task on demand through the dev task
    // endpoint (/_nitro/tasks/<name>).
    scheduledTasks: isDev ? {} : SCHEDULED_TASKS,
  },

  compatibilityDate: '2025-09-01',
})
