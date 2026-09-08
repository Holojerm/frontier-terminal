# Ground-truth source audit — 2026-08-25

Five parallel audit agents live-fetched every candidate source (curl + WebFetch, no auth anywhere). Full raw reports are in the bootstrap session transcript (`transcripts/`). Every number below was fetched this session; interpretation is marked as such.

## Verdict table

| Axis | Provider | Source of record | Format | Diff mechanism | Verdict |
|---|---|---|---|---|---|
| Pricing + catalog | OpenAI | `developers.openai.com/api/docs/models.md` (+ per-model `.md`) | Markdown tables | body hash (ETag on pricing page) | **Include** |
| Pricing + catalog | Anthropic | `platform.claude.com/docs/en/models/overview.md` + `/docs/en/about-claude/pricing` | Markdown + semantic HTML table | body hash (no validators) | **Include** |
| Pricing + catalog | xAI | `docs.x.ai/developers/models.md` (+ per-model `.md`) | Markdown tables | body hash (1h cache TTL) | **Include** |
| Pricing + catalog | Google | `ai.google.dev/gemini-api/docs/pricing` | SSR HTML, 86 tables | If-Modified-Since (real `Last-Modified`) | **Include — hardest parse** |
| Pricing cross-check | (all 4) | `openrouter.ai/api/v1/models` | JSON, 419 models | 5-min cache, field diff | **Include as cross-check only** |
| Hiring | OpenAI | `api.ashbyhq.com/posting-api/job-board/openai` | JSON (5/5; dept+team inline; ~12 MB) | UUID ids, `publishedAt`, ETag | **Include** — 757 roles |
| Hiring | Anthropic | `boards-api.greenhouse.io/v1/boards/anthropic/jobs` (+`/departments` join) | JSON | numeric ids, `updated_at`, ETag | **Include** — 537 roles |
| Hiring | xAI | `boards-api.greenhouse.io/v1/boards/xai/jobs` | JSON | same as Anthropic | **Include with disclosed caveat** — 262 roles |
| Hiring | xAI | `boards-api.greenhouse.io/v1/boards/xai/departments` | JSON | numeric ids | **Include as join table** — added 2026-08-25T23:08Z, not part of the original sweep |
| Hiring | Google | none usable (careers.google.com = auth-walled SPA; DeepMind Greenhouse board is vestigial, 10 jobs) | — | — | **Cut** — display "no public feed" honestly |
| SEC | all + counterparties | `efts.sec.gov/LATEST/search-index` + `data.sec.gov/submissions/CIK{n}.json` | JSON, 5/5 | `startdt` param + accession numbers | **Include, narrowly scoped** |
| Demand share | (all 4) | `openrouter.ai/api/v1/datasets/rankings-daily` (bearer key, CC BY 4.0) | JSON, top 50/day + `other` | `(date, model_permaslug)` keys, append-only | **Include, keyed** — added 2026-09-08, see addendum; fixture constructed, not fetched |
| Demand share | (all 4) | Artificial Analysis data API | — | — | **Cut** — free tier is "Internal use only; no redistribution." (link only) |
| Demand share | (all 4) | LMArena / arena.ai | — | — | **Cut** — no data endpoint or license (link only) |
| Compute deals | mixed | RSS: OpenAI ✓, Google-AI ✓, NVIDIA ✓, Microsoft ✓; Anthropic = SPA no feed; xAI = hard 403 | RSS 2.0 | GUID diff | **Stretch goal only** (new-post tier, no extraction claims) |

## Key findings

**Pricing/catalog.** OpenAI, Anthropic, and xAI all serve real `text/markdown` docs endpoints (`.md` suffix) containing model id, context window, cutoff, and full price tables in one fetch — no auth, no browser, no bot wall. The marketing pages (`openai.com/api/pricing`, `x.ai/api`) are Cloudflare-403'd to any headless client and must never be dependencies. Google is the outlier: its `.md` trick returns a JS shell, and the models page's numbers are client-rendered — but the *pricing* page is genuine SSR HTML; the cost is DOM-context parsing (model names live in headings above table clusters) and dual-date promo strings ("$0.75 through Dec 31, 2026. $1.50 starting Jan 1, 2027."). OpenRouter's public JSON spot-check matched Anthropic's native table exactly, but it's a third-party restatement with no drift SLA and thin xAI coverage (6 vs 20+ SKUs) — cross-check, never source of record.

**Hiring.** The one axis with true structured JSON end to end. Live signal is already investor-grade: Sales is Anthropic's largest hiring category (88/537 reqs, 16%); 46% of xAI's reqs are Data Center construction and 15% are contractor-style "AI Tutor" roles. Trust caveat that must ship visibly: every xAI row carries `company_name: "SpaceXAI"` — the board is an entity-blended SpaceX/xAI artifact of the 2025 merger, and presenting it as pure xAI hiring would mislead.

**Addendum, 2026-08-25T23:08Z (post-sweep, prompted by "can xAI be separated from SpaceX?").** The xai board exposes the same `/departments` join Anthropic's does — missed in the original sweep, which read the jobs endpoint's null department field as "no departments available". Re-fetched both endpoints as a consistent pair (board had drifted 262 → 255 roles). The join does not split the entity, but it bounds the blend: all 255 jobs map to 26 departments, every one of them xAI-shaped (Data Center 121, Human Data 36, Engineering 23, Product 15, Safety 12), with no aerospace, launch, or propulsion function present; 2 of 255 titles name a SpaceX-side program (`SpaceXAI / Starlink` network ops, `SpaceXAI Battery Storage` civil engineer). Interpretation, marked as such: this is the board owner's own labelling, so it narrows how much SpaceX hiring could be hiding in the blend — it does not prove none is. The caveat stays; it now carries evidence.

**SEC.** The IPO wave is live: OpenAI confidentially filed ~2026-06-08 and Anthropic filed a draft S-1 ~2026-06-01 (press-reported; confidential DRS filings are *structurally invisible* on EDGAR until flipped public), and SpaceX now trades as SPCX with an S-1/A naming both xAI and Anthropic. EDGAR full-text search + a fixed CIK whitelist (MSFT 0000789019, AMZN, NVDA, SPCX 0001181412, GOOGL 0001652044) is the cleanest, most stable source in the entire terminal (federal API, UA header required, 10 req/s) and owns the single highest-value alert this product can fire: "the S-1 went public." Open keyword sweeps across all filers are confirmed noisy (micro-cap false positives) — whitelist only.

**Compute deals.** Detection is solvable for 4 sources via RSS; coverage is not honest to claim — the deals that matter break in the press (The Information, Bloomberg) before any company RSS post. New-post-with-agent-one-liner rides free on shared poll infra; structured deal extraction would be a trust liability. Cut from v1 promises.

**Addendum, 2026-09-08 — demand share.** For labs that are still private, the best public proxy for relative demand is OpenRouter's usage rankings: `GET /api/v1/datasets/rankings-daily` returns the top 50 public models per completed UTC day by total tokens plus one aggregated `other` row, needs `Authorization: Bearer <OPENROUTER_API_KEY>`, and is licensed CC BY 4.0 with the required citation "Source: OpenRouter (openrouter.ai/rankings), as of {meta.as_of}." plus "Licensed under CC BY 4.0" when the data is republished (docs read 2026-09-08). No key existed on the audit machine and no account was created, so the committed fixture is *constructed* from the documented schema and marked as such in `fixtures/manifest.json`; the source is recorded `skipped` — never fetched anonymously — until `NUXT_OPENROUTER_API_KEY` is set. Interpretation, marked as such: this is OpenRouter share, not market share — one aggregator's traffic — and every surface says so. Two alternatives were evaluated and cut: Artificial Analysis, whose data API free tier reads "Internal use only; no redistribution." (redistribution comes only with a commercial package), and LMArena (now arena.ai), which publishes no data endpoint or license. Both are linked as external references, never ingested.

## Recommended scope (decision pending)

Go deep on **pricing (+catalog byproduct)** and **hiring**; carry **SEC S-1 watch** as a thin high-value rider (~15 build-minutes); cut compute-deal extraction. Google: include for pricing (agent-assisted parse), honest "no feed" for hiring.

## Addendum, 2026-09-08 — status pages as a capacity-strain signal

Live-fetched with `curl -A "Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontier-terminal.jeremy-ettlinger.workers.dev)"` at 21:57Z; raw bodies committed whole under `fixtures/status/` (bytes and timestamps in `fixtures/manifest.json`). A private lab leaks operational strain through the incidents it posts; incident frequency per provider over time is first-party, deterministic, and free — but it is a proxy for what the vendor chose to post, never an SLA, and the caveats below say so.

| Axis | Provider | Source of record | Format | Diff mechanism | Verdict |
|---|---|---|---|---|---|
| Status | OpenAI | `status.openai.com/api/v2/incidents.json` | JSON, Statuspage v2 (`{page, incidents[]}`) | incident id + `status`/`resolved_at` | **Include** — 25 incidents in the feed (2026-08-05 → 2026-09-08), impacts none/minor/major, 1 open (`monitoring`, no `resolved_at` key) |
| Status | Anthropic | `status.claude.com/api/v2/incidents.json` (`status.anthropic.com` 301s here) | JSON, Statuspage v2 with `components` and `started_at` | same | **Include** — exactly 50 incidents (2026-07-21 → 2026-09-03), the page's cap; impacts 30 minor / 14 major / 3 critical / 3 none; components: claude.ai, Claude API (api.anthropic.com), Claude Code, Claude Cowork, Claude Console |
| Status | Google | `status.cloud.google.com/incidents.json` | JSON array, Google Cloud's own format (`begin`/`end`/`severity`/`status_impact`/`affected_products[]`) | incident id + `end` | **Include, filtered** — keep only incidents whose `affected_products[].title` contains "Gemini" (case-insensitive) or equals "Vertex AI". 6 incidents across 40 product titles in the feed; 1 kept (`Vertex Gemini API`, 2026-02-27, severity low). An Alphabet-wide count would conflate Compute/BigQuery/Spanner with Gemini — the same reasoning that cut Google hiring |
| Status | xAI | `status.x.ai/api/v2/incidents.json` | — | — | **Cut** — HTTP 403 (Cloudflare challenge HTML, 5503 bytes) to a non-browser client with a descriptive UA. Displayed as "no public feed", as Google hiring is |

**Findings.** Both Statuspage feeds are rolling windows (OpenAI ~1 month, Anthropic the 50-incident cap), so the first snapshot already carries a backlog: the pipeline records that first parse as a `baseline` run (entities only, no change rows), and the lane is append-only — an incident scrolling out of the feed is kept, never recorded as a removal. An incident that resolves is a `modified` change (`resolved_at` null → timestamp). Impact vocabularies differ and are stored verbatim (Statuspage none/minor/major/critical; Google low/medium/high); the UI never maps one onto the other. Incident URLs are composed (`page.url` + `/incidents/{id}`; `status.cloud.google.com/` + `uri`) — the feeds carry no canonical link field on the OpenAI page, and all three composed forms were checked to return 200. Interpretation, marked as such: OpenAI's page mixes ChatGPT-product incidents with API ones and carries no component field, so its count is "OpenAI operations", not "OpenAI API" — the Anthropic feed's components allow that split, OpenAI's does not.

## Addendum, 2026-09-08 — Mistral

Live-fetched with `curl -L` and a descriptive User-Agent at 22:30Z. Checked because it is the one other frontier lab with a public API price list; cut on both primary axes.

| Axis | Source | Result | Verdict |
|---|---|---|---|
| Hiring | `api.ashbyhq.com/posting-api/job-board/mistral` | **404** (9 bytes, `text/plain`) — the posting API is not enabled for the board | **Cut** |
| Hiring | `jobs.ashbyhq.com/mistral` | 200, 7 319 bytes of HTML shell; the board renders from an internal GraphQL endpoint that is not a supported surface | **Cut** |
| Pricing | `mistral.ai/pricing` | 200, 485 344 bytes, `text/html`: a client-side Astro app. `docs.mistral.ai/deployment/laplateforme/pricing` serves the identical bytes | **Cut** |
| Pricing | `docs.mistral.ai/llms.txt` | 200, 14 658 bytes. It lists a Pricing page (`/docs/deployment/laplateforme/pricing.md`) and a Models Overview page (`/docs/getting-started/models/overview.md`), but both links answer **404** with a 462 KB HTML shell — no markdown surface exists | **Cut** |

**Findings.** The docs llms.txt advertises markdown pages that do not resolve, so the only pricing surface is the HTML app; model slugs and a few prose prices are present in its source, so a Google-style HTML parse is conceivable. Interpretation, marked as such: with no hiring feed to pair it with, a fifth lab on a single axis would cost a parser and buy one column — it is registered as a cut (`sources.yaml` `cut.mistral`) so the terminal can say why, and nothing about Mistral appears in the UI.
