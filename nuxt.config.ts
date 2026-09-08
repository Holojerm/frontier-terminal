// https://nuxt.com/docs/api/configuration/nuxt-config
import { execSync } from 'node:child_process'

import { useNitro, useNuxt } from '@nuxt/kit'

import type { PublicPage } from './shared/utils/site'

// ─── Security headers ────────────────────────────────────────────────────────
//
// This site loads nothing from a third party — no analytics, no checkout, no
// bot challenge — so the policy is 'self' almost everywhere, and `test/csp/`
// pins it that way in a real Chromium: adding an external origin has to be a
// decision someone makes in this file, not a violation someone silences.
//
// Why `routeRules` and not a Nitro middleware: the only thing a middleware buys
// here is a per-request nonce, and we cannot spend one (see `script-src`). What
// it costs is a handler invocation on every request, including the static assets
// Cloudflare would otherwise serve without waking the Worker.

// `nuxt dev` sets NODE_ENV=development, `nuxt build` sets production.
//
// The dev delta is exactly one source — `frame-src 'self'`, for the Nuxt
// DevTools panel — and keeping it that small is deliberate. The tempting shape
// is "strict in production, off in dev", but test/csp/ runs against
// `bun run dev:app`: every source dev adds is a source the browser suite stops
// checking. One extra entry means the suite still exercises essentially the
// policy that ships.
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
  // What survives: script-src still refuses every *external* origin, so an
  // injected `<script src="//evil.tld/x.js">` does not load. Paired with
  // object-src/base-uri below, the classic bypasses stay shut. test/csp/ pins
  // the external-host list to exactly empty.
  'script-src': ["'self'", "'unsafe-inline'"],

  // Vue SSR emits inline style attributes and Vite dev injects <style> blocks;
  // there is no build flag that stops either.
  'style-src': ["'self'", "'unsafe-inline'"],

  // data: because the @nuxt/icon client bundle inlines icons as
  // `mask-image: url("data:image/svg+xml,…")`, which is img-src, not style-src.
  'img-src': ["'self'", 'data:'],

  // @nuxt/fonts downloads Inter / Instrument Serif / JetBrains Mono at build
  // time and serves them from /_fonts — there is deliberately no Google Fonts
  // origin here, and if one ever appears it means the build stopped self-hosting.
  'font-src': ["'self'"],

  // No `ws:` for Vite's HMR socket, which is the obvious thing to add here and
  // measurably unnecessary: CSP3 has `'self'` match ws/wss on the document's own
  // host, and dropping it changed nothing in test/csp. It is also not a cheap
  // addition — `ws:` is a bare scheme source, so it would permit a socket to
  // *any* host, which is a strange thing to hand a dev server.
  'connect-src': ["'self'"],

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
//   */30       — ops digest, server/tasks/ops/alert.ts. Silence is the healthy
//                state: an empty spool costs one indexed SELECT per tick.
//              — EDGAR tick, server/tasks/poll/edgar.ts: the two SEC feeds,
//                the one axis where latency is worth polling for.
//   0 */6      — full survey, server/tasks/poll/survey.ts: every include
//                source. Scope policy: server/pipeline/scopes.ts.
const SCHEDULED_TASKS: Record<string, string[]> = {
  '*/30 * * * *': ['ops:alert', 'poll:edgar'],
  '0 */6 * * *': ['poll:survey'],
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
    // server yourself; destructive in automation, because `bun run test:a11y`
    // boots one too. An agent or CI run would finish with a dirty tree, and a
    // `git add -A` would sweep a throwaway port into the commit, clobbering the
    // `my-app.localhost` URL that `bun run rename` is responsible for.
    //
    // Gated on the same signal the a11y suite already sets. Options go in the
    // array form because nuxt-mcp registers `configKey: 'mcp'` without
    // augmenting `@nuxt/schema`, so a top-level `mcp:` key would not typecheck.
    ['nuxt-mcp', { updateConfig: process.env.NUXT_DEVTOOLS === 'false' ? false : 'auto' }],
  ],

  // NuxtUI v4 requires this CSS entry — without it, Tailwind utilities and
  // NuxtUI semantic tokens (text-foreground, bg-background, etc.) won't apply
  // and pages render unstyled. See app/assets/css/main.css.
  css: ['~/assets/css/main.css'],

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
    // Customize your design system here
    // colors: { primary: 'blue', neutral: 'slate' }
  },

  // TypeScript — follow Vite/Nuxt recommended defaults.
  //
  // typeCheck runs vue-tsc in-process on `nuxt dev`. The a11y suite's dev server
  // sets NUXT_TYPECHECK=false to skip it: `bun run ci` has already run
  // `bun run typecheck` by that point, so doing it again just puts vue-tsc in
  // competition with the cold Vite build for the same CI runner.
  typescript: {
    strict: true,
    typeCheck: process.env.NUXT_TYPECHECK !== 'false',
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

  // DevTools. Disabled when NUXT_DEVTOOLS=false, which the a11y suite sets:
  // the devtools panel injects its own markup into every page, and axe would
  // scan it and report violations that aren't in this app's code.
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
          const meta = page.meta?.publicPage
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
    // Ops alerting — where the cron digest goes (server/tasks/ops/alert.ts).
    // `from` must be on a domain in the Cloudflare account with Email Routing
    // enabled; `to` must be a verified destination address. That combination
    // is free and needs no sending-domain onboarding. Both empty = the cron
    // logs `ops_alert_unconfigured` and sends nothing. Set in wrangler.toml
    // [vars] as NUXT_ALERT_EMAIL_TO / NUXT_ALERT_EMAIL_FROM — neither is a
    // secret, and the [[send_email]] binding pins the destination anyway.
    alertEmailTo: '',
    alertEmailFrom: '',
    // SEC fair-access policy requires a contact email in the User-Agent of
    // every request to sec.gov hosts. Empty = the EDGAR sources are skipped
    // with a 'failed' run, never fetched anonymously (server/pipeline/fetch.ts).
    // A Worker secret: `wrangler secret put NUXT_SEC_CONTACT_EMAIL`.
    secContactEmail: '',
    // Bearer the judge routine presents to /api/judge/* (server/utils/judge-auth.ts).
    // Unset = those routes 404 and no judge exists. Same shape and floor as the
    // fleet token; a Worker secret: `wrangler secret put NUXT_JUDGE_TOKEN`.
    judgeToken: '',
    // OpenRouter API key for the usage-rankings dataset (the demand-share axis,
    // server/pipeline/fetch.ts). Sent as a bearer to openrouter.ai/api/v1/datasets/*
    // only. Empty = that source is recorded 'skipped' every tick and the panel
    // says "not configured"; nothing is fetched anonymously. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_OPENROUTER_API_KEY`.
    openrouterApiKey: '',
    // Public vars (access via useRuntimeConfig().public.myVar)
    // NUXT_PUBLIC_APP_NAME in wrangler.toml [vars] overrides this at runtime
    public: {
      appName: 'Frontier Terminal',
      // Stamped at build time; /api/status reports it so a dashboard can tell
      // which commit is live. Public because a sha is not a secret and a
      // footer may want to show it.
      buildSha: buildSha(),
      // One sentence describing the product. Used as the landing page's meta
      // description, as the blockquote in /llms.txt, and as the schema.org
      // description — so an answer engine reads the same claim everywhere
      // rather than three paraphrases it has to reconcile.
      appDescription:
        'Tracking the frontier AI labs — API pricing, hiring, SEC filings. Every number carries its source URL and fetch timestamp.',
      // The app's canonical public origin, no trailing slash. Absolute links in
      // sitemap.xml, robots.txt, and og: tags are built from this.
      appUrl: 'http://localhost:3000',
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
  },

  // Nitro — Cloudflare Workers preset for production build
  nitro: {
    preset: 'cloudflare_module',
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
    scheduledTasks: SCHEDULED_TASKS,
  },

  compatibilityDate: '2025-09-01',
})
