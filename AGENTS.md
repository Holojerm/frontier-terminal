# Project Standards & AI Development Guide

The coding, design and product standards for this project. This file is the **index**: it loads
into every session, so anything not needed on every task lives in [`.claude/docs/`](.claude/docs/)
and is read on demand.

Frontier Terminal is a free, public, read-only terminal of fundamentals on the frontier AI
labs (OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Alibaba (Qwen), Moonshot AI (Kimi)).
Per lab: API price lists, hiring, SEC filings and disclosed revenue, status-page incidents and
latency probes, misalignment disclosures, and OpenRouter demand share. Around the labs, on one
spine (labs → compute → hardware → power): the public companies tied to them (exposure,
dependencies, suppliers, listed companies and their hiring), compute (GPU prices), hardware
(Taiwan monthly revenue, Korea chip exports), power (data-center sites, grid load), and ground
truth (press reports and earnings-call guidance scored against later filings). Every series
registers in a signal registry, and /signals grades it against the stocks it should lead.
The data is the product; theses are a retail-facing layer on top. No accounts, no sign-in, no
payments. Every datum carries its source URL and fetch timestamp.

---

## Where things are documented

Read the row that matches what you are about to touch. Do not load them all.

| Doc | Covers | Load it when |
| --- | --- | --- |
| [`.claude/docs/gotchas.md`](.claude/docs/gotchas.md) | Silent failure modes: wrong-file databases, migrations that never run, empty sitemaps, no-op rate limiters | Something "works" but produces no output; or you touch D1, migrations, deploy config, cron, `definePageMeta`, or a worktree |
| [`.claude/docs/local-data.md`](.claude/docs/local-data.md) | Filling the empty local store: fixtures offline, a live poll, production's alerts | Before judging anything visual locally, or touching the browser suites' setup |
| [`.claude/docs/voice.md`](.claude/docs/voice.md) | How copy sounds, the AI patterns to cut, the quote/number rules | Writing anything a visitor reads: page text, panel notes, SEO strings, `llms.txt`, gap strings, README |
| [`.claude/docs/patterns.md`](.claude/docs/patterns.md) | Worked examples: components, API routes, Drizzle queries, error handling | Writing a new component, route, or query |
| [`.claude/docs/seo.md`](.claude/docs/seo.md) | `useSeo()`, `publicPage` meta, structured data, the crawler files | Adding or editing a page |
| [`.claude/docs/brand.md`](.claude/docs/brand.md) | How every icon is generated from one `Logo.vue` | Redesigning the mark or fixing `brand:check` |
| [`.claude/docs/email.md`](.claude/docs/email.md) | The Maizzle/Mustache pipeline behind the weekly thesis digest | Touching `emails/`, the thesis digest, or adding an email |
| [`.claude/docs/agent-setup.md`](.claude/docs/agent-setup.md) | MCP servers, skills, slash commands, cloud routines | Configuring tooling |
| [`docs/template-divergence.md`](docs/template-divergence.md) | Why each template-owned file differs from `nuxt-cf-template`, or is absent | Syncing the template, or touching a file listed in `fleet.json` › `template.customized` |
| [`.claude/docs/fleet.md`](.claude/docs/fleet.md) | `fleet.json`, `/api/status`, `/api/fleet`, the `ops_events` spool and its fleet alerts | Touching the manifest, the status/fleet endpoints, or ops alerting |
| [`.claude/docs/surfaces.md`](.claude/docs/surfaces.md) | Every place a dataset has to reach (pages, lab page, tear sheet, MCP, export, alerts), `bun run surfaces:check` and its waivers | Adding a dataset, route, table or page |
| [`DESIGN.md`](DESIGN.md) | The visual design system (source of truth) | Writing any UI |

**Three gotchas fail with no error at all:** local D1 lives in two places and only
`.data/db/sqlite.db` is real; **production D1 is migrated only by the Workers Builds deploy
command `bun run deploy:ci`** (migrate, then deploy; a manual `bun run deploy` skips it, so run
`bun run db:migrate:remote` after one); and `bun dev` caches its DB connection, so an external
write needs a restart. The rest are in [`.claude/docs/gotchas.md`](.claude/docs/gotchas.md).

---

## Stack

| Layer        | Technology                 | Notes                                                            |
| ------------ | -------------------------- | ---------------------------------------------------------------- |
| Framework    | **Nuxt 4** (v4.4+)         | Full-stack Vue framework                                         |
| UI Library   | **NuxtUI v4**              | Component library                                                |
| Styling      | **Tailwind CSS v4**        | Via NuxtUI                                                       |
| Backend      | **Cloudflare Workers**     | Via NuxtHub + Nitro                                              |
| Database     | **Cloudflare D1** (SQLite) | Drizzle ORM; `db` + `schema` auto-imported by NuxtHub            |
| KV Store     | **Cloudflare KV**          | Cache                                                            |
| Object Store | **Cloudflare R2**          | Raw fetched payloads, so every derived number has its source bytes |
| Deployment   | **Wrangler**               | `bun deploy` → `wrangler deploy`                                 |
| CI/CD        | **Workers Builds**         | `bun run ci` + deploy on push (see README)                       |
| Lint/format  | **oxlint**, **oxfmt**      | `.oxlintrc.json`, `.oxfmtrc.json`                                |
| Validation   | **Zod**                    | All input + API I/O                                              |

---

## Directory Structure

```
/
├── layers/                 # The product: fork-owned Nuxt layers, each with app/, server/, shared/, test/;
│                           # auto-registered, not in layers.lock.json (social is vendored). Direction:
│                           # core ← domains ← alerts / theses / signals ← terminal (domains.config.ts).
│   ├── core/               # What every domain builds on: the ingest store and its contracts, the poll
│   │                       # engine, the archive capture log, query plumbing (terminal-db, -asof, -cache,
│   │                       # -handler), the export and MCP frameworks with /export and /mcp, the judge
│   │                       # runner, API keys, events producer, heartbeats, reader prefs, and the UI kit
│   │                       # every page is built from (app/components/Terminal/). Names no domain.
│   ├── pricing/            # Price lists, the class map, archived prices and rate limits, /prices.
│   ├── talent/             # Careers boards, the hiring floor, archived boards, pay, listed-company hiring.
│   ├── reliability/        # Status feeds, incidents, latency probes, the reliability record. Reads pricing.
│   ├── adoption/           # OpenRouter rankings and spend, npm/PyPI/GitHub/Ramp, /rankings. Reads reliability.
│   ├── models/             # Releases, the launch tripwire and watch, misalignment disclosures. Reads pricing.
│   ├── companies/          # EDGAR and SEC filers, revenue, filed facts and guidance, calls, exposure,
│   │                       # identifiers, parents, dependencies, suppliers, /filings, /exposure.
│   ├── compute/            # GPU prices, data centers, power sites, grid load, prints, /compute, /power,
│   │                       # /hardware. Reads companies.
│   ├── press/              # GDELT, reported figures, the track record, ground truth, press notes. Reads companies.
│   ├── alerts/             # The alert feed and overview band, alerts.xml, the events consumer, webhooks,
│   │                       # social posts, digest subscribers. Reads pricing and press.
│   ├── theses/             # Theses, claims and verdicts, the evaluator, the weekly digest.
│   ├── signals/            # The signal registry, event-study harness, forward calls, market data.
│   └── terminal/           # The shell: what reads several domains at once (the lab page, tear sheet,
│                           # compare, /revenue, /dependencies, /hiring, /incidents, /data, the site
│                           # pages, the listed and utilization views, the ticks that run several
│                           # domains after one poll, the ops watch, the crawler page lists, OG cards).
├── domains.config.ts       # Which fork-owned layer may import which (bun run domains:check)
├── app/                    # Template frontend: app.config.ts (GENERATED from DESIGN.md), Brand/Logo.vue
│                           # (every icon is generated from it), layouts, composables (useSeo), types
│                           # (seo.d.ts augments PageMeta)
├── server/                 # Template backend (Nitro / Cloudflare Workers)
│   ├── api/                # Template routes: status, fleet, health (the product's are in the layers)
│   ├── db/
│   │   ├── schema.ts       # Composition root: ops tables + re-export of every layer's tables
│   │   └── migrations/     # Generated by drizzle-kit (app-owned)
│   ├── registries/         # Composition roots for what lists every domain: lanes, scopes, MCP tools,
│   │                       # export tables, recipes, judge reviews, parsers, the dictionary and crawler
│   │                       # pages. Core and the app's routes read them via #server/registries
│   ├── routes/             # robots, sitemap, llms.txt, manifest (route table); core holds export/
│   │                       # and mcp.ts, alerts the alerts.xml feed
│   ├── tasks/              # seo:indexnow; cron wiring in nuxt.config + wrangler.toml (every other
│   │                       # task is in its layer)
│   └── utils/              # Core server utilities (ops, fleet, rate limit, SEO, mail)
├── shared/                 # Auto-imported in BOTH app/ and server/: site.ts (URL identity), schema.ts
│                           # (JSON-LD), fleet-manifest.ts, license.ts; API shapes are in each layer's shared/types/
├── sources.yaml            # Source registry: axis, diff mechanism, include/exclude verdict per source
├── fixtures/               # Captured source bytes + manifest.json (fetch times); parsers test offline
├── test/                   # core vitest units; test/a11y + test/csp are the Playwright browser suites
│                           # (the product's units: layers/<name>/test/)
├── docs/                   # source-audit.md: every candidate source, fetched and judged
├── scripts/                # CI gates and one-off scripts
├── public/                 # Static assets; og.png, favicon.svg, apple-touch-icon.png are generated
├── .github/                # Dependabot + browser-suites.yml (axe/CSP; Workers Builds can't launch Chromium)
├── emails/                 # Maizzle sources, compiled by bun run email:build
├── fleet.json              # How this app describes itself to the portfolio dashboard (bun run fleet:check)
├── DESIGN.md               # Visual design system, source of truth (/design-sync)
└── brand.lock.json         # Fingerprint of the generated brand assets (bun run brand:check)
```

**A domain layer** owns its pages, components, API routes, queries, recipes, tables
(`server/db/schema.ts`, re-exported from the app's), curated JSON, tasks, MCP tools, export tables
and tests. It imports only `core`, plus another domain's public files where `domains.config.ts`
allows it (reliability reads pricing's class map). It registers through the app: one line each in
`server/registries/` and `server/db/schema.ts`, and a row in `domains.config.ts` whose `uses` lists
only layers it imports and whose `public` list names only files another layer reads
(`bun run domains:check` fails on a stale entry of either kind).
- **Imports:** relative inside a layer; `#layers/<name>/…` across layers, except in `shared/` and
  schema files, which use relative paths because bun scripts and drizzle-kit load them outside Nuxt.
- **Placement:** code that reads several domains goes in `terminal`, the shell. Mechanism every
  domain shares goes in `core`, with the domain parts as registry entries.
- **Core and the app root never import the shell.** They reach it, like any layer above core,
  through `server/registries/` (the dictionary, the crawler pages, the judge's alert screen).
- **Tick inputs and scopes:** a value every parse of a tick reads from a domain (the class map) is
  a tick input in `server/registries/lane-context.ts`, not a parameter of the refresh. Which
  sources ride which poll tick is a domain's `ScopeEntry` in `server/registries/scopes.ts`; the
  tick policy is core's.

---

## Coding Standards

- **TypeScript everywhere.** No `.js` files except config files that require it. Strict mode stays on.
- **No `any` types.** Use `unknown` and narrow, or define proper types.
- **Nuxt auto-imports.** Never import what Nuxt auto-imports: Vue and Nuxt composables, NuxtHub's `db`/`schema`/`kv`/`blob`, and each layer's `server/utils`, `shared/{utils,types}` and `app/{utils,composables}`. Those top-level folders are a layer's published API; nested folders are internals, imported by relative path.
  Schema files, `scripts/`, config files and what they import run outside Nitro and Vite, so they keep explicit imports.
  Never instantiate Drizzle manually in server code.
- **Validate all inputs with Zod**: `getValidatedQuery` / `readValidatedBody` on the server.
- **No `console.log` in committed code.** Use `console.warn`/`console.error` for real issues only.
- **Ask before adding a dependency.** Prefer what's already installed.
- **Worked examples** (a `<script setup>` component, a Zod-validated API route, Drizzle queries,
  error handling) are in [`.claude/docs/patterns.md`](.claude/docs/patterns.md). Copy those shapes.

---

## Design Standards

**[DESIGN.md](DESIGN.md) is the source of truth for the visual design** (color, type, space,
motion, component behavior). Read it before writing any UI. `app/assets/css/main.css` and
`app/app.config.ts` are *compiled from it* by `/design-sync`, so hand edits don't survive.
`bun run design:check` (part of `bun run ci`) fails on anything that bypasses the token layer.
The dev-only `/design-system` route renders every token and component state in both color modes;
use it to verify a design change landed.

**The brand mark** is drawn once, in [`app/components/Brand/Logo.vue`](app/components/Brand/Logo.vue).
`bun run brand:generate` cuts every other file from it and `bun run brand:check` fails when they
drift. Never hand-edit generated files in `public/`. Details: [`.claude/docs/brand.md`](.claude/docs/brand.md).

### Component Usage

- **Use NuxtUI components first** (`<UButton>`, `<UModal>`, `<UTable>`, …) before building one.
- **Product code goes in a fork-owned layer** (`layers/core/` for what every domain shares,
  `layers/<domain>/` for one domain's, `layers/terminal/` for what reads several), mirroring the
  app's folders. The app keeps template code and the registries.
- **Server routes go in the owning layer's `server/api/`**, pages in its `app/pages/`. Anything a
  domain adds to a list of every domain (a lane, an MCP tool file, an export table file, a recipe)
  also gets its line in `server/registries/`.
- **Components are grouped by feature** (`components/[Feature]/`) and named in PascalCase
  (`PricingTable.vue`, `FilingList.vue`).

### Styling Rules

- **Tailwind utility classes only.** No custom CSS files except for truly global styles.
- **No inline `style` attributes** except for animated dynamic values (`style="width: ${progress}%"`).
- **Colors**: NuxtUI v4's semantic utilities, so light/dark mode works for free (`UColorModeButton`
  handles the switch). Never a numbered scale (`text-gray-900`, `bg-slate-50`) or a raw hex;
  `bun run design:check` fails on both.
  - Text: `text-default` (body), `text-muted` (secondary), `text-dimmed` (placeholders), `text-toned` (subtitles), `text-highlighted` (headings), `text-inverted`
  - Background: `bg-default` (page), `bg-muted` (subtle sections), `bg-elevated` (cards, modals), `bg-accented` (hover), `bg-inverted`
  - Border: `border-default`, `border-muted`, `border-accented`, `border-inverted`
  - Semantic colors: `text-primary`, `bg-primary`, `border-primary`, likewise for `secondary`/`success`/`info`/`warning`/`error`/`neutral`
  - `text-foreground`, `bg-background` and `border-border` are shadcn tokens and resolve to nothing here.
- **Spacing**: the standard Tailwind scale (4, 8, 12, 16, 24, 32…). Don't invent sizes.
- **Mobile-first**: layouts start mobile and expand with `sm:`, `md:`, `lg:`.
- **Accessibility**: [DESIGN.md › Accessibility](DESIGN.md) is the contract: AA contrast, a
  visible focus ring on everything focusable, `alt` on every image, `aria-label` on icon-only
  buttons, `min-h-dvh` over `min-h-screen`, and `bottom-safe`/`right-safe` for anything pinned
  to a viewport edge. `bun run design:check` catches the machine-checkable half. `bun run test:a11y`
  owns contrast, landmark uniqueness and heading order: it runs axe over every public route in
  both color modes, plus the CSP spec in `test/csp/`, so it is the whole browser gate.

---

## Product Standards

One-line versions; each links to its full contract.

- **Provenance**: every datum carries a source URL and a fetch timestamp. Trustworthiness is the
  depth axis of this project; never trade it for a feature.
- **Errors**: `<UAlert>` on the client, `createError({ statusCode })` on the server, never a raw
  error message to a user. → [`patterns.md`](.claude/docs/patterns.md)
- **Public API**: every `/api/*` route is public and read-only, except five bearer-gated ones:
  - `/api/fleet`: the portfolio dashboard;
  - `/api/judge/*`: the judge routine, a writer (`layers/core/server/utils/judge-auth.ts`);
  - `/api/ops/events`: the ops-triage routine's read of the ops spool (`NUXT_OPS_TOKEN`);
  - `/api/gdelt/*`: the Mac mini job that reads GDELT's 15-minute GKG files and posts back the
    rows naming a tracked lab, filer or model family, a writer (`NUXT_GDELT_TOKEN`);
  - `/api/relay/*`: the mini's relay job (same token), which fetches the hosts that refuse
    Workers' egress and posts the bytes back (`layers/core/server/pipeline/relay.ts`).

  No session. A route that takes input validates it with Zod and calls `rateLimit()`
  (`rateLimitTerminal()` on the public product routes). Licensees may send an owner-issued API
  key (`Authorization: Bearer ftk_…`, `bun run keys:issue`). No page, llms.txt line or API
  message advertises keys. A key only raises the rate limit, lists the full-history bulk files,
  labels older rows with the paid license, and opens `/export/payloads/*` (systematic,
  `rights: ours` sources). It never changes the data, and a bad key is a 401, never anonymous.
  → `layers/core/server/utils/api-access.ts`
- **SEO & AEO**: every page calls `useSeo()` exactly once and declares `publicPage`;
  `bun run seo:check` fails otherwise. → [`seo.md`](.claude/docs/seo.md)
- **Performance**: server-side `useFetch` for initial loads, `defineAsyncComponent` for heavy
  components, raw payloads to R2 via `blob`. → [`patterns.md`](.claude/docs/patterns.md)
- **Fleet contract**: `fleet.json` describes this app, `GET /api/status` reports build,
  migrations and crons, `GET /api/fleet` reports counters behind a token, and every 5xx spools
  an `ops_events` row that the fleet dashboard reads (`ops.kinds`) and mails.
  → [`fleet.md`](.claude/docs/fleet.md)

---

## Git Workflow

- **`main`** is production and auto-deploys via Cloudflare Workers Builds.
- **Branches** `feat/pricing-parser`, `fix/sitemap-lastmod`, `chore/update-deps`; **commits**
  `feat: add pricing parser`.
- **PRs require** lint + typecheck + tests, enforced by the Workers Builds check.

---

## Common Commands

```bash
bun dev               # Dev server at https://<portless-name>.localhost (in a linked worktree,
                      # <worktree-dir>.<portless-name>.localhost; printed on start)
bun dev:app           # Bypass portless: nuxt dev on http://localhost:3000
bun run dev:poll      # Fill the local store via the running dev server: live sources, or --fixtures offline
bun run dev:seed      # Copy production's last 90 days of alerts + changes into the local DB (dev server stopped)
bun build             # Build for Cloudflare
bun lint / lint:fix   # oxlint
bun format / format:check # oxfmt, writing or checking
bun run design:check  # Fail on UI code that bypasses the DESIGN.md token layer
bun run brand:generate # Rebuild favicon.svg, apple-touch-icon.png and og.png from the brand mark
bun run brand:check   # Fail when those generated files no longer match the mark
bun run email:build   # Compile emails/templates/ → server/emails/generated.ts (gitignored; postinstall and ci run it)
bun run email:dev     # Maizzle dev server with sample data (email:preview writes the files out)
bun run mirror:check  # Fail when a comment or doc names a file, symbol, or variable that no longer exists
bun run seo:check     # Fail on pages that bypass useSeo() or aren't declared public/noindex
bun run fleet:check   # Fail when fleet.json stops matching wrangler.toml (names, binding ids, crons)
bun run crons:check   # Fail when [triggers] crons and nitro.scheduledTasks disagree, or a task has no file
bun run methods:check # Fail when a GET/HEAD/DELETE route reads a request body (a Workers handler never receives one)
bun run surfaces:check # Fail when a product route or table misses a surface (page, lab page, tear sheet, MCP tool,
                      # export, alert axis) that surfaces.waivers.ts doesn't waive, or a waiver is stale. --matrix prints it
bun run domains:check # Fail when a layer imports (or auto-imports) a layer domains.config.ts does not let it,
                      # the app root reaches past core outside server/registries/, two owners define one
                      # auto-imported name, a uses/public entry is unused, or a ?raw import has no file
bun run test:a11y     # Playwright/Chromium: axe over every public route (light + dark) AND the CSP spec (test/csp/)
bun run perf          # Page-load harness: throttled cold-cache runs per route, medians, Server-Timing
                      # stages, --bust to skip the HTML cache, --out/--compare for before/after
bun typecheck         # TypeScript type checking
bun db:generate       # Generate a Drizzle migration after schema changes
bun db:migrate        # Apply migrations to local D1
bun run db:migrate:remote # Apply migrations to production D1 (Workers Builds runs it via deploy:ci)
bun db:studio         # Drizzle Studio
bun run keys:issue -- --client "<name>" --tier research|systematic --months 12 [--remote]
                      # Licensee API key: prints the key once, stores its SHA-256 (keys:list, keys:revoke)
bun run ci            # Every gate, concurrently (scripts/ci.ts): format, email:build, lint, the *:check gates,
                      # typecheck, test, build. Workers Builds runs this. No browser suites (that image can't
                      # launch Chromium). CI_SERIAL=1 runs the gates one at a time.
bun run ci:fast       # While iterating: format, cheap gates + typecheck + tests touched since origin/main, no build
bun run ci:browser    # playwright:install + test:a11y (what GitHub Actions runs)
bun run deploy        # Manual wrangler deploy (normally unnecessary: Workers Builds deploys on push to main).
                      # Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

`bun run ci` is the merge gate on finished work: iterate with `bun run ci:fast`, run `bun run ci`
once before pushing, and again after any change you think is trivial. It runs every gate even
after one fails and prints only the failures. Fix a failure; never work around it. Locally both
modes run the formatter in write mode, so commit what it rewrote; in CI (`CI` set) it runs
`format:check`, so an unformatted commit fails the Workers Builds check. Edits made through
Claude Code are formatted by a PostToolUse hook (`scripts/format-edited.ts`).

---

## Agent tooling

MCP servers, the NuxtUI skill, slash commands and the cloud routines:
[`.claude/docs/agent-setup.md`](.claude/docs/agent-setup.md).

Parallel agent worktrees under `.claude/worktrees/<name>` are supported, and every gate in
`bun run ci` is scoped to its own checkout. The rules that keep it that way, and the three
things that have broken it, are in [`.claude/docs/gotchas.md`](.claude/docs/gotchas.md).
