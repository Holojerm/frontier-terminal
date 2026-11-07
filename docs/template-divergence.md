# Template divergence

Template-owned files (`app|server|shared|scripts`, minus migrations and the template's `app-owned.json`) are either byte-identical to `Holojerm/nuxt-cf-template` or declared in `fleet.json` › `template.customized`. This file gives each declared entry its reason; fleet reports any difference not listed there as `core_undeclared`.

An entry ending in `/` is a directory prefix: it also declares template files this app removed on purpose. Read `AGENTS.md` for what the product is: a public, read-only data site with no accounts, billing, blog or customer email.

## Removed: accounts and sign-in

- `app/components/Auth/` — sign-in UI; no accounts (fleet.json features.auth is false)
- `app/middleware/` — route middleware that gates signed-in and subscribed pages; there are none
- `app/pages/account.vue` — account page; no accounts (fleet.json features.auth is false)
- `app/pages/login.vue` — sign-in page; no accounts (fleet.json features.auth is false)
- `app/pages/auth/` — magic-link verification page; no accounts (fleet.json features.auth is false)
- `app/pages/dashboard.vue` — signed-in dashboard; no accounts (fleet.json features.auth is false)
- `app/types/auth.d.ts` — session type augmentation; no accounts (fleet.json features.auth is false)
- `app/utils/` — helpers for the removed account, admin, checkout, pricing and changelog pages
- `server/api/account/` — account endpoints (export, notifications, sessions); no accounts (fleet.json features.auth is false)
- `server/api/auth/` — sign-in endpoints (OAuth, magic link, logout); no accounts (fleet.json features.auth is false)
- `server/utils/account-email.ts` — account emails; no accounts (fleet.json features.auth is false)
- `server/utils/account.ts` — account deletion and export; no accounts (fleet.json features.auth is false)
- `server/utils/auth-email-templates.ts` — sign-in email bodies; no accounts (fleet.json features.auth is false)
- `server/utils/auth-providers.ts` — OAuth provider config; no accounts (fleet.json features.auth is false)
- `server/utils/auth.ts` — session and sign-in helpers; no accounts (fleet.json features.auth is false)
- `server/utils/magic-link.ts` — magic-link tokens; no accounts (fleet.json features.auth is false)
- `server/utils/session-guard.ts` — session revocation check; no accounts (fleet.json features.auth is false)
- `server/utils/turnstile.ts` — bot check on sign-in forms; no accounts (fleet.json features.auth is false)
- `server/utils/users.ts` — users table helpers; no accounts (fleet.json features.auth is false)
- `server/utils/public-routes.ts` — public-API registry read only by server/middleware/auth.ts, which this app does not have; every /api route is public or bearer-gated in its own handler
- `server/middleware/auth.ts` — session guard; no accounts (fleet.json features.auth is false)
- `shared/utils/account.ts` — account shapes; no accounts (fleet.json features.auth is false)
- `server/tasks/purge-expired-tokens.ts` — the template's example scheduled task: purges magic-link and connect-code tokens; no accounts (fleet.json features.auth is false)

## Removed: admin console

- `app/pages/admin/` — admin console; no accounts to administer
- `server/api/admin/` — admin endpoints; no accounts to administer
- `server/utils/admin.ts` — admin gate; no accounts
- `server/utils/audit.ts` — append-only audit trail of privileged actions; no accounts

## Removed: billing and entitlements

- `server/utils/sql.ts` — SQL fragments shared by the entitlement code; no billing (fleet.json features.billing is false)
- `server/utils/access-gate.ts` — the seam billing registers its paid-access check through; no billing (fleet.json features.billing is false) and no gated pages
- `server/utils/billing-outcome.ts` — the seam billing's webhook calls after an event; no billing (fleet.json features.billing is false)
- `server/utils/earned-access.ts` — the seam referral rewards grant access through; no billing or referrals
- `server/utils/entitlement-view-fields.ts` — the seam features add fields to the billing view through; no billing (fleet.json features.billing is false)

## Removed: onboarding, referrals and lifecycle email

- `app/components/Onboarding/` — onboarding checklist; nothing to onboard
- `server/api/onboarding.get.ts` — onboarding state; no accounts (fleet.json features.auth is false)
- `server/api/onboarding/` — onboarding activation; no accounts (fleet.json features.auth is false)
- `server/utils/onboarding.ts` — onboarding signals; no accounts (fleet.json features.auth is false)
- `server/utils/lifecycle-emails.ts` — lifecycle email bodies; no customers to email
- `server/utils/lifecycle-steps.ts` — lifecycle email schedule; no customers to email
- `server/utils/lifecycle.ts` — lifecycle email sender; no customers to email
- `server/tasks/lifecycle-email.ts` — lifecycle email cron; no customers to email
- `shared/utils/onboarding-steps.ts` — onboarding step list; no accounts (fleet.json features.auth is false)
- `shared/utils/onboarding.ts` — onboarding rules; no accounts (fleet.json features.auth is false)
- `shared/utils/referral-code.ts` — referral code alphabet and shape, read by attribution.ts; no accounts (fleet.json features.auth is false)
- `server/utils/signup-contributors.ts` — the seam features add columns and welcome grants to a new account through; no accounts (fleet.json features.auth is false)

## Removed: customer email and notifications

- `app/pages/unsubscribe.vue` — unsubscribe page; no mailing list (the ops digest goes to the owner)
- `server/api/email/` — unsubscribe endpoints; no mailing list
- `server/plugins/email-queue-consumer.ts` — transactional email queue consumer; the ops digest uses the send_email binding directly
- `server/utils/email-queue.ts` — transactional email queue; the ops digest uses the send_email binding directly
- `server/utils/email-templates.ts` — transactional email bodies; none are sent
- `server/utils/email.ts` — transactional email sender; none are sent
- `server/utils/notifications.ts` — per-user notification preferences; no accounts (fleet.json features.auth is false)
- `server/utils/unsubscribe.ts` — unsubscribe tokens; no mailing list
- `shared/utils/notifications.ts` — notification preference shapes; no accounts (fleet.json features.auth is false)

## Removed: analytics and attribution

- `app/plugins/attribution.client.ts` — signup attribution capture; no signups
- `app/plugins/posthog.client.ts` — PostHog client; fleet.json features.posthog is null
- `server/routes/ingest/` — PostHog reverse proxy; fleet.json features.posthog is null
- `server/utils/posthog.ts` — PostHog server client; fleet.json features.posthog is null
- `server/utils/ingest-headers.ts` — header allowlist for the PostHog relay; fleet.json features.posthog is null
- `server/utils/ingest-relay.ts` — the PostHog relay's forwarding and optional rate limit; fleet.json features.posthog is null
- `app/composables/useFlag.ts` — PostHog feature flags; fleet.json features.posthog is null
- `app/composables/useFragmentParams.ts` — reads credentials from the URL fragment of sign-in and unsubscribe links; no accounts (fleet.json features.auth is false)
- `shared/utils/attribution.ts` — signup attribution shapes; no signups
- `server/utils/fleet-funnel.ts` — signup-to-paid funnel counters for /api/fleet; no signups or payments

## Removed: blog, changelog and legal pages

- `app/pages/blog/` — blog; the site publishes data, not posts (no content/ collection)
- `server/api/blog/` — blog endpoints; no content/ collection
- `server/utils/blog.ts` — blog queries; no content/ collection
- `shared/utils/blog.ts` — blog visibility rule; no content/ collection
- `app/pages/changelog.vue` — changelog; the alerts feed is the changelog
- `app/pages/privacy.vue` — template privacy policy names accounts and a payment processor; this site has neither (the terminal layer ships its own about, data and licence pages)
- `app/pages/terms.vue` — template terms describe a subscription; this site has none (the terminal layer ships its own licence page)

## Removed: other template pieces

- `server/api/mcp/` — mints OAuth connect codes for a signed-in user to the template MCP worker; this app has no mcp/ worker (the terminal layer serves /mcp itself, with no auth)
- `scripts/x-post.ts` — posts to X directly with OAuth 1.0a credentials; this app posts through layers/social (Buffer)
- `scripts/lib/oauth1.ts` — OAuth 1.0a signing for x-post.ts
- `server/utils/purge.ts` — retention for the single-use credential tables (magic-link tokens, MCP connect codes); this app has neither (ops events are pruned by pruneOpsEvents)
- `scripts/check-forkless.ts` (and the `forkless:check` / `ci:forkless` steps) — the template's proof that a fork can drop billing, referral and lifecycle email; it builds those forks in temp copies, so it is the template's gate, not a fork's
- `server/types/extension-types.ts`, `test/lib/layers.ts` — what the template's full extensions registry and its billing-aware browser specs import; this app's trimmed `extensions.ts` and its own a11y/CSP route lists use neither

## Customized: kept on purpose

- `nuxt.config.ts` — module list, runtimeConfig, security headers, cron map and the product routeRules are this app's; `hub.dir` reads `NUXT_HUB_DIR` so the browser suites get their own data dir (upstream candidate)
- `playwright.config.ts` — the suites' server runs on `.data-browser` (`NUXT_HUB_DIR`, wiped per run) and `test/warmup/fill-store.ts` fills it from fixtures before the warmup (upstream candidate: the separate data dir and a fork-supplied fill step)
- `test/a11y/accessibility.spec.ts` — the product's route list, and a duplicate-id assertion after axe, which only flags ids that ARIA references (upstream candidate: the assertion)
- `test/warmup/global-setup.ts` — warms one path per page file the suites visit, not just the shell; a cold page compile ran past 30s on the two-core runner (upstream candidate: the per-page rule)
- `app/composables/useSeo.ts` — adds dateModified and about inputs and a repoUrl in the site context in place of supportEmail and legalEntity (upstream candidate: dateModified/about)
- `scripts/check-design-tokens.ts` — the app's own palette ramp in the allowed-color list is `iris`, not `clay`
- `scripts/check-mirrors.ts` — reference pass only; the template's mirror pass compares server/utils/users.ts with mcp/src/server.ts, neither of which exists here (upstream candidate: skip a mirror whose files are absent)
- `scripts/check-seo.ts` — no content/blog pass; adds a rule that every publicPage value is a literal, because Nuxt drops the whole key otherwise (upstream candidate)
- `scripts/ci.ts` — the gate list matches this app's checks: no `forkless:check` (not a template fork shape with optional billing/referral layers to strip); adds `globals:check`, the module-load gate for Workers' deploy error 10021 (upstream candidate)
- `scripts/generate-brand-assets.ts` — display face at weight 500 and waits for the font stylesheets before shooting the OG image (upstream candidate: the stylesheet wait)
- `server/api/status.get.ts` — public, with per-source freshness: the status payload is built by collectStatus() in fleet-status.ts, which the MCP get_status tool shares
- `server/plugins/error-logger.ts` — no PostHog $exception capture or session lookup; logs errorDetail() from the terminal layer so the cause of a D1 fault reaches the digest
- `server/routes/llms.txt.get.ts` — no blog; a static map (no D1) that adds the data tables, the MCP endpoint and the licence block, shared with the MCP describe tool via crawler-pages.ts
- `server/routes/sitemap.xml.get.ts` — no blog; dates each data page from its newest change row (dataLastmods) and lists the layer's static lab, compare and thesis pages
- `server/tasks/ops/alert.ts` — records its own heartbeat (upstream candidate: the freshness registry and `withHeartbeat()`), and runs every five minutes rather than 30 so a critical event waits at most one tick; the watchdogs (every scheduled task's heartbeat, the judge routine, the GDELT job, the social outbox, launch coverage, deploy drift) run half-hourly in the layer's `ops:watch`
- `server/tasks/seo/indexnow.ts` — ends in `export default withHeartbeat(task)` so the freshness checks see it run, like every task here (upstream candidate, with the registry)
- `server/utils/extensions.ts` — trimmed to the fleet extra-counter registry; account, admin, onboarding and purge contributors, and the deletion guard and resolver, view-as, funnel-stage, lifecycle-step, access-gate, billing-outcome, earned-access, entitlement-view and signup registries, belong to the removed subsystems
- `server/utils/fleet-status.ts` — no users, entitlements or funnel counters; adds collectStatus() and latestFetchBySource() for the public status payload
- `server/utils/hash.ts` — no `clientIpHash()`: it salts with the template's session secret, which this app has no use for; nothing here hashes an IP, and `clientIp()` is kept for rate limiting
- `server/utils/ops.ts` — a hold per tier (`OPS_HOLD_MS`: critical none, warning 25 minutes, info a day) in place of the template's info-only hold, for a five-minute drain (upstream candidate)
- `server/utils/seo.ts` — adds per-page lastmods, the data-tables and licence blocks of llms.txt; no blog, support or legal-entity lines
- `shared/utils/schema.ts` — Dataset, DataCatalog and lab Organization nodes in place of Offer, SoftwareApplication and BlogPosting
- `shared/utils/site.ts` — adds canonicalRedirect() (workers.dev to the custom domain) and strips characters XML 1.0 cannot carry in escapeXml (upstream candidate: the XML stripping)

## Layers

Vendored: `social` (pinned in `layers.lock.json`). Fork-owned, never in the lock: `terminal`.

Left out on purpose, so the absence is a decision and not a gap:

- `billing`, `referral`: no payments or accounts. Their core seams are not carried either (see the billing and onboarding sections above).
- `feedback`: there are no accounts to attribute a message to. `/contact`, shipped by the `terminal` layer, is the channel.
- `files`: the site takes no uploads.
