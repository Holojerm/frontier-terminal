# Ground-truth source audit — 2026-08-25

Five parallel audit agents live-fetched every candidate source (curl + WebFetch, no auth anywhere). Full raw reports are in the bootstrap session transcript (`transcripts/`). Every number below was fetched this session; interpretation is marked as such.

## Verdict table

| Axis | Provider | Source of record | Format | Diff mechanism | Verdict |
|---|---|---|---|---|---|
| Pricing + catalog | OpenAI | `developers.openai.com/api/docs/models.md` (+ per-model `.md`) | Markdown tables | body hash (ETag on pricing page) | **Include** |
| Pricing + catalog | Anthropic | `platform.claude.com/docs/en/models/overview.md` + `/docs/en/about-claude/pricing` | Markdown + semantic HTML table | body hash (no validators) | **Include** |
| Pricing + catalog | xAI | `docs.x.ai/developers/models.md` (+ per-model `.md`) | Markdown tables | body hash (1h cache TTL) | **Include** |
| Pricing + catalog | Google | `ai.google.dev/gemini-api/docs/pricing` | SSR HTML, 86 tables | If-Modified-Since (real `Last-Modified`) | **Include — hardest parse** |
| Class-map basis | Google | `aistudio.google.com/docs/models.md` (added 2026-11-01 at `ai.google.dev/gemini-api/docs/models.md.txt`, which 404s from 2026-11-03) | Markdoc model cards | recommendation rows | **Include** — read only for the flagship / economy sentences; no prices |
| Context windows | Google | `aistudio.google.com/docs/models/{slug}.md`, one per priced Standard SKU (added 2026-11-02 at the `ai.google.dev` `.md.txt` suffix, which 404s from 2026-11-03) | Markdoc property table | body hash | **Include** (derived `google-model-md-<slug>`) — token limits only; no prices |
| Pricing cross-check | (all 4) | `openrouter.ai/api/v1/models` | JSON, 419 models | 5-min cache, field diff | **Include as cross-check only** |
| Hiring | OpenAI | `api.ashbyhq.com/posting-api/job-board/openai` | JSON (5/5; dept+team inline; ~12 MB) | UUID ids, `publishedAt`, ETag | **Include** — 757 roles |
| Hiring | Anthropic | `boards-api.greenhouse.io/v1/boards/anthropic/jobs` (+`/departments` join) | JSON | numeric ids, `updated_at`, ETag | **Include** — 537 roles |
| Hiring | xAI | `boards-api.greenhouse.io/v1/boards/xai/jobs` | JSON | same as Anthropic | **Include with disclosed caveat** — 262 roles |
| Hiring | xAI | `boards-api.greenhouse.io/v1/boards/xai/departments` | JSON | numeric ids | **Include as join table** — added 2026-08-25T23:08Z, not part of the original sweep |
| Hiring | Google | none usable (careers.google.com = auth-walled SPA; DeepMind Greenhouse board is vestigial, 10 jobs) | — | — | **Cut** — display "no public feed" honestly. Superseded 2026-11-04: `google-careers`, DeepMind roles only (addendum below) |
| SEC | all + counterparties | `efts.sec.gov/LATEST/search-index` + `data.sec.gov/submissions/CIK{n}.json` | JSON, 5/5 | `startdt` param + accession numbers | **Include, narrowly scoped** |
| Demand share | (all 4) | `openrouter.ai/api/v1/datasets/rankings-daily` (bearer key, CC BY 4.0) | JSON, top 50/day + `other` | `(date, model_permaslug)` keys, append-only | **Include, keyed** — added 2026-09-08, see addendum; fixture is the first keyed fetch, 2026-09-09 |
| Demand share | (all 4) | Artificial Analysis data API | — | — | **Cut** — free tier is "Internal use only; no redistribution." (link only) |
| Demand share | (all 4) | LMArena / arena.ai | — | — | **Cut** — no data endpoint or license (link only) |
| Compute deals | mixed | RSS: OpenAI ✓, Google-AI ✓, NVIDIA ✓, Microsoft ✓; Anthropic = SPA no feed; xAI = hard 403 | RSS 2.0 | GUID diff | **Stretch goal only** (new-post tier, no extraction claims) |

## Key findings

**Pricing/catalog.** OpenAI, Anthropic, and xAI all serve real `text/markdown` docs endpoints (`.md` suffix) containing model id, context window, cutoff, and full price tables in one fetch — no auth, no browser, no bot wall. The marketing pages (`openai.com/api/pricing`, `x.ai/api`) are Cloudflare-403'd to any headless client and must never be dependencies. Google is the outlier: its `.md` trick returns a JS shell, and the models page's numbers are client-rendered — but the *pricing* page is genuine SSR HTML; the cost is DOM-context parsing (model names live in headings above table clusters) and dual-date promo strings ("$0.75 through Dec 31, 2026. $1.50 starting Jan 1, 2027."). OpenRouter's public JSON spot-check matched Anthropic's native table exactly, but it's a third-party restatement with no drift SLA and thin xAI coverage (6 vs 20+ SKUs) — cross-check, never source of record.

**Hiring.** The one axis with true structured JSON end to end. Live signal is already investor-grade: Sales is Anthropic's largest hiring category (88/537 reqs, 16%); 46% of xAI's reqs are Data Center construction and 15% are contractor-style "AI Tutor" roles. Trust caveat that must ship visibly: every xAI row carries `company_name: "SpaceXAI"` — the board is an entity-blended SpaceX/xAI artifact of the 2025 merger, and presenting it as pure xAI hiring would mislead.

**Addendum, 2026-08-25T23:08Z (post-sweep, prompted by "can xAI be separated from SpaceX?").** The xai board exposes the same `/departments` join Anthropic's does — missed in the original sweep, which read the jobs endpoint's null department field as "no departments available". Re-fetched both endpoints as a consistent pair (board had drifted 262 → 255 roles). The join does not split the entity, but it bounds the blend: all 255 jobs map to 26 departments, every one of them xAI-shaped (Data Center 121, Human Data 36, Engineering 23, Product 15, Safety 12), with no aerospace, launch, or propulsion function present; 2 of 255 titles name a SpaceX-side program (`SpaceXAI / Starlink` network ops, `SpaceXAI Battery Storage` civil engineer). Interpretation, marked as such: this is the board owner's own labelling, so it narrows how much SpaceX hiring could be hiding in the blend — it does not prove none is. The caveat stays; it now carries evidence.

**SEC.** The IPO wave is live: OpenAI confidentially filed ~2026-06-08 and Anthropic filed a draft S-1 ~2026-06-01 (press-reported; confidential DRS filings are *structurally invisible* on EDGAR until flipped public), and SpaceX now trades as SPCX with an S-1/A naming both xAI and Anthropic. EDGAR full-text search + a fixed CIK whitelist (MSFT 0000789019, AMZN, NVDA, SPCX 0001181412, GOOGL 0001652044) is the cleanest, most stable source in the entire terminal (federal API, UA header required, 10 req/s) and owns the single highest-value alert this product can fire: "the S-1 went public." Open keyword sweeps across all filers are confirmed noisy (micro-cap false positives) — whitelist only.

**Compute deals.** Detection is solvable for 4 sources via RSS; coverage is not honest to claim — the deals that matter break in the press (The Information, Bloomberg) before any company RSS post. New-post-with-agent-one-liner rides free on shared poll infra; structured deal extraction would be a trust liability. Cut from v1 promises.

**Addendum, 2026-09-08 — demand share.** For labs that are still private, the best public proxy for relative demand is OpenRouter's usage rankings: `GET /api/v1/datasets/rankings-daily` returns the top 50 public models per completed UTC day by total tokens plus one aggregated `other` row, needs `Authorization: Bearer <OPENROUTER_API_KEY>`, and is licensed CC BY 4.0 with the required citation "Source: OpenRouter (openrouter.ai/rankings), as of {meta.as_of}." plus "Licensed under CC BY 4.0" when the data is republished (docs read 2026-09-08). No key existed on the audit machine, so the source shipped recording `skipped` — never fetched anonymously — until `NUXT_OPENROUTER_API_KEY` was set on 2026-09-09; the committed fixture is that first keyed fetch (survey tick 2026-09-09T12:00Z: 1,530 rows, 30 UTC days 2026-08-10 to 2026-09-08, `meta.as_of` 2026-09-09T12:00:03.352Z), replacing the schema-constructed placeholder. Interpretation, marked as such: this is OpenRouter share, not market share — one aggregator's traffic — and every surface says so. Two alternatives were evaluated and cut: Artificial Analysis, whose data API free tier reads "Internal use only; no redistribution." (redistribution comes only with a commercial package), and LMArena (now arena.ai), which publishes no data endpoint or license. Both are linked as external references, never ingested.

## Recommended scope (decision pending)

Go deep on **pricing (+catalog byproduct)** and **hiring**; carry **SEC S-1 watch** as a thin high-value rider (~15 build-minutes); cut compute-deal extraction. Google: include for pricing (agent-assisted parse), honest "no feed" for hiring.

## Addendum, 2026-09-08 — status pages as a capacity-strain signal

Live-fetched with `curl -A "Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontier-terminal.jeremy-ettlinger.workers.dev)"` at 21:57Z; raw bodies committed whole under `fixtures/status/` (bytes and timestamps in `fixtures/manifest.json`). A private lab leaks operational strain through the incidents it posts; incident frequency per provider over time is first-party, deterministic, and free — but it is a proxy for what the vendor chose to post, never an SLA, and the caveats below say so.

| Axis | Provider | Source of record | Format | Diff mechanism | Verdict |
|---|---|---|---|---|---|
| Status | OpenAI | `status.openai.com/api/v2/incidents.json` | JSON, Statuspage v2 (`{page, incidents[]}`) | incident id + `status`/`resolved_at` | **Include** — 25 incidents in the feed (2026-08-05 → 2026-09-08), impacts none/minor/major, 1 open (`monitoring`, no `resolved_at` key) |
| Status | Anthropic | `status.claude.com/api/v2/incidents.json` (`status.anthropic.com` 301s here) | JSON, Statuspage v2 with `components` and `started_at` | same | **Include**, superseded 2026-11-04 by the Atom feed (robots.txt bars `/api/`; see that addendum) — exactly 50 incidents (2026-07-21 → 2026-09-03), the page's cap; impacts 30 minor / 14 major / 3 critical / 3 none; components: claude.ai, Claude API (api.anthropic.com), Claude Code, Claude Cowork, Claude Console |
| Status | Google | `status.cloud.google.com/incidents.json` | JSON array, Google Cloud's own format (`begin`/`end`/`severity`/`status_impact`/`affected_products[]`) | incident id + `end` | **Include, filtered** — keep only incidents whose `affected_products[].title` contains "Gemini" (case-insensitive) or equals "Vertex AI". 6 incidents across 40 product titles in the feed; 1 kept (`Vertex Gemini API`, 2026-02-27, severity low). An Alphabet-wide count would conflate Compute/BigQuery/Spanner with Gemini — the same reasoning that cut Google hiring |
| Status | xAI | `status.x.ai/api/v2/incidents.json` | — | — | **Cut** — HTTP 403 (Cloudflare challenge HTML, 5503 bytes) to a non-browser client with a descriptive UA. Displayed as "no public feed", as Google hiring is. Superseded 2026-11-04: `xai-status` reads the RSS history (addendum below) |

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

## Addendum, 2026-09-27 — misalignment disclosures

Live-fetched with `curl` and the pipeline's descriptive User-Agent at 03:20Z; raw bodies committed whole under `fixtures/disclosures/` (bytes and timestamps in `fixtures/manifest.json`). Checked because agents leaving their sandboxes became a live question in July 2026 (OpenAI's Hugging Face disclosure on 2026-07-21, Anthropic's three cyber-evaluation incidents on 2026-07-30), and OpenAI now runs a page for it. The axis measures **disclosure practice**: which labs publish, what, and how long after discovery. It does not measure how often misalignment happens, and the terminal never ranks labs on the count.

| Axis | Provider | Source of record | Format | Diff mechanism | Verdict |
|---|---|---|---|---|---|
| Disclosures | OpenAI | `openai.com/safety-alignment/misalignment-reports/` (was `alignment.openai.com/misalignment-reports/`, a 308 since 2026-11-20) | SSR HTML (Next.js on Cloudflare); every entry in the flight payload's `items` array | report slug / notice id; title, summary | **Include** — 26 reports and 3 notices (2026-11-21) |
| Disclosures | OpenAI | `openai.com/safety-alignment/misalignment-reports/{slug}/` | SSR HTML, one page per report | model and context; discovery / disclosure dates per report | **Include as derived** — one page per listed report |
| Disclosures | OpenAI | `alignment.openai.com/rss.xml` | RSS 2.0, 21 items | — | **Not used** — newest item 2026-07-21; lists none of the report pages |
| Disclosures | OpenAI | `openai.com/index/model-misalignment-reporting-framework` | — | — | **Not used** — HTTP 403 to a headless client, like every openai.com marketing page |
| Disclosures | Anthropic | `anthropic.com/news/investigating-incidents-cybersecurity-evals` | HTML article | — | **Cut** — one article (2026-07-30), not an index; `alignment.anthropic.com/rss.xml` is 404 |
| Disclosures | Google | none found | — | — | **Cut** — no disclosure page for Google or Google DeepMind; `deepmind.google/discover/blog/rss.xml` is 404 |
| Disclosures | xAI | `x.ai/safety` | — | — | **Cut** — HTTP 403 (Cloudflare challenge, 5,478 bytes), the same wall as `status.x.ai` |

**Findings.** The index page is one `<details class="cb-entry">` per entry. A report carries its title, a one-sentence observation, the model ("5.6-sol", "Internal unreleased Astra family model") and the context it was observed in ("RL training", "Internal deployment"), all stored verbatim. A notice (Hugging Face, DSEwiki, RubyGems) carries a summary and a link to an update on openai.com, which cannot be fetched headless. Every report's own page opens with a metadata cell of "Label: value" lines, and all nine print a discovery date, under three labels (`Discovery`, `Discovered`, `Discovery date`). The occurrence line varies more (`Sample`, `Samples`, `Incident date`, `Main incident date`, `Main incident`, `Main sample completed`) and sometimes names two dates ("Samples: Jan 24, 2026 and Oct 22, 2025"), so it is kept verbatim and never read as a date. One report prints its own `Disclosure date`. Two page layouts exist (a `data-web-metadata` table and a `data-source-index` table); both put the cell in the article's first `ap-doc-table`.

Time to disclosure, discovery date to publication, at this fetch: 5 days (DNS chatbot), 38, 69, 90 (printed disclosure date), 114 ×3, 121 and 153 days. Interpretation, marked as such: OpenAI's framework launched on 2026-09-16 with six reports discovered between April and August, so the long lags are a backlog published at launch; the lags of reports discovered after that date are the ones that test the framework. Press reports (Axios, Fortune, SiliconANGLE, 2026-09-16/17) describe a commitment to publish within six business days, or twelve with a minor investigation. That text is on the 403'd openai.com page, so the terminal shows the measured days and does not state the commitment as data.

Most entries are not sandbox escapes. The page covers misalignment broadly; the escapes (a DNS lookup to an outside chatbot, uploads to file hosts, disposable email sign-ups and leaked API keys) are some of the reports. Incidents reported only by third parties or the press (Hugging Face's own write-up, the RubyGems report, statements at the UN) are not ingested, for the reason compute-deal extraction was cut: coverage from the press cannot be made honest. The other labs are re-checked by the `gap-watch` routine (`.claude/routines/gap-watch.md`), which files an issue rather than registering a source, because a new source needs this same audit.

**Moved, 2026-11-20.** alignment.openai.com/misalignment-reports/ and every report page now answer 308 to the same paths under openai.com/safety-alignment/. openai.com's robots.txt allows them, and the poller's User-Agent gets 200 (no challenge). The index renders 20 entries behind "Load more"; all 29 (26 reports, 3 notices) are in the page's Next.js flight payload, which is what the parser reads. The index no longer prints the model or context; each report page still does, on the line above its dates, and the parser now reads them there. Report pages now print "First posted", which is read as the disclosure date.

## Addendum, 2026-10-12 — Meta

Live-fetched with `curl -L` and the pipeline's descriptive User-Agent at 17:50–18:05Z; raw bodies committed under `fixtures/pricing/` and `fixtures/sec/` (bytes and timestamps in `fixtures/manifest.json`). Checked because Meta now sells its own frontier models through a paid API (Meta Model API: Muse Wonder, Muse Spark), which makes it a lab on the pricing axis in the same sense as the other four, and because it is the one tracked lab that already files with the SEC.

| Axis | Source | Result | Verdict |
|---|---|---|---|
| Pricing | `dev.meta.ai/docs/pricing-rate-limits.md` | 200, 10 987 bytes, `text/markdown`, ETag + Last-Modified. One $/MTok table per model line with Standard and Contributor mode columns | **Include** (`meta-pricing-md`) |
| Pricing | `dev.meta.ai/docs/models.md` | 200, 17 303 bytes, `text/markdown`, ETag + Last-Modified. Model ids, availability per id, context window; no prices | **Include** (`meta-models-md`) — catalog and class-map page |
| Pricing | `llama.developer.meta.com/*` | 301 to `dev.meta.ai` | Registered at the final URL |
| Demand | OpenRouter `meta/*` and `meta-llama/*` | 7 `meta/` and 8 `meta-llama/` models in the live model list; 20 `meta/` rows in the rankings fixture, all Muse Spark | **Include** — both prefixes map to `meta` |
| SEC | `data.sec.gov/submissions/CIK0001326801.json` | 200, "Meta Platforms, Inc."; CIK resolved from `sec.gov/files/company_tickers.json` | **Include** (`edgar-submissions-meta`), whitelisted as `META` |
| Revenue | 10-Q for the quarter ended 2026-06-30, Note 12 | Two reportable segments, Family of Apps and Reality Labs; no AI or API segment | **None** — `revenue_filers.meta: null` |
| Hiring | `metacareers.com/jobs` | 200, client-rendered app over an internal GraphQL endpoint | **Cut** |
| Hiring | Greenhouse / Ashby boards `meta`, `msl`, `metaai`, `metasuperintelligencelabs` | all 404 | **Cut** (`meta-hiring`) |
| Status | `api.meta.ai/v1/status` | 200, `{"is_alive":true,"service_status":"operational",…,"model_statuses":[]}` — current state only | **Cut** (`meta-status`) |
| Status | `metastatus.com` | 200, client-rendered page for Meta business products (Ads Manager, WhatsApp Business API) | Not the model API |
| Disclosures | `ai.meta.com/safety`, `research.meta.ai/safety`, `research.meta.ai/rss.xml` | all 404; `dev.meta.ai/llms.txt` lists no safety or incident page | **Cut** (`meta-disclosures`) |

**Findings.** Meta prices a model line, not a version: every Muse Spark version shares one table, and the sentence above it names the ids the table covers. The parser fans the line's price out to each named id and fails if an id is named in a mode the table marks "Not available". Contributor mode is a separate model id (`muse-spark-1.3-contributor`, $0.10 / $0.20 per MTok against Standard's $1.25 / $4.25) priced low in exchange for Meta training on the caller's content. It is stored as its own SKU, the way OpenRouter lists it, never as a discount on the Standard row. In the rankings fixture, 17 of Meta's 20 OpenRouter rows are Contributor ids, so Meta's demand share mostly reflects traffic at that price.

The class map quotes `models.md`: Muse Wonder is the flagship ("Meta's most capable model…") and Muse Spark 1.3 is the economy cell (the page's cost-sensitive sentence names the Muse Spark line, and marks 1.3 "Recommended for new work"). No balanced tier is named, so that cell is a stated gap.

Interpretation, marked as such: the `meta-llama/*` prefix counts open-weight Llama models that third parties host and bill for. It is demand for Meta's models, not traffic Meta serves or revenue it earns, the same reading that applies to `google/gemma-*`.


**Update, 2026-11-06: the availability tables moved.** From 14:51Z the `meta-models-md` parse failed (`no "### <line> availability" table found`): Meta moved each line's availability table off `models.md` to the line's own page, `dev.meta.ai/docs/muse-wonder.md` (7 827 bytes) and `dev.meta.ai/docs/muse-spark.md` (8 695 bytes), both 200, `text/markdown`, ETag + Last-Modified, under `/docs/`, which `robots.txt` leaves open. The tables are unchanged, and `models.md` keeps a Model ID / Context window table per line. Both pages are registered as joins (`meta-muse-wonder-md`, `meta-muse-spark-md`, `rights: not-cleared` like the rest of dev.meta.ai), and the parser yields the same six rows, hash for hash, as the last good parse. The class map's economy sentence moved with the "Choose a model" section, so it was re-transcribed from the Muse Spark section of `models.md`. The page also lists a seventh line, Muse Spark Open, which is open-weight and not parsed.

**Update, 2026-11-09: Muse Ember.** Meta added a third token-priced text line, Muse Ember (`muse-ember-1.0`, Standard mode only). `pricing-rate-limits.md` prices it by request size, in "Up to 200K" and "Over 200K input tokens" columns, and #322 parses that table. On `models.md` its Model ID table has no Context window column. The window (1,048,576 tokens) and the availability table are on its own page, `dev.meta.ai/docs/muse-ember.md` (7 268 bytes, 200, `text/markdown`, ETag + Last-Modified, under `/docs/`). That page is registered as a third join, `meta-muse-ember-md`, with `rights: not-cleared`. The parser now treats a Model ID table whose Output is exactly "Text" as a text line, so a future line that leaves out the Context window column fails the parse instead of being skipped. The Muse Spark sentence lost "sub-agent tasks", and the class map's economy cell moved to Muse Ember on Meta's own words: "built for high-volume, repeated work".
## Addendum, 2026-11-01 — Mistral re-check

Live-fetched with `curl -L` and the pipeline's descriptive User-Agent at 02:37–02:50Z on 2026-11-02 (UTC). Re-checked because both facts behind the 2026-09-08 cut changed: the docs `.md` pages now resolve, and Meta's addition (2026-10-12) made a lab without every axis a normal shape for this terminal. Raw bodies committed under `fixtures/pricing/`, `fixtures/hiring/` and `fixtures/status/` at 02:42Z (bytes, trims and timestamps in `fixtures/manifest.json`).

| Axis | Source | Result | Verdict |
|---|---|---|---|
| Pricing | `docs.mistral.ai/inference/pricing.md` | 200, 3 741 bytes, `text/markdown`, Netlify ETag, no Last-Modified. One table per family (Generalist, OCR, Audio, Code, Embedding, Moderation, Time series); each row is model, API name, and a `<br>`-joined price cell ("Input $0.7 /M Tokens<br>Cached input $0.07 /M Tokens<br>Output $2.1 /M Tokens") | **Include** |
| Pricing | `docs.mistral.ai/models.md` | 200, 17 332 bytes, `text/markdown`, ETag. 24 current rows (model, API name, status GA / Public Preview, context, summary) and a deprecated-and-retired table with deprecation, retirement and replacement columns | **Include** — catalog and class-map page |
| Pricing | `docs.mistral.ai/models/{slug}.md` | 200, under 1.1 KB each: API names (including `-latest` aliases), release date, context, parameters, a pricing line, license | Not needed — `models.md` and `pricing.md` carry the same fields |
| Pricing | `docs.mistral.ai/inference/model-selection-guide.md` | 200, 4 666 bytes: the same models with 0–5 speed and performance ratings | Not used for the class map — a rating is not a sentence |
| Hiring | `api.ashbyhq.com/posting-api/job-board/mistral.ai` | 200, 2.86 MB JSON, ETag; **229 listed roles**, the same posting-API shape as OpenAI's board. Departments: Solutions 72, Engineering & Infra 43, Science 29, Human Resources 28, Business 20, Legal 13. Paris 135, Palo Alto 18, New York 12, London 11 | **Include** |
| Hiring | `api.ashbyhq.com/posting-api/job-board/mistral`, `jobs.ashbyhq.com/mistral` | 404, 404 | The board name is `mistral.ai` (the "Apply" links on `mistral.ai/careers` point there). The 2026-09-08 audit checked the wrong slug |
| Hiring | Greenhouse `mistral`; Lever `mistral` | 404; 200 with `[]` | Not used |
| Status | `status.mistral.ai/api/v2/incidents.json` | 200, 55 613 bytes, Statuspage v2, ETag. 50 incidents (the page cap), 2025-10-07 → 2026-10-30; impacts 41 minor / 6 major / 3 critical; none open; no `components` field | **Include** |
| Status | `status.mistral.ai/`, `/incidents/{id}`, `/history.rss` | 403 (Cloudflare challenge), 403, 401 to a headless client | Incident links are composed, as for OpenAI, but cannot be checked headless |
| Demand | OpenRouter `mistralai/*` | 21 models in the live model list (Large 4, Medium 3.5, Small 2603, Ministral 3, Codestral, …); 14 `mistralai/mistral-nemo` rows in the committed rankings fixture | **Include** — prefix maps to `mistral` |
| SEC | `efts.sec.gov` "Mistral AI"; `company_tickers.json` | 2 hits, both CoreWeave S-1/A (2025-03) naming Mistral as a customer; no Mistral AI filer among the EDGAR entities named "Mistral" | **Cut** — private French company; no `pending_filers` pattern |
| Revenue | — | No filer | **None** — `revenue_filers.mistral: null` |
| Disclosures | `mistral.ai/safety`; `docs.mistral.ai/resources/security-advisories.md` | 404; the advisories (MAI-2026-001…003) are SDK and product vulnerabilities, not model behaviour | **Cut** |

**Findings.** Mistral's price list is not all Mistral's: the Generalist table opens with three third-party models it resells (`zai-glm-5-3-flash`, `deepseek-v4-1-flash-1017`, `zai-glm-5-3`), and `models.md` labels each "A third-party … model from Z.ai/DeepSeek". The pricing page carries no such label, so both parsers skip them by maker name (`THIRD_PARTY_MAKERS`), and the catalog parser fails when the page's label and that list disagree. Prices print per million tokens, per 1 000 pages (OCR), per minute (audio) or per million characters (TTS); only the `/M Tokens` rows fit the price matrix. Shieldstral and the Timestral models have no API name and no price. Only the current-models table is parsed: deprecated models are not on the price list.

The status feed mixes products: 8 of 50 incident names mention Vibe or Le Chat, and with no components field the count is "Mistral operations", the same reading as OpenAI's. Its timestamps carry local offsets (-07:00 and -08:00 in one feed) where the other pages print UTC, so the parser stores each as the same instant in UTC.

The class map has no quotable sentence. No page names a start-here, flagship or cost tier for Mistral's own text models. `mistral-large-4` is described as "A state-of-the-art, open-weight, general-purpose multimodal model." and `mistral-small-2603` as a "Hybrid model unifying instruct, reasoning, and coding in a single efficient model." The one "frontier-class" sentence belongs to `mistral-medium-3-5`, deprecated 2026-10-31 with Mistral Large 4 as its printed replacement. So flagship, balanced and economy would all ship as stated gaps, or the flagship cell would rest on the replacement column rather than a sentence; that is a rule change for the class map, not a transcription.

Interpretation, marked as such: the case that cut Mistral is gone. It now has four axes with supported surfaces (pricing, hiring, incidents, demand), which is more than Meta has, and the largest hiring category (Solutions, 31%) is the same kind of signal as Anthropic's Sales share. The remaining costs are two markdown parsers, a third-party filter, and empty class-map cells.

**Verdict: include on pricing (`mistral-models-md`, `mistral-pricing-md`), hiring (`mistral-ashby`), incidents (`mistral-status`) and demand (OpenRouter `mistralai/*`). Cut disclosures (`mistral-disclosures`); revenue is `null` and no SEC feed is registered. All three class-map cells are stated gaps.** The product go-ahead was given on 2026-11-01, and `cut.mistral` is retired.

## Addendum, 2026-11-02 — Google per-model pages

Live-fetched with `curl` at 02:40–02:55Z; one page committed as `fixtures/pricing/google-model-gemini-4-argon.md` (bytes and timestamp in `fixtures/manifest.json`). Checked because the pricing page prints no context windows, so all of Google's price rows stored `context_window: null`.

| Check | Result |
|---|---|
| URL rule | `https://aistudio.google.com/docs/models/<slug>.md` (until 2026-11-03, `https://ai.google.dev/gemini-api/docs/models/<slug>.md.txt`), where `<slug>` is the `<code>` id under the model's heading on the pricing page. 30 of the 33 slugs with a priced Standard table returned 200 `text/markdown` at the 2026-11-02 check (AI Studio serves `text/plain` Markdoc); `gemini-3.5-transcribe-live`, `gemini-omni-1.1-flash` and `gemini-3.1-pro-preview-customtools` return 404 (the last is listed as a version on the `gemini-3.1-pro-preview` page). An unknown slug returns 404 with an HTML body. |
| Format | A `Property \| Description` table per model. Its `Model code` cell names the id and its `Token limits` row holds the limits. Most cards print `**Input token limit** 1,048,576 **Output token limit** 65,536`. `gemini-4-argon` prints `**Context window (unified input and output token limit)** 1,048,576 **Max output** 65,536 (default synchronous) / up to 1,048,576 (with long decode)`. The embedding cards print an input token limit and an output dimension size. `gemini-3.5-transcribe` has no token-limits row. |
| Multi-model pages | `gemini-robotics-er-2-preview` and `gemini-robotics-er-2-streaming-preview` each serve one page with three model tables, one per id. |
| Prices | None. Each card links to the pricing page instead. |

**Verdict.** Include as the derived source `google-model-md-<slug>`, keyed from the priced Standard rows `google-pricing-html` stores. The first number in the token-limits row is stored as the context window, exactly as printed, and the whole cell is the row's note. Google's label (input token limit or unified context window) and the max output therefore travel with the number. The parser reads only the table whose `Model code` names the slug it was derived for, and fails otherwise. A 404 is `absent`, as it is for OpenAI. The page has no prices, so the pricing row stays the row of record. The catalog view gives its window to every tier of the slug and cites the model page in `context_window_source`.

Interpretation, marked as such: for most cards the number is an input limit, not the unified window OpenAI and Anthropic print. The note keeps that distinction visible rather than normalising it away.

## Addendum, 2026-11-02 — revenue from a registration statement

Anthropic, PBC filed its S-1 on 2026-10-26 (accession 0001628280-26-067168), and the pipeline resolved its CIK (0002130357) from it. The revenue panel stayed empty because the filing tags no financials in XBRL: its XBRL package is 3 KB and holds only the filing-fee exhibit (`exfilingfees-s1_htm.xml`), and company facts for the CIK carry only the `ffd` taxonomy. Tagged financials arrive with the first 10-Q after listing.

| Source | Fetched | Finding | Verdict |
|---|---|---|---|
| `www.sec.gov/Archives/edgar/data/2130357/000162828026067168/0001628280-26-067168-index.htm` | 200, 33 KB HTML | Document table: sequence 1 is `anthropicpbc-sx1.htm`, Type S-1 | **Include** (`filing-index` template) — the only place the document name is stated; the submissions feed lists the accession alone |
| `…/anthropicpbc-sx1.htm` | 200, 14 MB HTML | The audited Consolidated Statements of Operations (F-7) prints Revenue for FY2023–FY2025 and the six months ended 2025-06-30 and 2026-06-30 (unaudited), in millions | **Include** (`prospectus-revenue` template) — parsed in under 20 ms |

Interpretation, marked as such: other publications will cite the S-1's figures, and they are audited figures in a filing the SEC accepted, so the panel's "primary source only" rule holds. The values are labelled as read from the printed statement (not XBRL), interim periods are marked unaudited, and a later filing's value for the same period — an S-1/A, or the first 10-Q's XBRL — supersedes them.

## Addendum, 2026-11-02 — GPU rental prices and neocloud revenue

Live-fetched with `curl -L` and the pipeline's descriptive User-Agent at 03:20–04:12Z on 2026-11-02 (UTC). Checked for the Compute thesis ([`docs/theses/compute.md`](theses/compute.md)), whose first claim divides the labs' flagship token prices by the price of renting an H100. The rules came with the request. Use only first-party price pages or documented price APIs. Read each provider's terms. Treat aggregators and marketplaces as cross-checks only. Never ingest index values from licensed vendors (Bloomberg, LSEG and the like). Store each price with its page and fetch time. Raw bodies are committed under `fixtures/recipes/` (bytes, trims and timestamps in `fixtures/manifest.json`). The sources are thesis recipes, not lab sources: they are registered in `sources.yaml` under `recipe_sources`, and the cuts under `cut`.

| Provider | Source | Result | Terms (read the same day) | Verdict |
|---|---|---|---|---|
| Lambda | `lambda.ai/pricing` | 200, SSR HTML (HubSpot). "Instances pricing": one table per tab (8x, 4x, 2x, 1x), PRICE/GPU/HR. H100 SXM $3.99–$4.29, H100 PCIe $3.29 (1x), B200 SXM6 $6.69–$6.99 | Bars only crawling not "restricted to a rate so as not to impair or otherwise disrupt the servers being crawled" | **Include** (`gpu-lambda`) |
| CoreWeave | `coreweave.com/pricing` | 200, SSR HTML (Webflow). One list item per instance: HGX H100 8 GPUs, On-Demand $49.24/h ($6.155/GPU); HGX B200 8 GPUs, $68.80/h ($8.60/GPU). The list renders twice | Terms of Service (docs.coreweave.com) silent on automated access; no website terms resolve | **Include** (`gpu-coreweave`) |
| Nebius | `nebius.com/prices` | 200, SSR HTML. "NVIDIA GPU Instances" table: HGX H100 $4.50, HGX B200 $8.50 on-demand per GPU-hour; a "from" preemptible column beside it | Terms of Use silent; robots.txt allows `/prices` | **Include** (`gpu-nebius`) |
| Crusoe | `crusoe.ai/cloud/pricing` | 200, SSR HTML (Webflow). "GPU instances pricing": a column of names beside On-demand and Current spot columns. H100 80GB $3.90/GPU-hr; B200 "Contact sales". A self-serve deployments table (H100 $5.50) prices dedicated inference endpoints | Acceptable use policy bars "disruptive crawling or scraping" | **Include** (`gpu-crusoe`), on-demand column only |
| Together AI | `together.ai/pricing` | 200, SSR HTML. GPU Clusters: HGX H100 $3.99, HGX B200 $8.19 on-demand per GPU-hour. A dedicated endpoints table prices H100 at $5.49 | Terms silent; robots.txt blocks only Google-Extended | **Include** (`gpu-together`), GPU Clusters only |
| DigitalOcean | `digitalocean.com/pricing/gpu-droplets` | 200, SSR HTML (Next.js). Cards labelled On-Demand Price (HGX H100 $4.41/GPU/hour) or 12 Month Reserved Price ($3.26). No B200 card | Terms of Service Agreement silent | **Include** (`gpu-digitalocean`), on-demand cards only |
| Verda (DataCrunch) | `verda.com/pricing` | 200, SSR HTML. On-demand GPU instances: 1x H100 SXM5 $4.793/h (two CPU/RAM configurations), 1x B200 SXM6 $8.869/h | Bars "malicious automated use" | **Include** (`gpu-verda`) |
| Microsoft Azure | Azure Retail Prices API, filtered to H100 VM consumption meters | 200, JSON, 730 items, one page. ND H100 v5 (8× SXM) $88.488–$186.608/h across 82 Linux SKU-region rows; NC H100 v5 are H100 NVL cards. B200 appears only as GB200 systems | Documented for unauthenticated use; no robots.txt on the host | **Include** (`gpu-azure`): Linux pay-as-you-go only, ND divided by 8 |
| Oracle Cloud | Oracle Cloud Price List API (linked from docs.oracle.com) | 200, JSON, 668 parts. "Compute - GPU - H100" $10, "Compute - GPU - B200" $14 per GPU-hour, pay-as-you-go | Documented price lookup; `apexapps.oracle.com/robots.txt` answers 403 to every client tried | **Include** (`gpu-oracle`). The NVIDIA AI Enterprise licence and an undocumented "H100T" part are not read |
| RunPod | `runpod.io/pricing` | 200, SSR HTML: H100 SXM $3.99, PCIe $2.89, NVL $3.19 | Terms bar "any automated system, including without limitation, any spider, robot, cheat utility, scraper, or offline reader that accesses the Site" | **Cut** (`gpu-runpod`) |
| AWS | Price List bulk file, EC2 us-east-1 | `content-length: 481649899` | — | **Cut** (`gpu-aws`): over the 32 MB body cap. The Query API needs credentials; the 58 KB `b0.p.awsstatic.com` JSON behind the pricing page is an undocumented page backend (p5.48xlarge $55.04/h) |
| Google Cloud | `cloud.google.com/compute/gpus-pricing` | Redirects to a 2.2 MB client-rendered page with no H100 or A3 price in its HTML | Billing Catalog API needs an API key | **Cut** (`gpu-google-cloud`) |
| Vultr | `api.vultr.com/v2/plans`, `/plans-metal` | 200, JSON: HGX H100 8× $23.92/h, B200 8× $68/h, both with no locations | `api.vultr.com/robots.txt`: `Disallow: /` | **Cut** (`gpu-vultr`) |
| Jarvislabs | `jarvislabs.ai/pricing` | 200, SSR HTML: H100 SXM $3.49 | Terms page renders client-side; its text could not be read | **Cut** (`gpu-jarvislabs`) |
| Scaleway / Fluidstack / Hyperbolic | pricing pages | 403 / 404 / 404 | — | **Cut** |
| Vast.ai | `console.vast.ai/api/v0/bundles` (H100 SXM, rentable, on-demand) | 200, 21 offers from third-party hosts, median $2.40 per GPU-hour ($1.93–$4.07) | — | **Cross-check only**: a marketplace, not a first-party price. Compared once, here; nothing stored |

**Findings.** Nine providers pass, so claim 1's five-provider quorum holds with four to spare. The H100 median across them is $4.50 per GPU-hour (Nebius's price; Lambda's four sizes count once, at $4.14). The B200 median across six providers is $8.55. The hyperscalers list well above the neoclouds (Azure $14.38 as the median of 82 regional SXM rows, Oracle $10.00), so the median sits among the neoclouds and moves when one drops out. Every page that prices instances (CoreWeave, Azure, Verda) prints its GPU count or documents it (Azure's VM size pages); the extractors divide by it and keep the instance price beside the per-GPU one. Form factors are not uniform: SXM, SXM5, HGX, PCIe and NVL appear. The median counts SXM and HGX boards and rows that name none, and keeps PCIe and NVL rows uncounted, so the comparison is between like boards.

Interpretation, marked as such: these are list prices. The one marketplace checked listed H100 SXM at about half the first-party median, and reserved terms on the same pages run up to about a quarter under on-demand (DigitalOcean's 12-month H100 is $3.26 against $4.41). Claim 1 therefore reads the price a marginal renter is quoted, not the price compute clears at, and its journal says so.

**Neocloud revenue (claim 5).** CoreWeave's CIK from `sec.gov/files/company_tickers.json` (CRWV → 1769628) round-trips through `data.sec.gov/api/xbrl/companyfacts/CIK0001769628.json` → "CoreWeave, Inc.". The existing quarterly-revenue extractor reads it cleanly: 10 quarters, Q4 2025 derived from the 10-K, Q2 2026 $2,575M against $1,212M a year earlier (+112%). Comparables checked the same way:

| Filer | Result | Verdict |
|---|---|---|
| Nebius Group (NBIS, CIK 1513845) | Company facts carry no us-gaap revenue tag: it reports under IFRS | Not shown: does not parse |
| IREN (CIK 1878848) | Parses, but its revenue is mostly bitcoin mining; Q2 2026 growth −27% | Not shown: not a GPU-rental comparable |
| Applied Digital (APLD, CIK 1144879) | Parses with a missing quarter (2026-05-31); it leases data-center capacity, CoreWeave among its tenants | Not shown: not a GPU-rental comparable |
| Lambda, Crusoe, Together AI, Verda | No EDGAR filer | — |

CoreWeave is shown alone (`sec-revenue-crwv`).

## Addendum, 2026-11-04 — five candidate datasets beyond OpenRouter

Live-fetched 04:00–04:50Z on 2026-11-04 (UTC) with the pipeline's descriptive User-Agent; every terms page was read the same morning. Checked because every demand signal the theses read is OpenRouter's, which sees developer traffic only (Anthropic claims 1–2 and Compute claim 3 say so). The includes were built the same day as thesis recipes (`layers/terminal/server/theses/recipes/`), each with its `sources.yaml` entry under `recipe_sources` and a fixture under `fixtures/recipes/`; the GitHub recipes record "not configured" until `NUXT_GITHUB_TOKEN` is set. The cuts are under `cut`.

| Candidate | Source | Result | Terms (read the same day) | Verdict |
|---|---|---|---|---|
| Ramp AI Index | `ramp.com/data/ai-index` | 200, 1.76 MB Next.js HTML; the series is a 573 KB props object in the RSC stream (`adoptionOverall`, `adoptionVendor`, `spendShareData`, a `dataVersion` change key). Monthly 2023-07 to 2026-09. September 2026: any AI 55.86% of businesses, Anthropic 43.77%, OpenAI 40.63%, xAI 4.14%, Mistral 0.19%. No ETag or Last-Modified | robots.txt allows `/data/` (it disallows `/*.csv`). Ramp publishes no website terms (`/legal/terms`, `/legal/website-terms` render an empty shell); the Acceptable Use Policy bars "bulk scraping" but covers its AI-enabled Services. The page states no license | **Include, derived numbers only**: the monthly vendor and overall rates with URL and fetch time; the industry, size and state tables are not mirrored |
| npm downloads | `api.npmjs.org/downloads/{point,range}/…`, documented in npm/registry `download-counts.md` | 200 JSON, no auth. 7 days to 2026-11-02: `@anthropic-ai/sdk` 64.0M, `openai` 55.4M, `@google/genai` 29.9M, `@mistralai/mistralai` 6.4M; `@openai/codex` 27.2M, `@anthropic-ai/claude-agent-sdk` 17.7M, `@anthropic-ai/claude-code` 12.6M, `@google/gemini-cli` 0.47M. History 18 months; a longer range is clipped silently | Open-source terms bar automating access to the Website, then: "You may replicate data from the Public Registry using the Public APIs per this Agreement." No robots.txt (404) | **Include**. xAI publishes no JS SDK (`xai-sdk` on npm belongs to an individual; `@ai-sdk/xai` is Vercel's) |
| PyPI downloads | `pypistats.org/api/packages/{pkg}/recent`, `/overall?mirrors=false` | 200 JSON, no auth, 60 requests per window. Last week: `openai` 85.4M, `anthropic` 46.9M, `google-genai` 38.3M, `mistralai` 3.2M, `xai-sdk` (xai-org) 0.91M. History 180 days | No terms page or robots.txt (both 404). The API page asks bulk users to go to BigQuery instead; about ten packages a day is not that. The upstream table (`bigquery-public-data.pypi.file_downloads`) is CC BY 4.0 per docs.pypi.org | **Include**, cited to the PSF dataset via pypistats |
| VS Code Marketplace | `marketplace.visualstudio.com/_apis/public/gallery/extensionquery` | Not fetched for the audit | robots.txt: `Disallow: /_apis/`. The endpoint is undocumented, and the Terms of Use bar "'spidering' or 'scraping' the Offerings Sites" | **Cut** (`vscode-marketplace`) |
| Open VSX | `open-vsx.org/api/{namespace}/{extension}` | 200 JSON, documented (OpenAPI). Cumulative `downloadCount` only: Claude Code 64.2M, ChatGPT/Codex 13.0M, Gemini Code Assist 4.3M; Copilot is absent | robots.txt allows `/`, `Crawl-delay: 2`; Eclipse terms silent on automated access | **Cross-check only** (`open-vsx`): VS Code forks only, and the count appears to include updates |
| GitHub agent PRs | `api.github.com/search/issues`, one query per agent | 200 JSON; week 2026-10-01..07, three repeats, all `incomplete_results: false`: Copilot coding agent (`author:app/copilot-swe-agent`) 15,483; Devin 18,682; Jules 2,415; Cursor cloud (`author:app/cursor`) 7,233; Claude Code (`"Generated with Claude Code"` in the body) 1,627,058–1,627,078, drifting as PRs are deleted; Codex (`head:codex/`) 285,389, a branch convention only. All PRs that week: 6,442,106 | Acceptable Use Policies §7: "Scraping does not refer to the collection of information through our API"; research publications must be open access. ToS §H warns against excessive request rates. Search allows 10/min anonymous, 30/min with a token | **Include, one trend per agent**; a GitHub token secret is needed in production |
| GitHub commit search | `api.github.com/search/commits` | A one-week window returns a different total on each call (7.35M, 9.90M, 9.91M), always `incomplete_results: true`; a one-day window settles. Default branches only; mirrors duplicate commits; the secondary rate limit trips after 2–3 calls | As above | **Cut** (`github-commit-search`) |
| Epoch AI data centers | `epoch.ai/data/data_centers/data_centers.csv` (72 KB, 96 sites); `…/data_center_timelines.csv` (196 KB, 575 rows, 2018-12 to 2030-01) | 200 CSV, ETag, no Last-Modified; page "Updated Nov. 1, 2026", changelog every few days. All 96 sites: 15,078 MW, 15.75M H100e | "Epoch AI's data is free to use, distribute, and reproduce provided the source and authors are credited under the Creative Commons Attribution license" (CC BY 4.0). robots.txt allows `/data/` | **Include** |
| Kalshi | `api.elections.kalshi.com/trade-api/v2` | 200 JSON, documented, no auth. About 255 lab series; liquid ones: best LLM at year end, Anthropic IPO dates, best coding model | Data Terms of Use: "You may access content only for your personal use for non-commercial purposes", and no "publicly displaying, publishing" without written authorization. Developer Agreement: API use "expressly limited to facilitating a members own trading" | **Cut** (`kalshi`) |
| Polymarket | `gamma-api.polymarket.com`, CLOB `/prices-history` | 200 JSON, documented, no auth. Deep markets: Anthropic valuation and IPO date, best model at year end | Terms (effective 2026-08-11) bar crawlers "to scrape or otherwise remove data", and redistribution to "any Capital Market Client or market data distributor, unless otherwise agreed to in writing" | **Cut — external link only** (`polymarket`) |

**Findings.**

- **Ramp is the enterprise number the theses lack.** By September 2026, more businesses paid Anthropic (43.77%) than OpenAI (40.63%). Ramp's weekly token-spend table (week to 2026-10-23: Anthropic 60.5%, OpenAI 35.1%) is a single snapshot, not a series, so it builds history only from the day the recipe starts.
- **Ramp restates its history.** Ramp's 2025-11-19 article reported Anthropic at 14.3% in October 2025; today's series puts that month at 16.65%. Every fetch has to be stored as its own vintage, keyed by `dataVersion`, and never collapsed to the newest value.
- **Download counts track usage, not users.** No registry filters CI. pypistats removes known mirrors only. They are a trend per package, not a market share.
- **The coding-agent signals are different instruments, not one table.** Claude Code's PR footer is on by default and can be turned off, so it is counted only when left on. The Copilot, Devin, Jules and Cursor counts are PRs whose author is the bot itself. Codex is only a branch-name convention. A cross-agent share would compare unlike things, so each agent is shown as its own trend.
- **Epoch is a supply number with a stated error.** In Epoch's own words, 80% of power estimates fall "within a factor of 1.4x"; compute is "usually calculated from IT power"; coverage is about 45% of capacity, from sites operational in 2024 or later.
- **Epoch's attribution needs a rule.** Owner and Users differ: Colossus 1 and 2 are owned by SpaceXAI and used by Anthropic, so counting a site under either field counts 1,286 MW twice. Users also carry confidence tags (`#confident`, `#likely`, `#speculative`). The recipe should count by Users at `#confident` or `#likely`, and mark the four multi-user sites as shared.
- **Neither prediction market licenses republication.** The liquid markets would be the only market-implied valuation and IPO-date signal available. They stay linked references, as Artificial Analysis and arena.ai are, unless Kalshi or Polymarket grants written permission.

Interpretation, marked as such: Ramp and the registries attack the "OpenRouter is one aggregator" caveat from two directions, enterprise spend and developer installs. Epoch replaces Compute claim 4's hiring proxy with a measured, if estimated, supply series. Neither prediction market can be ingested.

## Addendum, 2026-11-04 — hyperscaler filings, rate limits, posted pay

Live-fetched 05:00–05:30Z on 2026-11-04 (UTC); SEC documents with the pipeline's contact User-Agent, everything else with its descriptive one. Three more ways to read the private labs from primary sources.

**Hyperscaler filings.** XBRL company facts cannot carry any of this: every lab-specific fact is dimensional or a custom tag, and companyfacts drops both. A reader has to parse the filing's own XBRL instance.

| Filer | What it discloses | Tagging | Verdict |
|---|---|---|---|
| Microsoft | Its recognized gain or loss from OpenAI each quarter: Q3 2025 −$4.1B, Q4 2025 +$10.0B ("primarily relate to the dilution gain from the OpenAI Recapitalization"), Q1 2026 −$19M, Q3 2026 +$272M ("Other income (expense), net included $272 million of net gains … from investments in OpenAI"); stake 27% falling to 24%; $12.0B funded of a $13.0B commitment | `us-gaap:NonoperatingIncomeExpense` and `us-gaap:EquityMethodInvestmentOwnershipPercentage` on `srt:ScheduleOfEquityMethodInvestmentEquityMethodInvesteeNameAxis` = `msft:OpenAIGlobalLlcMember`, rounded to $0.1B | **Include** from the instance XML, as Microsoft's figure |
| Amazon | Names "Anthropic, PBC": upward adjustments to its Anthropic preferred stock (Q1 2026 $12.3B, Q2 2026 $50.5B, about zero in Q3 2026), the preferred's carrying value ($92.5B, 164M shares) and the notes' fair value ($146.2B, gains to other comprehensive income); a 12% ownership cap | `amzn:AnthropicMember` on a few facts only, under the equity-method investee axis; the notes' fair value carries no dimension | **Include** as the filing's own "Anthropic" paragraph, stored as text per quarter |
| Alphabet | "a $40.0 billion investment in a private company"; never names it | — | **Cut** (`alphabet-anthropic-stake`) |

Neither derived number holds. Microsoft accounts for OpenAI with hypothetical liquidation at book value "because our liquidation rights and priorities differ from our underlying ownership interest", books dilution gains in the same line, and may record "on a lag of up to three months", so dividing its figure by its stake is not OpenAI's loss. Amazon's two marks disagree (the preferred at its last observable price, about $564 a share; the notes at full fair value, about $795 a preferred-equivalent), it discloses no total share count, and 12% is a cap rather than a stake, so neither is Anthropic's valuation. Both are shown as the filer's numbers.

**Published rate limits.**

| Lab | Source | Result | Verdict |
|---|---|---|---|
| OpenAI | `developers.openai.com/api/docs/models/{slug}.md`, already fetched for the catalog | A `## Rate limits` table per model: Tier, RPM, TPM, Batch queue limit. The fixture of 2026-09-22 shows Tier 1 to 5; live shows Build, Launch, Grow ("Oct 6 — Simplified API usage tiers from five to three") | **Include**, keyed on tier name |
| Anthropic | `platform.claude.com/docs/en/api/rate-limits.md` | One table per tier (Start, Build, Scale): Model, RPM, ITPM, OTPM; 30 rows. Release notes date past changes (2026-06-26 "We've raised rate limits across the Claude API"). No validators | **Include** |
| xAI | `docs.x.ai/developers/rate-limits.md` | 13 models × 5 tiers (T0–T4), RPS and TPM packed per cell; robots.txt allows `/` | **Include** |
| Meta | `dev.meta.ai/docs/pricing-rate-limits.md`, already fetched for pricing | Model, RPM, TPM, Other limits; 9 rows, no tiers | **Include** |
| Google | `aistudio.google.com/docs/rate-limits.md` | Per-model RPM, TPM and RPD are console-only ("can be viewed in Google AI Studio") | **Cut** (`google-rate-limits`) |
| Mistral | `docs.mistral.ai/admin/billing-usage/usage-limits.md` | Limits shown only in the signed-in Admin Panel | **Cut** (`mistral-rate-limits`) |

Interpretation, marked as such: published limits are tier design and abuse control (Anthropic's page says they are "designed to prevent API abuse"), and they move in announced steps. They are a dated step series beside the status-page incidents, never a capacity gauge.

**Posted pay.** US pay-transparency laws put salary bands in postings. The midpoint of each USD annual band, then the median per role family:

| | OpenAI (Ashby, `includeCompensation=true`, 14.2 MB) | Anthropic (Greenhouse, `content=true&pay_transparency=true`, 10.2 MB) |
|---|---|---|
| Roles with a usable USD annual band | 631 of 813 (78%) | 535 of 681 (79%) |
| All | $307.5K | $350.0K |
| Research (OpenAI "Research"; Anthropic "AI Research & Engineering") | $370.5K (n=53) | $505.0K (n=59) |
| Software engineering (OpenAI "Applied AI"; Anthropic "Engineering & Design - Product", "Software Engineering - Infrastructure") | $355.5K (n=112) | $405.0K (n=87) |

Sales is not compared: Anthropic posts on-target earnings and OpenAI base pay. xAI's structured pay field is empty on every role (`xai-pay-bands`) and Mistral posts no pay (`mistral-pay-bands`). Greenhouse's docs: "Job Board data is publicly available, so authentication is not required for any GET endpoints"; Ashby documents `includeCompensation`. Bands are posted ranges, not offers; they cover US postings only and exclude equity, the larger part of pay at these labs. The signal is a cell's change over time, not the gap between labs. The department mapping is kept by hand: "Applied AI" means product engineering at OpenAI and solutions architects at Anthropic.

The xai board's `company_name` now reads "SpaceXSI" on all 300 roles; the hiring caveat says so.

Built the same day as thesis recipes (`recipe_sources`). One change from the table above: Amazon is read from the same XBRL instance as Microsoft, not as text. Its instance tags eight facts on `amzn:AnthropicMember`, more than the audit found: the upward adjustments ($62.8B for the nine months to 2026-09-30), the 164M preferred shares, the $20B credit facility, and a $100B increase in remaining performance obligation in the quarter to 2026-06-30. The carrying value and the notes' fair value are not on the member, so they stay in the filing's text.

## Addendum, 2026-11-04 — coverage gaps re-checked

Live-fetched with `curl -L` and the pipeline's descriptive User-Agent at 13:20–13:50Z; the two new feeds are committed under `fixtures/hiring/` and `fixtures/status/` (bytes and timestamps in `fixtures/manifest.json`). Checked because the overview still showed five empty axis cells (Google and Meta hiring, xAI and Meta incidents) and every Mistral class cell unmapped. Each earlier cut was re-run before anything new was looked for.

| Gap | Candidate | Result | Verdict |
|---|---|---|---|
| Google hiring | `careers.google.com/jobs/feed.xml` → 301 `www.google.com/about/careers/applications/jobs/feed.xml` | 200, 20 379 364 bytes `text/xml`, Last-Modified. One `<job>` per posting with `jobid`, `title`, `employer`, `categories`, `locations`, `jobtype`, `published`. 3 380 jobs: Google 3 065, YouTube 173, DeepMind 142 | **Include** (`google-careers`), DeepMind rows only |
| Google hiring | `…/jobs/results/?company=DeepMind` | 200, server-rendered: "142 jobs matched", 20 per page; `deepmind.google/careers` links here. Paging (`page=`) is disallowed by robots.txt | Cross-check only: the feed's 142 DeepMind rows match it |
| Google hiring | Greenhouse `deepmind`, `googledeepmind`; Ashby `deepmind`, `googledeepmind`; Lever `deepmind`; `careers.google.com/api/v3/search/` | all 404 | — |
| Meta hiring | `metacareers.com/robots.txt` | Opens with "Collection of data on Facebook through automated means is prohibited unless you have express written permission"; `/jobsearch/sitemap.xml` lists 1 335 `profile/job_details/{id}` pages with no team or org label | **Cut stands** (`meta-hiring`), reason now names the terms |
| Meta hiring | Greenhouse `meta`; Ashby `meta`; Lever `meta`; `metacareers.com/jobs/feed(.xml)` | 404 | — |
| Meta incidents | `api.meta.ai/v1/status`; `dev.meta.ai/status`; `dev.meta.ai/docs/api-reference/status.md` | Current state only (`{"is_alive":true,"service_status":"operational",…}`); the page renders "Status information is unavailable" headless | **Cut stands** (`meta-status`) |
| Meta incidents | `status.meta.ai`, `status.dev.meta.ai`, `status.llama.com` | no DNS answer | — |
| xAI incidents | `status.x.ai/feed.xml` | 200, 340 615 bytes `application/xml`, RSS 2.0 "SpaceXAI System Status", "Incident history for xAI services." 316 items, one per (component, incident), folding to 97 guids, 2026-08-06 → 2026-11-03 | **Include** (`xai-status`) |
| xAI incidents | `status.x.ai/api/v2/incidents.json`, `/history.rss`, `/sitemap.xml`, HTML pages | 403 (Cloudflare challenge), as at the 2026-09-08 cut; robots.txt disallows `/api/` and allows the feed | The cut's fact still holds; the feed is a different surface |

**What changed.** Google: the 2026-08-25 cut described careers.google.com as an auth-walled SPA. It now redirects to `google.com/about/careers/applications`, which serves results server-side and publishes the aggregator feed above. www.google.com's robots.txt disallows only the results page's `page=` parameters for every agent (the whole results path for Yandex alone), and Google's Terms of Service bar automated access only "in violation of the machine-readable instructions on our web pages". xAI: the 2026-09-08 cut checked only the Statuspage API path. The page now publishes an RSS history that answers a headless client and that robots.txt allows. xAI's consumer terms (updated 2026-10-27, read in a browser because x.ai answers 403 headless) have no scraping clause; the Acceptable Use Policy bars "Accessing the Services through unauthorized automated or non-human means". A published feed that robots.txt allows is read as authorized, the same reading the pipeline already applies to `docs.x.ai`.

**Findings.** Google's feed is Alphabet-wide, so the parser keeps `<employer>DeepMind</employer>` and counts the rest in the run note, the same scoping that filters Google Cloud's status feed to Gemini. DeepMind's 142 roles are not all of Google's AI hiring: Gemini work staffed under the Google employer is not counted. Its categories are enum labels (`SOFTWARE_ENGINEERING`) and are stored verbatim; two roles carry several and keep all of them. `HARDWARE_ENGINEERING` matches the physical-infrastructure cluster's "Hardware" term. Titles are double-encoded in places (`&amp;amp;`); the parser decodes XML once and stores what is left.

xAI's feed covers every SpaceXSI product, Cursor's included: 48 of the 97 incidents name only Cursor-branded components (Cursor IDE, CLI, Cloud Agents, Bugbot, Automations, cursor.com), 25 only Grok, API and other components, and 24 both. Severity is the feed's own (disruption 90, outage 5, info 2 by incident). Every incident's component items agree on title, start, end and severity; the parser fails if they ever disagree. Item links are per component and answer 403 headless, as Mistral's do.

**Class map.** `docs.mistral.ai/models.md`, `pricing.md` and the model selection guide are byte-identical to the 2026-11-02 fixtures, and the Large 4, Small 4 and Ministral 3 pages name no tier; the one "Flagship" on Mistral's pages is a transcription model (Voxtral Small Transcribe 3). xAI's models page still answers "Which model should I choose?" with Grok 4.7 alone, and the grok-4.3, grok-4.20 and grok-build-0.1 pages describe capability, not cost. Google's models page is identical to its fixture: its one current price-performance sentence ("Frontier-class performance rivaling larger models at a fraction of the cost") is printed on two cards, Gemini 3.1 Flash-Lite and Gemini 3 Flash (Preview), so it names no single model. All seven unmapped cells stay stated gaps, with reasons that now say this.

**Verdict: include `google-careers` (DeepMind only) and `xai-status`; retire `cut.google-hiring` and `cut.xai-status`. `meta-hiring` and `meta-status` stand, with their reasons rewritten to the facts above. No class cell is mapped.**

## Addendum, 2026-11-04 — distribution terms

Prompted by listing the dataset with alt-data directories, whose buyers' compliance teams ask, per source, under what terms it was read and whether it can be sold. Every terms page and robots.txt below was fetched today with the pipeline's descriptive User-Agent; nothing was signed up for or submitted.

### OpenRouter rankings: re-serving

The licence, `openrouter.ai/docs/cookbook/administration/data-api` (fetched as `.md`, "License and citation"):

> Data returned by the Data API is licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). You may copy, redistribute, and build on it, including commercially, with attribution to OpenRouter.

The same page, under the `rankings-daily` endpoint's "Acceptable use and attribution":

> The dataset is intended for analysis, reporting, and visualisation. It is not intended to be re-served as a competing free API.

The fetch needs an API key, so the account terms apply as well. `openrouter.ai/terms` (last updated 2026-08-31), section 7, bars accessing the service "for purposes of reselling API access to Models or otherwise developing a competing service". robots.txt allows `/`.

**Decision: partly inconsistent, so what is re-served changed.** The per-lab shares, the per-lab top models over the share window, the per-lab daily series on `/rankings`, `/api/rankings` and the MCP `get_rankings` tool are analysis and visualisation. They stay, with the required citation. The `rankings_daily` export served every stored `(date, model_permaslug, total_tokens)` row, keyless and accumulating past OpenRouter's own 30-day window. That is the dataset itself behind a free endpoint, which is the one use the page names as unintended. Interpretation, marked as such: CC BY 4.0 itself would allow it, and the sentence reads as a statement of intent rather than a licence condition. But the account terms bind the key the feed is fetched with, and a fund's reviewer will read the two together. So:

- `rankings_daily` is withdrawn from `/export`. A request answers 410 with the reason, and `/data` says why.
- The `changes` export drops `entity_type = 'ranking'` rows, whose before/after JSON is the same per-model row.
- Nothing is deleted from the store: the rows still feed the shares and the theses.

`openrouter-models` (the per-model price list) is a different endpoint. The CC BY grant covers "the aggregated data these endpoints return", the Data API datasets, and section 7 also bars scripts that "scrape or copy any information on the Site or the Services". It stays a cross-check that is never shown as a source of record, and it is `not-cleared` for any paid offer.

### Terms per core source

Each `sources:` entry in `sources.yaml` now carries `terms` (terms and robots.txt as read, what is taken, how often) and `rights`, as `recipe_sources` already did. Summary:

| Source | Terms read | robots.txt | Taken, how often | `rights` |
|---|---|---|---|---|
| OpenAI docs (`openai-models-md`, `openai-pricing-md`), status, misalignment reports | `openai.com/policies` answers 403 to a headless client: **not read** | developers.openai.com allows all; status.openai.com and alignment.openai.com have none (404) | catalog every 5 min, prices 30 min, status and reports 6 h | not-cleared |
| Anthropic docs (`anthropic-models-md`, `anthropic-pricing-md`) | Consumer Terms bar "To crawl, scrape, or otherwise harvest data or information from our Services", which include "associated apps, software, and websites"; Commercial Terms have no such clause | platform.claude.com disallows only `/api/` | catalog 5 min, prices 30 min | not-cleared |
| Anthropic status (`anthropic-status`) | as above | status.claude.com disallows `/api/` and `/embed/`; since 2026-11-04 the source reads `/history.atom`, outside both (next addendum) | 6 h | not-cleared |
| xAI docs (`xai-models-md`), xAI status (`xai-status`) | x.ai answers 403 headless; read in a browser by the coverage-gaps addendum above, the Acceptable Use Policy bars "unauthorized automated or non-human means" | docs.x.ai allows all (`Content-Signal: ai-input=yes`); status.x.ai allows the feed, disallows `/api/` | 5 min; status 6 h | not-cleared |
| Google careers feed (`google-careers`) | Google ToS, as for the docs | www.google.com disallows only the results page's `page=` parameters | 6 h, DeepMind rows only | ours |
| Google docs (`google-pricing-html`, `google-models-md`), Google Cloud status | Google ToS bars automated access "in violation of the machine-readable instructions on our web pages (for example, robots.txt files…)" | aistudio.google.com allows `/docs/`; status.cloud.google.com allows all | 5 min; status 6 h | ours |
| Meta docs (`meta-models-md`, `meta-pricing-md`) | no website terms found for dev.meta.ai (two candidate URLs 404); the Meta Model API terms govern API calls | allows `/docs/` | 5 / 30 min | not-cleared |
| Mistral docs (`mistral-models-md`, `mistral-pricing-md`) | legal.mistral.ai consumer, commercial and usage terms: no clause on automated access | none (404) | 5 / 30 min | ours |
| Mistral status | as above | answers a Cloudflare challenge (403): **not read** | 6 h | not-cleared |
| OpenRouter models / rankings | see above | allows `/` | 6 h | not-cleared / upstream |
| Ashby boards (OpenAI, Mistral) | documented public posting API; Ashby's terms say nothing on it | none (401) | 6 h | ours |
| Greenhouse boards (Anthropic, xAI, + departments) | "Job Board data is publicly available, so authentication is not required for any GET endpoints." | disallows only `/embed/` | 6 h | ours |
| EDGAR (full-text search, submissions, company facts) | US government work (17 U.S.C. 105); SEC fair access: declared User-Agent, 10 requests a second | efts.sec.gov 403; data.sec.gov none (404) | 30 min | ours |

The rule behind `ours`: both the terms and robots.txt were read, and neither restricts what is taken. Stored job rows carry no posting body and no names of people (the parser schema is strict). Greenhouse payloads have had each job's `metadata` (a named Team Lead and work email) removed before archiving since 2026-11-04 (`layers/talent/server/pipeline/redact.ts`), but earlier R2 objects still hold it, so archived job-board payloads are not part of any "source bytes" offer until they are scrubbed. "Not read" is not "restricted": OpenAI and Meta can move to `ours` once someone reads their terms in a browser. The Anthropic status feed's robots.txt is the one live robots conflict found. It is a documented endpoint polled four times a day and stays on the free site; whether to keep polling it is the owner's call.

Recipes gained `rights` too: GPU price pages and APIs, SEC and posted pay are `ours`, except `gpu-oracle`, whose robots.txt could not be read. Epoch, PyPI (PSF CC BY 4.0 via pypistats) and npm are `upstream`. The Ramp AI Index (no licence; robots.txt disallows `/*.csv`), the GitHub PR counts ("research publications must be open access") and the published rate limits (read off the lab docs above) are `not-cleared`. `/contact` lists the three groups from these fields, and `/data`'s coverage table shows each source's terms beside its caveat.

The Cloudflare thesis's six recipes predated `recipe_sources` and sat in no `/contact` group; they were registered later the same day. SEC company facts (Cloudflare, Akamai, Fastly) and the Greenhouse departments board are `ours`, npm (`wrangler`) is `upstream`, and the developer changelog is `not-cleared`: Cloudflare's Terms of Use (section 8) bar bots that use site content for an AI system "or the operation thereof" unless robots.txt allows an AI-only user agent, and the judge rates each entry while robots.txt declares `ai-input=yes` for every agent. A registry recipe with no entry now fails `layers/terminal/test/terminal-sources.test.ts`.

### Entities and securities

`/export/entity_securities.csv` maps each lab and tracked filer to its securities: Anthropic → Anthropic, PBC, CIK 0002130357, proposed symbol ANT on the Nasdaq Global Select Market per its S-1 cover (registered, not trading), and AMZN as a disclosed investor. OpenAI is private, with MSFT as a disclosed investor. Google → Alphabet GOOGL and GOOG; Meta → META; xAI → SPCX as parent, with the blend caveat; Mistral is private. MSFT, AMZN, NVDA and CRWV are filers in their own right. Every CIK comes from `cik_whitelist`, a recipe, or the lab's own S-1. Every symbol and exchange is the one EDGAR's submissions feed lists for that CIK, and `layers/terminal/test/terminal-entities.test.ts` checks both. Alphabet's Anthropic stake is not mapped, because its filings never name the investee (`alphabet-anthropic-stake`). Oracle, Cloudflare, Akamai and Fastly have no row: no submissions feed is read for them, so their symbols are not sourced here.

## Addendum, 2026-11-04 — Anthropic status: the Atom feed, not the JSON API

`status.claude.com/robots.txt`, fetched 2026-11-04:

```
User-agent: *
Disallow: /api/
Disallow: /embed/
```

The `anthropic-status` source had read `/api/v2/incidents.json` since 2026-09-08, against the rule this audit applies everywhere else (robots.txt says no → skip). It now reads `status.claude.com/history.atom`, which robots.txt allows. Fetched at 14:44Z: 200, `application/atom+xml`, 40,895 bytes, committed whole as `fixtures/status/anthropic-status.xml`.

| Field | JSON API (before) | Atom feed (now) |
|---|---|---|
| Incident id | `id` | The code in the entry's `/incidents/<code>` link: the same code, so every entity key carries over |
| Title | `name` | `title` |
| Status | `status` | The newest lifecycle word in the content (Investigating, Identified, Monitoring, Resolved, Postmortem). "Update" marks an update that left the status as it was, and is skipped |
| Start | `started_at` (ms) | The oldest update's stamp, to the minute |
| Resolution | `resolved_at` (ms) | The "Resolved" update's stamp, to the minute |
| Components | `components[]` | Only a "This incident affected: …" paragraph. None of the 25 entries has one, so the list is empty |
| Impact | `impact` (none/minor/major/critical) | **Not published.** Stored as null and shown as "not published", never inferred from the wording |
| Window | 50 incidents | 25 entries (2026-09-03 → 2026-10-28) |

Update stamps print no year ("Oct 28, 20:05 UTC"). The parser takes the year that puts the stamp at or before the entry's own `updated` time. On the overlapping incidents, start and resolution match the API's to the minute (`461yvfrzpwtt`: 13:26:04.191Z / 16:23:12.052Z then, 13:26 / 16:23 now).

**What was lost.** Impact and component names on every Anthropic incident read from now on. Incidents that had already left the Atom window keep what the API gave them. The first poll at the new URL rewrites the incidents still in the window without logging changes (`refresh.ts`, a source that moved URL), so dropping impact is not reported as 25 modified incidents. The Anthropic thesis's claim 5 picked incidents by impact; it now takes Anthropic's on duration alone and leaves materiality to the rubric (`docs/theses/anthropic.md`, revision 2026-11-04).

**Verdict.** Include `history.atom`. The `/api/` URL is gone from code, config and fixtures.

## Addendum, 2026-11-04: hyperscaler capex, backlog, and lab stakes from 2020

The `filed_fact_sources` block in `sources.yaml` reads five filers: Microsoft, Alphabet, Amazon, Meta and Oracle. Oracle joins `cik_whitelist`: SEC's `company_tickers.json` gives ORCL → 1341439, and `data.sec.gov/submissions/CIK0001341439.json` answers "ORACLE CORP" (fiscal year end 0531). Its submissions feed is a source (`edgar-submissions-orcl`), so its 10-Q and 10-K raise the periodic-floor alert like the others.

**Company facts** (`data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, 2.8 to 4.9 MB) carry every non-dimensional fact with its accession and filing date, back past 2020. Tags read:

| Filer | Capex | Finance leases (shown beside, never added) | Backlog total |
|---|---|---|---|
| MSFT | `PaymentsToAcquirePropertyPlantAndEquipment` ("Additions to property and equipment") | `RightOfUseAssetObtainedInExchangeForFinanceLeaseLiability` | `RevenueRemainingPerformanceObligation` |
| GOOGL | `PaymentsToAcquirePropertyPlantAndEquipment` ("Purchases of property and equipment") | none | `RevenueRemainingPerformanceObligation` |
| AMZN | `PaymentsToAcquireProductiveAssets` ("Purchases of property and equipment") | none | plain fact to 2020-06-30, then a typed timing axis (instances) |
| META | `PaymentsToAcquirePropertyPlantAndEquipment` ("Purchases of property and equipment") | `FinanceLeasePrincipalPayments` | not tagged |
| ORCL | `PaymentsToAcquirePropertyPlantAndEquipment` ("Capital expenditures") | none | `RevenueRemainingPerformanceObligation` |

Cash-flow lines are tagged year to date, so most quarters are derived (six months less three, and so on) and marked so.

**Instances.** Company facts drop every dimensional fact. Microsoft's commercial backlog (`srt:MajorCustomersAxis=msft:CommercialCustomersMember`, from the 10-Q for 2020-09-30), its facts on `msft:OpenAIGlobalLlcMember` (from the 10-Q for 2024-09-30), Amazon's total backlog after 2020-06-30 (typed `RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis`, the day after the period end), its facts on `amzn:AnthropicMember` (from the 10-Q for 2026-03-31), its backlog on `amzn:OpenAIGroupPBCMember`, and Alphabet's Google Cloud backlog (`goog:GoogleCloudMember`, from the 10-Q for 2026-03-31) are read from each 10-Q/10-K instance, named after the primary document in the submissions feed (`msft-10q_20200930.htm` → `msft-10q_20200930_htm.xml`). All 63 instances since 2020 resolved on a local run (2026-11-04). Alphabet's submissions feed lists 10-Q/10-K back to 2023-08 only.

**Spot checks** against each filing's own HTML, two values per series where two exist: all matched, among them Microsoft capex $39,367M (10-Q 2026-10-28) and $3,767M for the quarter to 2020-03-31, Oracle backlog $664B and $33.8B (2020-02-29), Amazon backlog $578B and $34.1B (2020-03-31), Microsoft's OpenAI funding of $13.0B committed and $12.0B paid in, and Amazon's upward marks of $62.8B for the nine months to 2026-09-30. Meta's own "capital expenditures, including principal payments on finance leases" of $34.91B is our two lines added ($33.94B + $0.96B).

Two findings changed labels. Alphabet's $16.8B backlog tagged on an equity-method investee is named in its text as Crux AI, a joint venture. From the first quarter of 2026 Alphabet's backlog also counts contracts of a year or less, so it breaks with earlier quarters.

**Alphabet and Anthropic.** EDGAR full-text search for "Anthropic" in Alphabet's 10-Q and 10-K returns no hits, and no XBRL fact names it. It stays a stated gap (`cut: alphabet-anthropic-stake`).

**Verdict.** Include all five. Terms are the SEC's: US government work, fair-access rate and a declared contact.

## Addendum, 2026-11-04: track record (GDELT and the lab newsrooms)

Checked for `/track-record`, which times each notable or critical alert against the first press report and the lab's own post. Live-fetched with the pipeline's User-Agent between 16:45Z and 17:00Z. Terms and robots.txt read the same day.

| Source | URL | Fetch | robots.txt | Terms | Rights |
|---|---|---|---|---|---|
| GDELT DOC 2.0 | `api.gdeltproject.org/api/v2/doc/doc` (artlist, JSON) | 200, 10 articles for `"gpt-6.1-sol"` over 2026-09-22 → 2026-10-06; many 429s around it | none (404) | "unlimited and unrestricted use for any academic, commercial, or governmental use", with a citation and link required on redistribution | `upstream` |
| OpenAI News | `openai.com/news/rss.xml` | 200, RSS 2.0, 1,356 items back to 2015, 823 KB | allows it (disallows only `/microsoft-for-startups/`) | Terms of Use (effective 2026-01-01) cover "associated software applications and websites" and bar users who "Automatically or programmatically extract data or Output" | `not-cleared` |
| Google DeepMind | `deepmind.google/blog/rss.xml` | 200, RSS 2.0, newest 100 posts | allows everything | Google's ToS bar automated access only against robots.txt | `ours` |
| Meta Newsroom | `about.fb.com/feed/` | 200, RSS 2.0, newest 10 posts (back to 2026-10-13) | allows `/feed/` | facebook.com/terms.php renders only in a browser, so it wasn't read. ai.meta.com's robots.txt notice bars automated collection "on Facebook" | `not-cleared` |
| Mistral | `mistral.ai/news/rss` (`/rss.xml` redirects here) | 200, RSS 2.0, 93 posts back to 2023 | allows everything | legal.mistral.ai says nothing about automated access | `ours` |
| Anthropic | `anthropic.com/rss.xml`, `/news/rss.xml` | 404, and `/news` links no feed | allows everything | Consumer Terms bar crawling and scraping | **cut** |
| xAI | `x.ai/news/rss.xml` | 404, and `/news` links no feed | allows everything except `/tools/` | AUP bars "unauthorized automated or non-human means" | **cut** |
| Meta AI blog | `ai.meta.com/blog/rss/` | 404, no feed | n/a | n/a | not used (the company newsroom stands in) |

**Findings.** GDELT answers more than one query every five seconds with minutes of 429s, not seconds. From one IP, a query every 30 to 90 seconds still drew 429s for several minutes after the first burst. The search therefore runs one query per five-minute tick and never retries a 429 inside a tick. A Worker's egress IP is shared, so production may see 429s it didn't cause. GDELT's `seendate` is when its crawler first saw the article, not the outlet's publication time. The artlist returns no article text, so a candidate is judged on its headline, and GDELT spaces out punctuation in titles ("GPT - 6 . 1 Sol"); the search closes those gaps before storing a title (`untokenizeTitle`), so "6.1" reads as one number, but cannot restore a hyphen or the apostrophes GDELT drops. The DOC API searches only the last three months. Mistral stamps recent posts near 12:00 UTC, so its post times are dates. None of the feeds is paywalled and no news outlet is fetched directly.

**Saw-it time.** The brief asked for the fetch time of the earliest cited change row. A removal's row carried the removed entity's own `fetched_at`, which only moves when the entity's content changes, so it was up to 51 days before the removal on the alerts checked. A removal therefore counts from its `detected_at`, the run that found it gone. Since migration 0036 `diff.ts` stamps a removal with that run's fetch, and the migration rewrote the older rows. Added and modified rows use `fetched_at`, which matched `detected_at` to the hour on every alert since 2026-09-08.

**Verdict.** Include GDELT (per alert, `track_record_sources`) and the four feeds (recipes, `recipe_sources`). OpenAI and Meta stay `not-cleared` and out of any paid offer. Anthropic and xAI have no newsroom time on the page, and the cut block says why.

**Update, 2026-11-06: GDELT moved off the Worker.** In production 255 of about 300 GDELT queries from the Worker drew a 429, and 6 timed out, at one query per five minutes: GDELT limits per IP, and Workers share egress IPs with other tenants. Cloudflare's dedicated egress IPs are an Enterprise add-on. The queries now run from a GitHub Actions job (`.github/workflows/gdelt-search.yml`, `scripts/gdelt-search.ts`) hourly, one every 6 seconds, at most 10 per run, stopping at the first 429 or timeout. The Worker hands out the exact URLs (`/api/gdelt/pending`) and stores the answers (`/api/gdelt/result`), so the stored rows, bytes and provenance are unchanged.

**Update, 2026-11-07: GDELT's files instead of its search API.** The Actions job fared no better. Moved to the owner's Mac mini (a home IP of our own), its first query drew a 429, and so did a single `curl` from the same IP a minute later, spaced well past "one every 5 seconds". Of 118 material alerts, 30 had never been searched. The search API is built on GDELT's crawl, and GDELT publishes that crawl as static files: one zipped GKG 2.1 TSV per quarter hour (`data.gdeltproject.org/gdeltv2/<stamp>.gkg.csv.zip`, ~2.5 MB, ~1,200 English articles), under the same terms and with no stated rate limit. The job now reads every file once, from 2026-09-01 on, and posts the rows that match an alert (`/api/gdelt/work`, `/api/gdelt/file`). The Worker matches each row again and keeps the matched rows whole in R2 (`track-record/gkg/<stamp>.tsv`, sources.yaml › `gdelt-gkg`). One difference: the search API matched article text, while a file has only the headline, URL and the names GDELT found, so the event must be in the headline or URL. Considered and not taken: the outlets' own RSS feeds. robots.txt allowed most of them, but the terms of Dow Jones (WSJ), Condé Nast (Ars Technica, Wired), Vox Media (The Verge), Business Insider, Bloomberg and MIT Technology Review forbid automated access to "monitor" or "periodically cache" their content. Dow Jones names RSS content and says robots.txt does not widen the grant. The Register, The Decoder and Axios disallow their feeds in robots.txt.

## Addendum, 2026-11-04 — DeepSeek, Alibaba (Qwen) and Moonshot AI (Kimi)

Live-fetched with `curl -L` and the pipeline's descriptive User-Agent at 20:30–21:15Z; SEC endpoints with the declared SEC User-Agent. Raw bodies committed under `fixtures/pricing/`, `fixtures/status/` and `fixtures/sec/` at 20:59–21:14Z (bytes, trims and timestamps in `fixtures/manifest.json`). Checked because the three labs' OpenRouter traffic was being counted as "other": in the committed rankings fixture's newest week (to 2026-09-08), `deepseek/*` alone carried 16.8% of all OpenRouter tokens, more than any tracked lab but OpenAI. Each was checked on every axis, English or international pages first.

| Lab | Axis | Source | Result | Verdict |
|---|---|---|---|---|
| DeepSeek | Pricing | `api-docs.deepseek.com/quick_start/pricing.md` | 200, 13 663 bytes, `text/markdown`, ETag + Last-Modified. One transposed table: `deepseek-flash` (DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro`, USD per million tokens, cache hit and miss, peak and off-peak | **Include** (`deepseek-pricing-md`), catalog and prices |
| DeepSeek | Pricing | `api.deepseek.com/models` | 401 without a key | Not used |
| DeepSeek | Status | `status.deepseek.com/history.rss` | 200, 18 912 bytes, RSS 2.0 from Flashduty. 28 incidents, 2026-08-04 → 2026-11-03, all resolved. Start, newest status and components; no impact, no end | **Include** (`deepseek-status`) |
| DeepSeek | Status | `status.deepseek.com/history.atom` | 200, 18 982 bytes, the same 28 incidents; `<updated>` per entry, no start | **Include as join** (`deepseek-status-atom`), for each resolved incident's end |
| DeepSeek | Status | `status.deepseek.com/api/v2/incidents.json`, `/api/v1/incidents` | 404, 404 | Not Statuspage |
| DeepSeek | Hiring | Greenhouse, Ashby, Lever `deepseek`; Ashby `deepseek.ai`; `deepseek.com/en/careers` | all 404 | **Cut** (`deepseek-hiring`) |
| DeepSeek | SEC / revenue | EDGAR full-text search, "DeepSeek" in S-1-family forms | 7 hits, all other companies' prospectuses (WhiteFiber, SharonAI, Gloo, a SPAC); no DeepSeek filer in `company_tickers.json` | **None** — `revenue_filers.deepseek: null` |
| DeepSeek | Disclosures | `deepseek.com/safety` | 404 | **Cut** (`deepseek-disclosures`) |
| Alibaba | Pricing | `www.alibabacloud.com/help/en/model-studio/model-pricing` | 200, 505 999 bytes server-rendered HTML, no validators, a per-request trace id. One `<h3>` per model line, one `<h4>` tab per region, USD on the international site. From 2026-11-16 qwen4-max has a cache price table of its own under the Qwen-Max tab | **Include** (`alibaba-pricing-html`): Qwen-Max, -Plus and -Flash, Singapore tab, International rows, and a model's own cache price table |
| Alibaba | Pricing | `…/model-pricing.md`, and the page with `Accept: text/markdown` | the same HTML | No markdown twin, though `llms.txt` lists the `.md` URL |
| Alibaba | Class map | `www.alibabacloud.com/help/en/model-studio/models` ("Recommended models") | 200, 42 792 bytes. One card per model with a one-line use: qwen4-max "Complex reasoning and coding" (qwen3.8-max's card until the 2026-11-16 re-capture), qwen3.7-plus "Balanced performance, speed, and cost", qwen3.8-flash "Fast and cost-effective" | **Include** (`alibaba-models-html`), sentences only |
| Alibaba | Status | `status.alibabacloud.com` | 200, 2 034 bytes: a script loader. `/rss` 403, `/history` 404, no robots.txt | **Cut** (`alibaba-status`); Alibaba Cloud-wide in any case |
| Alibaba | Hiring | `careers.alibaba.com` → `talent.alibaba.com` | client-rendered, no job in the HTML, robots.txt 404; Alibaba Group-wide. Greenhouse and Ashby `qwen`, `alibaba` 404 | **Cut** (`alibaba-hiring`) |
| Alibaba | SEC | `data.sec.gov/submissions/CIK0001577552.json` | 200, 108 883 bytes, "Alibaba Group Holding Ltd", BABA on the NYSE. Of the newest 200 filings: 122 6-K, 38 Form 4, 14 Form 3; a 20-F each May or June | **Include** (`edgar-submissions-baba`), whitelisted as `BABA`; 20-F is now a tracked form, 6-K is not |
| Alibaba | Revenue | `data.sec.gov/api/xbrl/companyfacts/CIK0001577552.json` | `Revenues` in CNY (47 facts) with a USD convenience translation (16), from the 20-F and a few 6-Ks; fiscal year to March 31 | **None** — `revenue_filers.alibaba: null`, reasons below |
| Alibaba | Disclosures | `qwen.ai/safety` | redirects to the home page of a client-rendered site | **Cut** (`alibaba-disclosures`) |
| Moonshot AI | Pricing | `platform.kimi.ai/docs/pricing/chat.md` and its HTML page (`platform.moonshot.ai` redirects there); `/pricing/batch.md`; the China page `platform.kimi.com/docs/pricing/chat.md` | 200 each, but every price table is an empty `<table>`: the tables are drawn by the page's scripts | **Cut** (`moonshot-pricing`) |
| Moonshot AI | Catalog | `platform.kimi.ai/docs/models.md` | 200, 2 434 bytes. Three current ids (`kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3`) with descriptions; 18 deprecated | **Include** (`moonshot-models-md`), catalog and class map, no prices |
| Moonshot AI | Status | `status.moonshot.cn` | A Statuspage site whose robots.txt disallows `/api/`; `/history.rss` and `/history.atom` redirect to an inactive feed (404). No status host under moonshot.ai or kimi.ai (no DNS) | **Cut** (`moonshot-status`) |
| Moonshot AI | Hiring | `careers.kimi.ai` | client-rendered; sitemap lists 10 static pages, no job. Greenhouse, Lever and Ashby `moonshotai`, Ashby `moonshot.ai` 404. Ashby `moonshot` answers with 5 roles of a different company ("Robinhood for DeFi") | **Cut** (`moonshot-hiring`) |
| Moonshot AI | SEC / revenue | EDGAR full-text search, "Moonshot AI" in S-1-family forms | 0 hits | **None** — `revenue_filers.moonshot: null` |
| Moonshot AI | Disclosures | `moonshot.ai/safety`, `kimi.ai/safety` | redirect to each home page | **Cut** (`moonshot-disclosures`) |
| All three | Demand | OpenRouter `deepseek/*` (15 models in the live list), `qwen/*` (42), `moonshotai/*` (9); no `alibaba/*` id. Rankings fixture: 163, 65 and 38 rows | — | **Include** — each prefix maps to its lab |

**Terms.** All three restrict automated reading, so every new lab source is `not-cleared`: kept on the free site, as Anthropic's docs are, and out of any paid offer. DeepSeek's Terms of Use (last updated 2026-03-27) define the Services to include its websites and list among prohibited acts "capturing, copying any content of the Services, including but not limited to using any robots, spiders, or other automatic setups"; `api-docs.deepseek.com/robots.txt` allows everything, and `status.deepseek.com` has none. Alibaba Cloud's international Website Terms of Use (last updated 2026-03-20) prohibit "Systematic retrieval of Content from the Services to create or compile, directly or indirectly, a collection, compilation, database or directory (whether through robots, spiders, automatic devices or manual processes) without written permission"; robots.txt allows `/help/`. Because of that clause and the page's size, the pricing page is read every 30 minutes and never on the five-minute tripwire, which watches the 43 KB recommended-models page instead. Moonshot's Kimi Open Platform terms (last updated 2026-07-30) cover "documentation, and websites" and bar users from "Use any method to extract data from the Services other than as permitted through the APIs"; robots.txt allows `/docs`. EDGAR is `ours`, as for every filer.

**Currency.** Every stored price is USD as printed. DeepSeek's English page and Alibaba's international site print USD; the Chinese pages (`api-docs.deepseek.com/zh-cn`, `help.aliyun.com`, `platform.kimi.com`) print CNY and are not read. No price is converted. Alibaba's Beijing tab also prints USD, below Singapore's for the same ids ($1.65 / $4.951 against $2 / $6 for qwen3.8-max); only the Singapore tab's International rows are read, because they are the price an international buyer is quoted.

**Findings.** DeepSeek prices by time of day: off-peak, which covers weekends, Chinese public holidays and every weekday hour outside 01:00–04:00 and 06:00–10:00 UTC, is half the peak rate. The peak price is the list price and fills the standard row; off-peak is its own `off_peak` tier, never a discount on it. Interpretation, marked as such: most hours of the week are off-peak, so a caller who can wait pays half the standard row.

Alibaba's page prices each id in request-size bands ("0<Token≤256K", "256K<Token≤1M"). The first band is the standard row and each later band its own tier, as OpenAI's long-context rows are. Some Plus rows print "List price $0.4 (Limited-time 20% off)"; the list price is stored and the promotion noted, with no end date because none is printed. Where a table prices non-thinking and thinking output apart (qwen-plus: $1.2 against $4), the non-thinking price is the output price and the other is in notes. The page also resells DeepSeek, Kimi, GLM and MiniMax models in a "third-party models" section; none is read, so a resold model is never an Alibaba SKU (Mistral's resold DeepSeek models are skipped for the same reason).

DeepSeek's RSS feed gives each incident's start and its newest status, and no end. A null end reads as an open incident everywhere on the site, so the RSS alone would show 28 resolved incidents as ongoing. The Atom twin lists the same incidents with `<updated>`, the newest update. For the 8 incidents the status page itself shows, that stamp equals, to the second, the close time the page prints (for example 7202016104287: 08:58:16Z to 10:48:02Z). So the end is read from the Atom feed when the RSS status is `resolved`. A note posted after resolution would move it; the caveat says so.

**Revenue: none for Alibaba, and why.** Google shows Alphabet's Google Cloud segment. Alibaba's nearest equivalent is the Cloud Intelligence Group, which is all of Alibaba Cloud, as Google Cloud is all of GCP. It is not shown, for three reasons. Alibaba reports in RMB, with USD only as a convenience translation at one year-end rate, and the revenue panel shows the filer's own USD values and converts nothing. Its tagged XBRL comes in the annual 20-F; quarterly results arrive as 6-K press releases, so the series would be one point a year beside quarterly ones. And the revenue extractors read 10-Q and 10-K instances. The filings feed is registered so the 20-F lands on the SEC axis as it is filed.

**Class map.** Alibaba's recommended-models page names three Qwen text models, each with its use, and all three cells are mapped from those lines. The flagship line, "Complex reasoning and coding", is a use rather than a "start here", and is read as the page's answer for hard work, as OpenAI's flagship sentence is ("our flagship model for complex reasoning and coding"). Moonshot's model list calls `kimi-k3.1-pro` "Kimi's most capable flagship to date", so the flagship cell is mapped, but it shows no price because none is served. DeepSeek's only catalog page names no tier, so all three of its cells are stated gaps, as are Moonshot's balanced and economy cells.

**Shares.** Each lab's demand share is now read off each stored row's model id at query time, not off the provider column written when the row was parsed. Rankings rows older than OpenRouter's 30-day window are never re-parsed, so the column keeps the prefix map of the day they were stored, and a lab added later would count as "other" before that day and as itself after it.

**Verdict: track DeepSeek, Alibaba and Moonshot AI as labs.** Include `deepseek-pricing-md`, `deepseek-status` (+ `deepseek-status-atom`), `alibaba-pricing-html`, `alibaba-models-html`, `moonshot-models-md` and `edgar-submissions-baba`, and map `deepseek/*`, `qwen/*` and `moonshotai/*` on OpenRouter. Cut `deepseek-hiring`, `deepseek-disclosures`, `alibaba-hiring`, `alibaba-status`, `alibaba-disclosures`, `moonshot-pricing`, `moonshot-hiring`, `moonshot-status` and `moonshot-disclosures`. `revenue_filers` is null for all three.

## Addendum, 2026-11-04: Internet Archive (API price history before 2026-08-25)

Checked for the price-history backfill (`scripts/wayback-backfill.ts`, eras in `layers/pricing/server/pipeline/archive/eras.ts`). Our own capture starts 2026-08-25. The Wayback Machine holds the labs' own pricing pages from before then. Every CDX listing and capture below was fetched on 2026-11-04 with a User-Agent naming this site, one request at a time, 4 seconds apart.

**Terms.** archive.org/about/terms.php is now a script shell, so the terms were read from the Archive's own capture of that page (dated 31 Dec 2014, unchanged since). Access to the Collections is "granted for scholarship and research purposes only". Use must be "limited to noninfringing or fair use under copyright law". Users agree "not to interfere with the work of other users or Archive personnel, servers, or resources", and published research should list the Archive in its bibliography. The Archive claims no license over the pages it holds; they stay the labs'. We take only the price facts each lab printed about its own API. web.archive.org/robots.txt is a 404 and archive.org/robots.txt disallows only `/control/` and `/report/`. A page a site owner excluded isn't replayed, so it never reaches us. The CDX server's documentation (the wayback-cdx-server README in github.com/internetarchive/wayback) states no rate limit, so we pace ourselves and back off on a 429 or 5xx.

**Rights.** `not-cleared` (`sources.yaml › archive_sources › wayback-pricing`). Archived rows are CC BY-NC 4.0 as full history, and a licensee's key doesn't relabel them (`ARCHIVED_EXPORTS` in `server/registries/export-tables.ts`), because the Archive's terms are for scholarship and research.

**Method.** For each era's URL, the CDX API lists 200 captures with `collapse=digest`. The pages re-render a nonce or build id daily, so the backfill reads the first capture of each week, raw (`id_`), and parses it with that era's parser. A capture the parser can't read is skipped with the parser's own reason (`archive_captures.detail`). A capture with no closing `</html>` (the Archive keeps some cut at 1 MiB) is skipped too, because a truncated list would read as delistings.

| Lab | Era (URL) | Window | Shape | Read | Skipped |
|---|---|---|---|---|---|
| OpenAI | openai.com/pricing | 2023-01 → 2024-05-02 | HTML tables per family, $/1K then $/1M tokens | 54 | 1 (Feb 2023: no token tables) |
| OpenAI | openai.com/api/pricing | 2024-05-02 → 2025-01-28 | div grid, standard and Batch API, cached input from Oct 2024 | 29 | 1 (truncated) |
| OpenAI | developers.openai.com/api/docs/pricing | 2026-02-01 → 2026-03-08 | Text tokens table per tier tab | 4 | 0 |
| OpenAI | developers.openai.com/api/docs/pricing.md | 2026-07-29 → 2026-08-25 | markdown, one cache-writes column | 2 | 0 |
| Anthropic | docs.anthropic.com/claude/docs/models-overview | 2024-03-01 → 2024-05-21 | comparison table, cost row | 6 | 0 |
| Anthropic | docs.anthropic.com/en/docs/models-overview | 2024-05-21 → 2024-06-20 | comparison table, cost row | 2 | 0 |
| Anthropic | docs.anthropic.com/en/docs/about-claude/models | 2024-06-20 → 2025-02-24 | comparison tables, cost row | 27 | 0 |
| Anthropic | …/about-claude/models/all-models | 2025-02-24 → 2025-05-12 | comparison tables, cost row | 8 | 2 (cost row gone) |
| Anthropic | docs.anthropic.com/en/docs/about-claude/pricing | 2025-05-12 → 2025-09-19 | the live pricing tables, as HTML | 10 | 2 (five-column table) |
| Anthropic | docs.claude.com/en/docs/about-claude/pricing | 2025-09-19 → 2025-11-19 | same | 7 | 0 |
| Anthropic | platform.claude.com/docs/en/about-claude/pricing | 2025-11-19 → 2026-06-11 | same | 21 | 6 (5 with a cut-short batch row, 1 replayed as another capture) |
| Anthropic | platform.claude.com/docs/en/about-claude/pricing.md | 2026-06-11 → 2026-08-25 | the markdown the live parser reads | 1 | 0 |

Totals on the local run: 171 captures read (2,726 rows, 260 SKU keys, 187 of them keys the live pages still list), 12 skipped. Captures are 0.1 to 2.3 MB; all of them come to about 142 MB in R2.

**Findings.** In 2024 Anthropic's docs rendered "$0.25 / $1.25" as KaTeX math (the two dollar signs read as a formula), so the cell showed "0.25/1.25". The parser puts the TeX source back (`unrenderInlineMath`) instead of skipping half a year of Haiku prices. The 2023 OpenAI page named GPT-4 and GPT-3.5 Turbo SKUs by context length ("8K context" under GPT-4). Those four labels map to the ids the same page's docs named (gpt-4, gpt-4-32k, gpt-3.5-turbo, gpt-3.5-turbo-16k), and the label stays in notes. Anthropic's older name order ("Claude 3.5 Haiku") is rewritten to the current one before the live slug rule runs, so both land on `model:anthropic:claude-haiku-3-5`. A row OpenAI priced per modality (gpt-4o-audio-preview: text and audio) isn't read, and the capture names it.

**Gaps.** OpenAI 2025-01-28 → 2026-02-01: the page changed layout, then the Archive holds only a Cloudflare check page, and platform.openai.com/docs/pricing is a script shell with no prices. OpenAI 2026-03-08 → 2026-07-29: tabbed per-family tables not read yet. Anthropic before 2024-03: Claude 2 prices were a PDF rate card. Google, xAI and Mistral are archived but not read yet. Meta had no first-party price list before the live source.

**Verdict.** Include, as a one-off backfill (never on a cron), `rights: not-cleared`.

### Second pass, 2026-11-04: the gaps above, Google, xAI, Mistral, DeepSeek, Alibaba, Moonshot

Same client, same pace and User-Agent, same terms. CDX listings were plain URL queries (one prefix sweep on openai.com/api/pricing hit a 503 and then a 504, and was stopped instead of retried). Every era below has a parser, a trimmed fixture recorded in `fixtures/manifest.json`, and a golden test in `layers/pricing/test/pipeline/wayback-labs.golden.test.ts`. Counts are from the local run, one capture per week of each era.

| Lab | Era (URL) | Window | Shape | Read | Skipped |
|---|---|---|---|---|---|
| OpenAI | openai.com/api/pricing (`openai-api-pricing-2025`) | 2025-01-28 → 2025-02-14 | the 2024 feature groups, each row opening on its own header | 1 | 1 (page shell) |
| OpenAI | developers.openai.com/api/docs/pricing (`openai-docs-pricing-2026b`) | 2026-03-08 → 2026-07-29 | per-tier tabs of "latest models", the full lists in each tab's island props | 17 | 0 |
| Google | ai.google.dev/pricing (`google-pricing-2024`) | 2023-12-01 → 2025-02-11 | one card per model, prices by prompt length in running text, three layouts | 26 | 18 |
| Google | ai.google.dev/gemini-api/docs/pricing (`google-docs-pricing-2025`) | 2025-02-11 → 2026-08-25 | the HTML the live parser reads | 72 | 0 |
| xAI | x.ai/api (`xai-api-2025`) | 2024-11-04 → 2025-07-11 | model cards | 2 | 17 |
| xAI | docs.x.ai/docs/models (`xai-docs-models-2025`) | 2025-07-11 → 2026-02-05 | Model Pricing table | 9 | 6 |
| xAI | docs.x.ai/developers/models.md (`xai-models-md-2026`) | 2026-03-12 → 2026-08-25 | markdown, three layouts, the last the live one | 7 | 0 |
| Mistral | docs.mistral.ai/platform/pricing (`mistral-docs-pricing-2023`) | 2023-12-01 → 2024-04-14 | a table per API, EUR only, then USD and EUR columns | 5 | 5 (EUR only) |
| Mistral | mistral.ai/technology (`mistral-technology-2024`) | 2024-04-14 → 2025-03-21 | a USD table and its EUR twin per family | 28 | 0 |
| DeepSeek | platform.deepseek.com/api-docs/pricing (`deepseek-platform-pricing-2024`) | 2024-05-01 → 2024-11-04 | a row per model, USD and CNY tables | 6 | 0 |
| DeepSeek | api-docs.deepseek.com/quick_start/pricing (`deepseek-api-docs-pricing-2024`) | 2024-11-04 → 2026-08-25 | four table layouts, rowspans and colspans | 35 | 1 (the page moved its table) |
| Alibaba | alibabacloud.com/help/en/model-studio/model-pricing (`alibaba-model-pricing-2026`) | 2026-01-16 → 2026-08-25 | per Qwen line, an International tab, later a Singapore tab | 14 | 0 |

Totals on the local run: 222 captures read (5,358 rows), 48 skipped. Earliest readable capture per lab: Google 2024-06-15, xAI 2025-03-20, Mistral 2024-02-26, DeepSeek 2024-05-25, Alibaba 2026-01-16.

**Correction to the first pass.** The Archive's 2025 copies of openai.com/api/pricing are not a Cloudflare check page (the challenge script is only a background tag). Through early February 2025 they carry the late-January layout, which is now read. From February 6 they hold the page shell with the prices inside scripts, and from mid-February the page lists a few flagship models by marketing name ("GPT-4.1", "OpenAI o3") and links out for the rest. That list is a subset, and reading it would turn every other SKU into a delisting, so it isn't read. platform.openai.com/docs/pricing and platform.openai.com/docs/models/gpt-4.1 (checked August 2025) are 4,279-byte script shells.

**OpenAI.** The late-January 2025 page misprinted o3-mini's snapshot as "03-mini-2025-01-31" (a zero for the letter o) beside o3-mini at the same prices. That one string maps to `o3-mini-2025-01-31` and the printed form stays in notes. One row (o1-preview-2024-09-12) printed its output price without the word "output" and isn't read; the capture names it. From March 2026 the docs page showed only the latest models in each tier tab and drew the rest behind "View all". The full list is in the server-rendered HTML, as the `props` attribute of each tab's `<astro-island>` (tier, then rows of model and prices). We read those props and nothing from the script. They name no columns, so the columns come from the page's visible tables, and every visible row must equal the same model's props row. From mid-2026 older models' rows kept three prices (Input, Cached input, Output) after the page added a Cache writes column. That's the layout the same list had in March, and it's read that way. The first capture of the window (2026-03-08) still had full tables, with a "gpt-5.4 (>272K context length)" row of its own, filed as `long_context` like the markdown era. An empty cell or "/" is a price the tier doesn't offer.

**Google.** ai.google.dev/pricing printed no prices until January 2024, then priced Gemini per 1,000 characters until April 2024. Characters aren't tokens and we don't convert units, so those captures are skipped. Gemini 1.5 prices from April and May 2024 carried "Coming on May 2, 2024" or "Billing starts May 30, 2024" and are skipped as not billed yet. The cards print no API id. Each card title maps to the id Google's next page (gemini-api/docs/pricing, February 2025) linked from the section with the same anchor: Gemini 1.5 Flash, Flash-8B and Pro to `gemini-1.5-flash`, `gemini-1.5-flash-8b` and `gemini-1.5-pro`. Gemini 1.0 Pro and Text Embedding 004 never got such a link and aren't read (named on each capture). A card's price is its short-prompt price ("for prompts up to 128K tokens"), with the long-prompt price in notes, as the live parser keeps "prompts <= 200k tokens". August 2024 printed "<= 128K" unescaped, so the HTML reader lost those words. The first amount is the one for the band the "> 128K" amount isn't. Late 2024 annotated amounts with a scheduled cut ("starting October 1st, 2024 it will reduce to $1.25"). The amount in force is read and the annotation goes in notes. The docs page printed no `<code>` model id until November 2025. Before that, the id is the one in the section's own "Try it in Google AI Studio" link (`aistudio.google.com?model=gemini-2.5-pro-preview-06-05`), used only when a section has exactly one such link. Until September 2025 the page printed no tier headings at all, so its one paid price per model is filed as `standard`, the key the live page uses for it. Once the page printed tiers, a section with no tier heading stays untiered, as live. That means the three Gemini 1.5 models move from `:standard` to the untiered key in September 2025, at unchanged prices.

**xAI.** x.ai/api printed no per-token prices until March 2025 (grok-beta's public beta). From April 2025 it lists featured models only and hides the rest behind "Show older models", which the capture doesn't hold, so those captures are skipped. docs.x.ai/docs/models shows its Model Pricing table in captures from late July to early December 2025. Before and after, captures hold "Loading models..." and are skipped. The table prints two amounts per model, read as input then output. That order matches x.ai/api for the same models at the same time (grok-code-fast-1: $0.20 input, $1.50 output on both). The markdown version (from 2026-03-12) came in three layouts: "Pricing [in (cached in) / out]", then Input and Output columns, then the live "Text API Pricing" table read by the live parser. Before the live layout each model has one price. It's filed under tier `standard`, the live key for the base (under 200k prompt tokens) price, and the row says the page printed one price. Model ids stay as printed (`grok-4.20-beta-0309-reasoning` stays separate from the live `grok-4.20-0309-reasoning`).

**Mistral.** docs.mistral.ai/platform/pricing priced in euros only until late February 2024 (skipped: we store prices as printed and never convert). From then it printed USD and EUR columns, and only the USD ones are read. mistral.ai/technology printed each family as a USD table and an EUR twin. Only tables with no euro amount are read, because mid-2024's EUR twin printed Mistral Embed's output as "$0.1". The id is the API name the page printed beside the price, kept as printed (`mistral-large-latest`, `mistral-large-2402`). mistral.ai/pricing (from March 2025) lists prices by product name ("Mistral Medium 3", "Codestral") with no API name, so it isn't read. docs.mistral.ai/inference/pricing has Archive copies only from 2026-08-13, two weeks before the live start.

**DeepSeek.** URLs checked: platform.deepseek.com/api-docs/pricing (May to September 2024), api-docs.deepseek.com/quick_start/pricing (from November 2024), its pricing.md (Archive copies only from November 2026), and the zh-cn page (CNY, not read). The CNY table beside each USD table is never read. Two identity calls. The 2025 "DISCOUNT PRICE (UTC 16:30-00:30)" band and the 2026 "OFF-PEAK" band are both a lower price for set hours of the day, which the live parser files as `off_peak`. The 2025 band is filed there too, with its printed label and hours in notes. Twice the page printed an original and a discounted price in one cell. In December 2024 to February 2025 the footnote says "The form shows the the original price and the discounted price". In May 2026 the discount was marked "(75% off)". The original (list) price is stored, as the live Alibaba parser stores "List price", and the discount in force goes in notes. One July 2026 capture held a parameter table instead of the price table and is skipped.

**Alibaba.** model-pricing has Archive copies from 2026-01-16. Until mid-2026 each Qwen line had region tabs ("Global", "International", "US", "Mainland China") with no deployment-scope column. The live parser reads the Singapore tab's rows scoped "International". The earlier "International" tab is that same deployment scope, so its rows land on the same keys and say which tab they came from. A "-" under thinking-mode output is a snapshot with no thinking mode. Before 2026, prices sat inside the Model Studio model list (getting-started/models from January 2025, then models), by region, with tiered prices described under each table. That page isn't read, and it's a stated gap.

**Moonshot.** platform.moonshot.ai/docs/pricing/chat (June 2025 to March 2026) and platform.kimi.ai/docs/pricing/chat (from March 2026) hold the page shell or its headings in every copy checked. platform.moonshot.cn prices in CNY. Not covered.

**Anthropic before 2024-03.** anthropic.com/product (2023) and docs.anthropic.com/claude/reference/selecting-a-model (2023) show no prices as text. Unchanged: a stated gap.

**Gaps now stated** (`ARCHIVE_GAPS`, each with its reason). OpenAI 2025-02 → 2026-02. Anthropic before 2024-03. Google before 2024-06-15. xAI before 2025-03-20, 2025-04-17 → 2025-07-28, and 2025-12-21 → 2026-03-12. Mistral before 2024-02-26, and 2025-02-04 → 2026-08-25. DeepSeek before 2024-05-25. Alibaba before 2026-01-16. Meta and Moonshot are not covered (`ARCHIVE_NOT_COVERED`).

### Hiring, 2026-11-05: the labs' job boards before we read them

Checked for the hiring backfill (the same `scripts/wayback-backfill.ts`, `--axis hiring`; eras in `layers/talent/server/pipeline/archive/hiring-eras.ts`, parsers in `layers/talent/server/pipeline/parsers/hiring/wayback-boards.ts`). The live boards start 2026-08-25 (OpenAI, Anthropic, xAI), 2026-11-01 (Mistral) and 2026-11-04 (Google). Same client, pace, User-Agent and terms as the price backfill (`sources.yaml › archive_sources › wayback-hiring`, `rights: not-cleared`). We store counts only: open roles on the whole board, and per department label. No title, posting text, location or person.

**URLs checked** (CDX, plain URL queries, 2022 → 2026-09). Greenhouse: `boards-api.greenhouse.io/v1/boards/<board>/jobs`, `…/jobs?content=true`, `…/departments`, `boards.greenhouse.io/<board>` and `job-boards.greenhouse.io/<board>` for anthropic, xai, openai and deepmind. Ashby: `api.ashbyhq.com/posting-api/job-board/<org>` and `jobs.ashbyhq.com/<org>` for openai, mistral and mistral.ai. Lever: `jobs.lever.co/<org>` and `api.lever.co/v0/postings/<org>` for Anthropic, openai and mistral. The labs' own pages: openai.com/careers and /careers/search, anthropic.com/careers and /jobs, x.ai/careers and /careers/open-roles, mistral.ai/careers, deepmind.google/about/careers, deepmind.google/careers, deepmind.com/careers/jobs. Google's job feed (`google.com/about/careers/applications/jobs/feed.xml`, `careers.google.com/jobs/feed.xml`) has no Archive copy. The posting APIs have almost none (Ashby: one OpenAI copy, too large to read; Greenhouse /jobs for Anthropic: two). The labs' own careers pages either link out to these boards or draw their lists with scripts, so the boards themselves are the record. openai.com/careers/search lists roles as links with no department, and one 2023 copy replays under another host, so it isn't read.

**Which board was the lab's, when.** Each lab's careers page links to one board at a time, and the eras follow those links. Anthropic posted on Lever until spring 2024 (the Lever page still listed 65 roles on 2024-04-18 and none by August) and on Greenhouse from May 2024. OpenAI posted on Greenhouse until March 2024 and on Ashby since (Ashby's team records carry the Greenhouse department ids they were imported from). Mistral posted on Lever until July 2026, then on Ashby. xAI has used Greenhouse throughout. deepmind.google linked only DeepMind's Greenhouse board until early 2026. Its copies of 2026-04-01 and 2026-06-08 also link Google's careers site (company=DeepMind), the listing we read live, so the DeepMind era ends at 2026-02-01 and the rest is a stated gap.

**Shapes and the counting rule.** A copy counts only when it lists every open role, or states the board's own total. boards.greenhouse.io (to early 2025) lists every opening on one page under department headings, sub-departments nested (a role counts under the deepest department it names, as the live /departments join files it). The board API's /departments lists every job under its department (the live join). /jobs lists every job with no department (total only). job-boards.greenhouse.io (from 2025) server-renders 50 roles a page with the board's own `total`: that total is read, and the page's 50 are never counted as the board. Only a board that fits on one page gives departments. jobs.ashbyhq.com carries every listed posting in its app data, with its department until mid-2026 and only its team after (the department is the team's root: on OpenAI's 2025-07-24 copy all 318 postings' department is the root of their team). jobs.lever.co lists every posting under its top-level category. An empty board, a truncated copy (no closing `</html>`), or a copy the Archive replays from another timestamp is skipped with the reason.

**Cross-checks.** Anthropic's /departments of 2024-06-13 lists 123 roles and its HTML board of 2024-06-14 lists 114. The nine roles only the API lists (six Responsible Scaling Policy, three Research) were all updated on 2024-06-13 and gone a day later. The rest match role for role. Anthropic's job-boards copy of 2025-09-02 states 174 roles and /departments of 2025-09-03 lists 174. xAI's /jobs of 2025-02-01 lists 70 roles and its HTML board of 2025-02-06 lists 74. Every role on xAI's /jobs copies through February 2025 names xAI as its company (the SpaceX blend came with the 2025 merger, and job-boards copies don't name a company).

| Lab | Era (URL) | Window | Shape | Read | Skipped |
|---|---|---|---|---|---|
| OpenAI | boards.greenhouse.io/openai | 2023-01 → 2024-03-14 | every opening, by department | 30 | 0 |
| OpenAI | jobs.ashbyhq.com/openai | 2024-03-14 → 2026-08-25 | app data, every listed posting | 23 | 0 |
| Anthropic | jobs.lever.co/Anthropic | 2023-01 → 2024-05-14 | every posting, by category | 19 | 0 |
| Anthropic | boards.greenhouse.io/anthropic | 2024-05-14 → 2025-03-20 | every opening, by department | 28 | 0 |
| Anthropic | boards-api …/anthropic/departments | 2024-06 → 2026-08-25 | every job under its department | 31 | 0 |
| Anthropic | job-boards.greenhouse.io/anthropic | 2025-03-20 → 2026-08-25 | the board's total (all paged) | 50 | 0 |
| xAI | boards.greenhouse.io/xai | 2023-11 → 2025-03-04 | every opening, nested departments | 21 | 0 |
| xAI | boards-api …/xai/jobs | 2023-11 → 2025-03-04 | every job, total only | 32 | 0 |
| xAI | job-boards.greenhouse.io/xai | 2025-03-04 → 2026-08-25 | the board's total (all paged) | 39 | 1 (replayed from another day) |
| Mistral | jobs.lever.co/mistral | 2023-09 → 2026-07-12 | every posting, by category | 57 | 0 |
| Mistral | jobs.ashbyhq.com/mistral.ai | 2026-07-12 → 2026-11-01 | app data, every listed posting | 7 | 0 |
| Google | boards.greenhouse.io/deepmind | 2023-01 → 2025-03-31 | every opening, by department | 50 | 0 |
| Google | job-boards.greenhouse.io/deepmind | 2025-03-31 → 2026-02-01 | departments when one page (2 of 29), else the total | 29 | 0 |

Totals on the local run (one copy per week of each era): 416 copies read (3,460 rows: 416 board totals and 3,044 department counts), 1 skipped. Earliest readable copy per lab: OpenAI 2023-01-08 (37 roles), Anthropic 2023-01-18 (23), DeepMind 2023-01-27 (11), Mistral 2023-09-27 (7), xAI 2023-11-05 (5). The copies are 2 kB to 0.9 MB, 94 MB in all.

**Departments.** Every row keeps the label as printed. `department` is today's live label only where the board's own id ties the two: a Greenhouse department keeps its id through renames, an Ashby department is the root team whose id the posting carried, and OpenAI's 2023 Greenhouse departments are the Ashby departments that record them as `importedId` (`HIRING_DEPARTMENT_IDS`). Lever has no ids, so its labels stand as printed (Mistral's Lever categories are mostly its Ashby department names already). The ties that change a label: Anthropic "Research" → AI Research & Engineering; "Product" → Product Management, Support, & Operations; "Trust & Safety" and "Safeguards" → Safeguards (Trust & Safety); "Communications & Marketing" and "Communications & Brand" → Communications; "Marketing" → Marketing & Brand; "Policy, Societal Impacts and Frontier Red Team" and "AI Policy & Societal Impacts" → Public Policy; "Infrastructure" and "Core Engineering" → Software Engineering - Infrastructure. xAI "Data Center Operations" and "Network Operations" → Data Center; "Labeling" → Human Data; "Research & Development" (a parent with sub-departments in 2025) → Engineering. OpenAI "Technical Finance" → Finance; "Communications, Public Policy" and "Public Policy" → Global Affairs; "Applied AI Research" → Safety Systems; "Platform" → Scaling; "Research, Engineering, Product" → Research; "Executive Administration" → Executive Operations; "Go-to-Market" → Go To Market; "Model Deployment for Business" → Forward Deployed Engineering; "Consumer Products" → XYZ - Consumer Devices | Restricted. The physical-infrastructure cluster is matched on the live department, so Anthropic's 2024 "Infrastructure" (the same department as today's Software Engineering - Infrastructure) stays out of it, as it does live. DeepMind's Greenhouse departments ("GenAI", "Bard") have no tie to the Google categories the live feed prints.

**Gaps.** Stated (`HIRING_ARCHIVE_GAPS`): xAI before 2023-11-05 (it announced itself in July 2023), Mistral before 2023-09-27 (founded April 2023), and Google from 2026-02-01 (the board change above). Every other stretch of more than 45 days with no readable copy is computed on the read side with what the Archive held there (`queryHiringReach`). On the local run: OpenAI's Ashby board has copies about every two months in 2024 and 2026 (gaps 2024-03 → 2024-09, 2024-09 → 2024-11, 2025-09 → 2026-03, 2026-03 → 2026-08), Anthropic none between 2023-08-06 and 2023-12-07, xAI none between 2023-12-03 and 2024-02-07, Mistral none between 2025-11-19 and 2026-01-07. Meta isn't covered: metacareers.com draws its list with scripts and has no board API.

**Verdict.** Include, as a one-off backfill (never on a cron), `rights: not-cleared`. Archived counts carry `basis: archived` and CC BY-NC 4.0 under any key, and never reach the hiring floor, the weekly roll-up, the judge or a thesis: those read `entities` and `changes`, and the backfill writes only `archive_captures` and `archived_hiring`.

### OpenRouter rankings before 2026-08-10

The live series starts 2026-08-10 because the rankings endpoint defaults to the trailing 30 days. OpenRouter's own documentation (openrouter.ai/docs/cookbook/administration/data-api, read 2026-11-05) says `rankings-daily` begins on 2025-01-01, takes `start_date` and `end_date` up to 366 days apart, and is CC BY 4.0, the license the live source already carries. So OpenRouter itself holds the history from 2025-01-01, as the same dataset, and that is the honest backfill: two keyed requests, rows into the live rankings table with their own provenance (`rights: upstream`, not archived). Ranking rows never reach the judge (`JUDGE_EXCLUDED_ENTITY_TYPES`).

**Backfill, 2026-11-20.** `bun run backfill:rankings` (`scripts/rankings-backfill.ts`, `layers/terminal/server/pipeline/rankings-history.ts`), run once by the owner with the key on stdin. The docs, re-read 2026-11-20, still give 2025-01-01 as the first day and 366 days as the widest span, with no pagination (at most 51 rows a day), 30 requests a minute per key and 500 a day per account. The script asks for windows of at most 366 days, newest first, from the day before the oldest stored day back to 2025-01-01: two requests from 2026-08-10. A window whose `meta.start_date` or `meta.end_date` differs from what was asked is refused. Rows land as a first observation does: entities and their snapshot, each citing the windowed URL, with no change rows and no `source_runs` row, and a stored row is never overwritten. Since the source now holds every day from 2025, a live tick diffs only the keys its own parse holds (`currentEntities` with keys, for every append-only lane).

The Internet Archive holds 392 days of openrouter.ai/rankings copies from 2023-11-25, 44 of them before 2025. Each copy's page data carries that day's top models per variant and a weekly chart. We don't read them: the page says its tokens were "normalized using the GPT-4 tokenizer" while the dataset counts each provider's own tokens, so the two are different units. The CC BY 4.0 grant also covers only what the Data API publishes, not the page. Before 2025-01-01 the rankings history stays a stated gap.

## Addendum, 2026-11-11: a fourth rights verdict, `restricted`

Until today a source whose publisher's site terms restrict automated reading was `not-cleared` and out of any paid offer. That put the OpenAI and Anthropic price pages, the headline series, outside anything a licensee could use commercially, while the free site published the same rows under CC BY 4.0.

**The verdict.** `restricted` is for a source that meets all of these:

- the publisher states the facts about itself (a price, a model id, a rate limit, an incident time);
- the page is public and needs no login;
- its robots.txt allows the path, or the host has none;
- its site terms restrict automated reading, or no terms for the host were found.

A paid license can cover our compilation of those rows (the timestamped rows, the change log, the numbers we derive), with the terms reading shown per source on /data and /contact. The saved pages are the publisher's and are never served (`payloadRefusal`).

**Moved from `not-cleared` (25 entries).** `openai-models-md`, `openai-pricing-md`, `openai-status`, `anthropic-models-md`, `anthropic-pricing-md`, `anthropic-status`, `xai-models-md`, `xai-status`, `meta-models-md`, the three `meta-muse-*` pages, `meta-pricing-md`, `deepseek-pricing-md`, `deepseek-status`, `deepseek-status-atom`, `alibaba-pricing-html`, `alibaba-models-html`, `moonshot-models-md`, and the six `limits-*` recipes. The three OpenAI entries now quote the Terms of Use recorded under `newsroom-openai` instead of saying the terms were unread.

**Still `not-cleared` (14 entries), and why.** `openrouter-models` (a third party's copy of vendor prices, under terms that bar scraping); `ramp-ai-index` (someone else's dataset, no stated license); `openai-misalignment-reports`, `newsroom-openai`, `newsroom-meta` and `cloudflare-changelog-ai` (a publisher's own words, not facts); `mistral-status` and `gpu-oracle` (robots.txt answers 403, so the third condition can't be checked); the three `github-prs-*` recipes (GitHub's terms condition research use on open access); `wayback-pricing` and `wayback-hiring` (the Internet Archive grants research use only); `lab-legal-pages`.

**What this is not.** No publisher has given permission and none has objected. No lawyer has reviewed the position. It rests on the pages being public facts read by an identified client at a low rate, which is how most vendors of web-collected data describe theirs. A cease-and-desist from a publisher would move its sources back to `not-cleared`.

## Addendum, 2026-11-19: data-center utilization from free sources

Checked because an alt-data marketplace asked whether utilization can be backed out of the terminal's data. Free sources only: the owner decides paid probes and datasets separately, and the 2026-11-07 decision defers our own API probes. Fetched 2026-11-19 23:50Z to 2026-11-20 00:45Z with the pipeline's descriptive User-Agent, and every terms page and robots.txt was read in the same session. Fixtures are under `fixtures/recipes/` (bytes and times in `fixtures/manifest.json`). The includes are thesis recipes (`recipe_sources`), and the cuts are under `cut`.

| Candidate | Source | Result | Terms (read the same day) | Verdict |
|---|---|---|---|---|
| Stated token volume | Alphabet's earnings releases on EDGAR, found through `efts.sec.gov` full-text search for "tokens per minute" | Five releases carry the figure: 7 billion a minute (Q3 2025), over 10 (Q4 2025), more than 16 (Q1 2026), 22 (Q2 2026), and for Q3 2026: "Overall, our first-party model APIs are now processing nearly 32 billion tokens per minute, more than four times what we processed a year ago." (accession 0001652044-26-000080) | SEC fair access. `www.sec.gov/robots.txt` allows `/Archives/edgar/data` | **Include** (`sec-googl-api-tokens`) |
| Daily token shape | OpenRouter `rankings-daily`, already in the store | "the top 50 public models per day by total token usage, plus a single aggregated `other` row per day". "Numbers are token counts (`prompt_tokens + completion_tokens`)". "The dataset begins on **2025-01-01**." | CC BY 4.0, as recorded on 2026-11-04 | **No new source.** The daily total is read for its shape only |
| Tokens per GPU-hour | MLPerf Inference v6.0, `raw.githubusercontent.com/mlcommons/inference_results_v6.0/main/summary_results.json` | 200, 784,457 bytes, 520 results. Closed division, available systems, Server scenario, tokens per second: 150 results across 7 models | Results repository: Apache License 2.0. MLPerf Results Messaging Guidelines: "Secondary and derived metrics must not be presented as official or verified MLPerf metrics. You must follow the rules above for citing an unverified score." No robots.txt on the host (404) | **Include** (`mlperf-inference-datacenter`), with the required footnote |
| Tokens per GPU-hour | SemiAnalysis InferenceX, `inferencex.semianalysis.com` | Benchmark code is Apache 2.0. Results are served from `/api` | robots.txt: `Disallow: /api/`. `/terms` answers 404, and no page states a license for the results | **Cut** (`inferencex`) |
| Capacity | Epoch AI chip users, `epoch.ai/data/ai_chip_users_intermediates_by_lab.csv` | 200, 18,814 bytes, 74 rows: each developer's year-end compute in H100e with 5th and 95th percentiles, and the model steps behind it. Google's operational fleet at the end of 2025: 3.42M H100e (2.62M to 4.55M) | "Epoch AI’s data is free to use, distribute, and reproduce provided the source and authors are credited under the Creative Commons Attribution license". robots.txt allows `/data/` | **Include** (`epoch-chip-users`) |
| Chip ratings | Epoch AI chip sales, `epoch.ai/data/ai_chip_sales_chip_types.csv` | 200, 7,347 bytes, 33 chip types with an H100e rating (H100 and H200 1.0, B200 and B300 2.53) | Same license | **Include** (`epoch-chip-types`): puts a benchmark result on the fleet's scale |
| Capacity | CoreWeave's earnings releases on EDGAR, full-text search for "active power" | Seven releases, Q1 2025 to Q3 2026: about 420 MW, 470 MW, 590 MW, more than 850 MW, "Surpassed 1 GW", 1.5 GW, and "Added more than 200 MWs of active power to reach over 1.7 GW" (accession 0001769628-26-000461). The 10-Q tags only undelivered power at leased sites | SEC fair access | **Include** (`sec-crwv-active-power`) |
| Tightness | Spot prices on pages already read: CoreWeave's pricing page, Azure's retail prices API | CoreWeave prints "Spot Price: $19.71 / Hour" beside "On-Demand Price: $49.24 / Hour" for an 8-GPU H100, and $19.51 in the page's second render. Azure's answer carries a Spot meter per size and region: the 8-GPU H100 sizes sit at 18.48% of pay-as-you-go in all 24 regions, and the response on 2026-11-19 was byte-identical to the 2026-11-02 fixture | Read 2026-11-02. Azure's doc: "This API gives you an unauthenticated experience to get retail rates for all Azure services." | **Include**: the two extractors now keep spot beside on-demand |
| Tightness | Nebius, Crusoe, DigitalOcean, Verda pricing pages, already read | Nebius prints "from $0.79", a floor and no current price. The stored Crusoe page prints no H100 spot price. DigitalOcean prints spot for B300 and AMD cards only | — | **Not read for spot** |
| Tightness | Ornn Compute Price Index, `data.ornn.com` | H100 SXM "$2.93 per H100 hour", settled 2026-11-18, from executed trades. The latest value and three months of history need no key | Terms of Use (May 29, 2026) bar anyone to "create, calculate, validate, benchmark, publish, distribute, or make available any index, benchmark, reference rate, price assessment, valuation, dataset, derived data product, database, analytics product, model, report, or other derivative work using Company Data without the Company's prior express written consent" | **Cut** (`ornn-compute-index`). No permission asked: the owner doesn't want to depend on a possible competitor |
| Tightness | AWS EC2 Capacity Blocks, `aws.amazon.com/ec2/capacityblocks/pricing/` | 200, server-rendered table. p5.48xlarge $47.757 an hour ($5.970 per H100) in every region. "Reservation prices are updated regularly based on trends in supply and demand for EC2 Capacity Blocks. The current prices are scheduled to be updated next in January, 2027." | robots.txt allows it. AWS Site Terms (June 4, 2025) exclude "any derivative use of the AWS Site or its contents" and "any use of data mining, robots, or similar data gathering and extraction tools" | **Cut** (`aws-capacity-blocks`): would be `restricted`, and the owner left it out |
| Tightness | AWS spot price history; Azure spot history and eviction rates | AWS: "You can view the Spot price history for the last 90 days". Azure: "Get pricing history in the last 90 days and eviction rates for the last 28 trailing days" | Both need a signed-in account. The account agreements weren't read | **Cut** (`gpu-spot-history`) until the owner opens an account |
| Tightness | Vast.ai | Not fetched | Terms bar use "to construct, publish, or maintain any index, benchmark, pricing-comparison service, market-data product, or similar product or service" | **Cut** stands (`gpu-aggregators`) |
| Token share | Vercel AI Gateway leaderboards, `vercel.com/api/ai/leaderboard-export` | Documented, CC BY 4.0. "it shows each model, lab, app, or provider's percentage share or rank, never absolute volumes" | robots.txt: `Disallow: /api/` | **Cut** (`vercel-ai-gateway`): shares only, and robots.txt closes the path |
| Stock status | Lambda, RunPod | Not fetched. `lambda.ai` now redirects to `lambda.com` | RunPod's terms bar automated access (2026-11-02). Lambda's weren't read at the new host | **Cut** (`gpu-stock-status`) |

**Findings.**

- **One lab states a volume.** Alphabet is the only tracked lab with a current token figure in a primary source. OpenAI's last figure is from October 2025 and its site can't be fetched headless. Anthropic, Meta and xAI state none. So the implied read covers Google.
- **Benchmark throughput spans 150x.** Per H100-equivalent, the Server results run from 49 tokens a second (Llama 3.1 405B on a B200, result 6.0-0040) to 7,326 (Llama 3.1 8B on a B300, result 6.0-0006). Model size drives nearly all of it.
- **The implied read stays wide.** 32 billion tokens a minute is 533 million a second. Against Epoch's range for Google's fleet that is 1.6% to 3.6% at 8B speed, and 115% to 419% at 405B speed. A row above 100% says Google's average token isn't a 405B-class model. It doesn't say what it is.
- **Spot is thin.** Two providers print a current spot price for an H100 on pages we may read. Azure's has not moved off its floor, so the read is close to one provider's price. The site shows each provider on its own and prints no combined figure until four do.
- **CoreWeave's revenue per megawatt is two filed numbers.** Q3 2026 revenue of $3,661M over an average of 1.6 GW is about $2.3M per megawatt for the quarter.

Interpretation, marked as such: none of this measures utilization. The implied read assumes one model served every token, counts input tokens at output speed, compares TPUs with other vendors' accelerators, and sets a token figure from October 2026 against a fleet estimate for December 2025. CoreWeave's floor mixes contract discount with idle capacity. Each is shown as bounds with those limits beside it. Narrowing them needs the labs' model mix and real serving speed, which only paid probes or a disclosure would give.

**One change to the recipe contract.** `follow` now gets the newest stored date. The two earnings-release recipes read one release per run, oldest first, then the one after the newest stored quarter. That fills five quarters of Alphabet's figure and seven of CoreWeave's over the first runs.

**Verdict: include `sec-googl-api-tokens`, `sec-crwv-active-power`, `mlperf-inference-datacenter`, `epoch-chip-users` and `epoch-chip-types`, and keep spot prices on `gpu-coreweave` and `gpu-azure`. Cut `ornn-compute-index`, `aws-capacity-blocks`, `gpu-spot-history`, `vercel-ai-gateway`, `inferencex` and `gpu-stock-status`.** The owner approved the plan on 2026-11-20.

## Addendum, 2026-11-19: capex guidance in earnings releases

Checked for the guidance check on `/ground-truth`: does a filer's earnings release print what it expects to spend on capex in a fiscal year? Fetched from `www.sec.gov` on 2026-11-19 with a declared User-Agent naming a contact: for each of the five `filed_fact_sources` filers, every 8-K with item 2.02 filed since 2024-01-01 in its submissions feed, the filing's index page (`{accession}-index.html`), and the document the index lists as `EX-99.1`. 57 releases in all.

| Filer | Releases read | Print a capex figure for a year | What the release says |
|---|---|---|---|
| Meta | 10 | 10 | A range every quarter: "We anticipate our full year 2025 capital expenditures will be in the range of $60-65 billion." The figure includes principal payments on finance leases. |
| Alphabet | 12 | 3 | A figure or range in a remark, some quarters only: $75 billion (2025-02-04), $91 billion to $93 billion (2025-10-29), $175 to $185 billion (2026-02-04). The other nine report capex and guide none. |
| Amazon | 12 | 2 | "about $200 billion in capital expenditures across Amazon in 2026" (2026-02-05) and "2026 cash capital expenditures to be approximately $220 billion" (2026-10-29). |
| Oracle | 11 | 1 | "For fiscal year 2026, we expect revenue of $67 billion and capital expenditures of $50 billion." (2026-03-10) |
| Microsoft | 12 | 0 | No figure. Each release says forward-looking guidance is given on the earnings conference call. |

**The rule.** A sentence is read when it names capital expenditures (or capex), says expect or anticipate, names a year, and states an amount in billions of dollars. The amount is the first one after those words, or the last one before them when none follows. Run over all 57 releases it returns the 16 figures above and nothing else (`layers/terminal/server/exposure/guidance.ts`). Twelve trimmed releases and one index page are fixtures under `fixtures/guidance/`.

**What each figure is compared with.** The filer's own cash-flow line for the fiscal year, at the 10-K that first filed it. Meta's guided figure includes principal payments on finance leases, so its year is `PaymentsToAcquirePropertyPlantAndEquipment` plus `FinanceLeasePrincipalPayments`: $69,691M + $2,524M = $72,215M for 2025, which is the "$72.22 billion" its January 2026 release prints. On `/exposure` the two lines stay apart. Alphabet's and Oracle's figures are the purchases line alone ($91,447M for 2025, $55,663M for fiscal 2026).

**Amazon, listed and not scored.** Amazon guides cash capital expenditures, which its releases define as purchases of property and equipment net of proceeds from sales and incentives. Its 10-K for 2025 gives $128.3 billion on that basis. Company facts carry the gross purchases line only (the proceeds line is a custom tag), so no filed figure we hold answers the guidance.

**Microsoft, a gap here.** Its release prints no capex figure; the call reader below reads its call.

**Terms.** EDGAR's are the SEC's: fair-access rate and a declared contact. A release is the filer's own text, not a government work. We keep the guided figure, the year, and the one sentence that states it, with a link to the exhibit. The saved release is stored under `guidance/` and is in no export.

**Verdict.** Include, for Meta, Alphabet and Oracle. Amazon's figures are shown with the reason they aren't scored.

## Addendum, 2026-11-20: who powers the lab sites

Checked to see which public companies the labs' sites point to. Epoch AI's site list (already read, CC BY 4.0) says who uses each data center and has an energy-company column that is blank for most sites. This pass fills it for the sites Epoch credits to a lab at #confident or #likely, by hand: one sentence per company, from one page, kept in `layers/compute/server/curated/power-sites.json`. Since 2026-11-20 those rows seed `power_site_ties` in D1: new SEC filings naming a site are found by EDGAR full-text search on the filings lane and read by the judge (`layers/compute/server/power/`), and the weekly `power:verify` task re-reads each cited page off EDGAR and flags a sentence that is gone.

**The rule.** A row needs a filing, a regulator's page or the company's own page that ties the company to the site or to the site's customer. Press coverage doesn't count. Research on 2026-11-19 found 80 candidate rows on 19 sites. 31 rows on 13 sites are kept, each found again on its page by a scripted fetch on 2026-11-20 (01:14Z).

| Publisher | Rows | robots.txt | Terms (read 2026-11-20) | Rights |
|---|---|---|---|---|
| SEC EDGAR: filings by TeraWulf, Cipher Digital, WEC Energy Group, DTE Energy, SB Energy and Blue Owl Real Estate Net Lease Trust | 15, and the grid operator for 3 sites | Allows `/Archives/edgar/data` (read 2026-11-19) | SEC fair access | `ours` |
| American Electric Power, `aep.com` | 1 | None (404) | Legal Notice, undated: "If attribution to AEP is included, limited quotations from the content are hereby permitted." | `ours` |
| Lancium, `lancium.com` | 1 | Allows the path | Terms of Service (April 18, 2022) cover purchased services only | `ours` |
| Bloom Energy, `bloomenergy.com` | 1 | Allows the path, crawl delay 10 seconds | States ownership, no restriction | `ours` |
| GE Vernova, `gevernova.com` | 1 | Allows `/news/` | July 16, 2024. Nothing on automated reading. Any use beyond personal copying "is expressly prohibited" | `restricted` |
| Crusoe, `crusoe.ai` | 2 | Allows everything | August 12th 2024. Nothing on automated reading. No copying or publishing "without our prior written permission" | `restricted` |
| Vantage Data Centers, `vantage-dc.com` | 2 | Allows the path | April 24, 2020. No use of the materials "for any purpose without the prior consent of Vantage" | `restricted` |
| American Transmission Company, `atcllc.com` | 1 | No rules | None found | `restricted` |
| Microsoft, `blogs.microsoft.com` | 1 | Allows the path | Services Agreement (September 30, 2026) bars "impermissible scraping" | `restricted` |
| Arizona Public Service, `aps.com` | 1 | Allows the path | August 13, 2019. No copying "by incorporating it in another site" without written permission | `restricted` |
| Core Scientific, `investors.corescientific.com` | 2 | Allows the path | The parent site's terms bar copying or republishing any material | `restricted` |
| Ohio Power Siting Board, on `content.govdelivery.com` | 1 | None (404) | None found for the host | `restricted` |
| Williams, `williams.com` | 1 | Disallows nothing | None found | `restricted` |
| Louisiana Economic Development, `opportunitylouisiana.gov` | 1 | Allows everything | Privacy notice only | `restricted` |

The exact sentences from each set of terms are in `sources.yaml` under `power_site_sources`.

**Left out, and why.**

- **Press coverage.** Six researched sites end with no row and show as not read yet. Press is the only source we found for Microsoft's Fairwater site near Atlanta and OpenAI's Shackelford and Lordstown sites. Both Colossus sites in Memphis have press and PDFs, and the QTS site xAI uses in Atlanta is under the terms below.
- **PDFs.** Memphis Light, Gas and Water's xAI updates, Mississippi's order on the Southaven turbines and the Indiana commission's order on Indiana Michigan Power's contract with Amazon (2,250 MW) are primary. The check can't search a PDF, so a row from one couldn't be kept honest.
- **Hosts that refuse an identified client.** `oracle.com` and `michigan.gov` answered 403. That drops Oracle's pages on Abilene and Project Jupiter and the Michigan commission's release on DTE's contracts (1,383 MW). DTE's own filing (1.4 gigawatts) and Bloom's own page are kept.
- **Terms that name this use.** QTS's terms say: "You may not use this Site or any QTS Service (as defined below) in connection with the training, development, or operation of any machine learning or artificial intelligence model or tool unless we provide express prior written consent." Entergy's bar anyone who "uses any robot, spider, scraper or other automatic or manual means to access the Sites" and any direct link to a page other than its homepage. Both rows are dropped. Meta's Hyperion site keeps Entergy Louisiana through the state's own release.
- **One contractor's page.** Mortenson says it built interconnection work "for AEP" at Abilene. That is the contractor's account of its own job, so American Electric Power isn't listed for that site.
- **Solaris Energy Infrastructure.** Its filings name MZX Tech as the lessee of its Stateline generation and never name xAI or the site. The page tying MZX to Colossus 2 is press, so the row is out.

**Limits.**

- **Tickers and parents are ours.** Each row's company is matched to its listed parent by us (Indiana Michigan Power to AEP, We Energies to WEC). The cited page states the match for AEP, and for the companies whose own filing is the source. The rest weren't checked against SEC's ticker file in this pass.
- **A row doesn't size anything.** It ties a company to a site. Megawatts appear only where the page states them, with what they measure, and no figure is summed per company.
- **The table goes stale by hand.** Nothing reruns the check on a schedule, and it isn't part of `bun run ci` because it reads the network.
- **No bytes are saved.** The cited pages aren't stored in R2, which every polled source's are.

Interpretation, marked as such: the `restricted` rows rest on the same position as the 2026-11-11 addendum. A public page, a fact the publisher states about itself, and one attributed sentence shown as its basis. Six of those publishers' terms bar copying or publishing site content in general. None has given permission and none has objected, and no lawyer has reviewed it.

**Verdict: include the fourteen publishers under `power_site_sources`. Cut press reports (`power-site-press`) and the pages we can't re-read or whose terms name this use (`power-site-unread`).** The owner asked for the primary-source cut to ship on 2026-11-19.

## Addendum, 2026-11-20: AWS and Google Cloud spot prices

Checked because two providers print an H100 spot price we read, and the Compute page shows no combined spot figure until four do. Both vendors were cut for on-demand prices on 2026-11-02, and their spot history was cut on 2026-11-19 because it needs an account. This pass asks one thing those didn't: does either publish a current spot price that needs no account? Fetched 2026-11-20 23:00Z to 23:10Z with a generic client, not the pipeline's User-Agent, so whether either host refuses an identified client is unchecked. The terms pages and robots.txt files were read in the same session. Nothing is stored and no fixture is committed.

| Candidate | Source | Result | Terms (read the same day) | Verdict |
|---|---|---|---|---|
| AWS current spot price | `spot-price.s3.amazonaws.com/spot.js`, the file behind `aws.amazon.com/ec2/spot/pricing/` | 200, 7,625,200 bytes, JSONP. `Last-Modified: Mon, 13 May 2024 17:03:35 GMT`. p5.48xlarge (8× H100) at $57.7618 an hour in us-east-1. No P5en or P6-B200 row. The pricing page's own HTML (335,761 bytes) prints no price | The bucket's robots.txt answers 403. AWS Site Terms ("Last Updated: June 2, 2025") exclude "any derivative use of the AWS Site or its contents" and "any use of data mining, robots, or similar data gathering and extraction tools" | **Cut** (`gpu-aws-spot`): an undocumented page backend, and 30 months old |
| AWS Spot Instance Advisor | `spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json` | 200, 1,190,579 bytes, JSON. `Last-Modified: Fri, 20 Mar 2026 23:38:55 GMT`. Per region and instance: the saving over on-demand as a whole percent, and an interruption band (under 5%, 5-10%, 10-15%, 15-20%, over 20%). p5.48xlarge in 12 regions (us-east-1: 57%, under 5%). p6-b200.48xlarge in 3 (us-east-1: 79%, 10-15%) | Same terms | **Cut** (`gpu-aws-spot`): an undocumented page backend, eight months old, and a rounded saving with no price |
| AWS documented route | `DescribeSpotPriceHistory` | Not fetched. Needs credentials | — | **Cut** stands (`gpu-spot-history`) |
| Google Cloud Spot VM page | `cloud.google.com/spot-vms/pricing` | 200, 18,772,351 bytes, server-rendered. One price column, "Current Spot pricing (USD)", for Iowa (us-central1): a3-highgpu-8g $52.700460712 an hour, a4-highgpu-8g $43.5968. No on-demand price. "Spot prices are variable and can change up to once every day" | As the row below | **Not needed**: the page below prints the same spot prices beside on-demand at a third of the size |
| Google Cloud accelerator pricing | `cloud.google.com/products/compute/pricing/accelerator-optimized` | 200, 5,796,380 bytes, server-rendered. One table, Iowa (us-central1), with "Price (USD)" and "Current Spot pricing (USD)" columns. a3-highgpu-8g (8× H100): $88.490000119 and $52.700460712 an hour. a3-megagpu-8g (8× H100): $93.400712807 and $47.741932712. a4-highgpu-8g (8× B200): "N/A" and $43.5968 | The page's footer links Google's Terms of Service (effective July 30, 2026), which bar "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling, training, or other activities)". `cloud.google.com/robots.txt` has no rule on `/products/` or `/spot-vms/` | **Passes. Not built** (`gpu-google-cloud` stays cut until the owner decides) |
| Google Cloud documented route | Cloud Billing Catalog API | 403 `PERMISSION_DENIED` without a key | — | **Cut** stands: a key needs an account |

**Findings.**

- **AWS publishes no current spot price outside an account.** The file its pricing page once read stopped updating in May 2024. The advisor file gives a rounded saving and a band, last written in March 2026. Neither is documented, and the 2026-11-02 audit already rules out page backends. The Site Terms that kept Capacity Blocks out cover these pages too.
- **Google Cloud's page has changed since 2026-11-02.** That audit followed `compute/gpus-pricing`, which still redirects to a 2.1 MB page with no prices. The accelerator page sits one level under it and is server-rendered.
- **It would be a third H100 spot provider, and the first that moves.** $88.49 an hour for eight H100s is $11.06 per GPU-hour on-demand. Spot is 59.6% of on-demand on a3-highgpu-8g and 51.1% on a3-megagpu-8g. Google says the spot price can change daily. Azure's has sat at 18.48% since the first read.
- **No B200 share.** Google prints no on-demand price for the a4-highgpu-8g, so its B200 spot price ($5.45 per GPU-hour) has nothing to divide by.
- **A tenth provider moves the H100 median.** Nine providers put the median on one provider's price. Ten put it between the fifth and sixth. Google at $11.06 sits with Azure and Oracle above the neoclouds, so the median would rise on the day it's added with no price changing.
- **The page is large.** 5.8 MB is under the 32 MB limit. The rendered table covers Iowa only. Other regions are in the page's embedded data and weren't parsed.

Interpretation, marked as such: Google's page meets the tests the nine included providers met. It is first-party, server-rendered, open under robots.txt, and under the same Google terms as the Google sources already rated `ours`. Whether to read it is a product decision, since it changes a headline number.

**Verdict: cut `gpu-aws-spot`. `gpu-google-cloud` stays cut with a new reason: the page passes, and no recipe reads it until the owner decides.**

**Built the same day.** The owner chose to count Google Cloud in both the spot read and the H100 median, with a note on the day it joins. `gpu-google-cloud` is now an include under `recipe_sources`. A second fetch at 23:15Z with the pipeline's User-Agent answered 200 (5,846,865 bytes), and its trimmed body is the fixture. The page's bytes differ on every fetch, so the recipe judges a change on the rows it reads. On the prices of 2026-11-20 the H100 median moves from $4.74 to about $5.12 on Google's first read. `/compute`, `/api/gpu-prices` and the Compute thesis's reading each name the day a provider joins or leaves the median (`docs/theses/compute.md` › Revisions).

## Addendum, 2026-11-20: a fourth spot provider

Checked because Google Cloud makes three H100 spot providers and the combined figure needs four. A first pass over about 30 providers, fetched 2026-11-20 23:14Z to 23:26Z with a generic client. Nothing is stored and nothing is decided. Only the Nebius and Verda rows were fetched twice and read by hand. The rest are one fetch each, and most of their terms weren't read.

| Candidate | Source | Result | Terms | Verdict |
|---|---|---|---|---|
| Nebius spot prices | `api.nebius.cloud/billing/v1alpha1/spot-price`, documented at `docs.nebius.com/signup-billing/spot-prices` | 200, 3,530 bytes, JSON, 13 items. "Preemptible NVIDIA® H100 NVLink" in eu-north1 at 1 USD per "GPU hour", effective 2026-11-20T17:31:00Z. Items in the same answer took effect between 17:31Z and 22:26Z that day. No on-demand price in the answer | Docs: "Spot prices of preemptible GPU platforms and their history are public." and "The request doesn’t require authentication." The host has no robots.txt (404) | **Passes, with a method change.** The spot price and the on-demand price ($4.50 on `nebius.com/prices`, already read as `gpu-nebius`) are two documents, and the share is defined on one page |
| Verda spot column | `verda.com/pricing`, already read as `gpu-verda` | 200, 492,005 bytes. A spot price beside each instance: 1x H100 SXM5 $5.508 and $2.754, 1x B200 SXM6 $9.747 and $4.874 | Read 2026-11-02 | **Passes, and says little.** Spot is half of on-demand on every H100 and B200 row, so the share would be a flat 50% |
| Hyperstack | `hyperstack.cloud/gpu-pricing` | One fetch. H100 SXM $3.20 and B200 $6.00 on demand. Spot only for an H100 PCIe at $2.00, and its spot page says "Spot VM pricing offers fixed percentage discounts over on-demand pricing." | Terms not read by hand | **Not a spot source**: a fixed discount, on a card the median doesn't count. An on-demand candidate |
| Crusoe, DigitalOcean, Oracle | Pages and API already read | Crusoe's page has dropped its spot column. DigitalOcean prints spot for B300 and AMD cards only. Oracle's price list has no preemptible part, and its docs say "Preemptible capacity costs 50% less than on-demand capacity in all regions." | — | **No H100 or B200 spot price** |
| OVHcloud, Civo, Massed Compute, Denvr | Their pricing pages | One fetch each. H100 on demand at $2.99, $2.99, $3.14 and $3.00. No spot price | Terms not read | **On-demand candidates only** |
| Lightning AI, SF Compute | Their sites | Lightning resells other clouds. SF Compute runs an order book with resale | — | **Not first-party** |

**Findings.**

- **Nebius is the only new price that moves.** Its docs publish the API for anyone, and the prices in one answer changed hours apart. On 2026-11-20 its H100 spot price was 22% of its on-demand price.
- **Reading it changes the method.** `/compute` says the share is a spot price over the on-demand price "for the same instance on the same page". Nebius would be one provider read from two of its own documents, with a spot price for one region against a list price that names none.
- **A fourth provider turns the combined figure on.** With CoreWeave, Azure, Google Cloud and one more, `/compute` prints a median share and claim 7 of the Compute thesis starts to count. Azure hasn't moved and Verda's wouldn't, so which provider is fourth decides how much of that median is a market.

**Verdict: none yet.** Whether to read Nebius's API across two documents, and whether a fixed discount counts as a spot price, are the owner's calls.

## Addendum, 2026-11-20: GitHub agent pull requests before the first live day

The three `github-prs-*` recipes counted only yesterday, so each series started on the recipe's first run. GitHub's search API answers `created:<day>` for any past day, so the history is still there to ask for.

**A past day is a retrospective count, not a snapshot.** `docs/thesis-engine.md` says a dataset "cannot be backfilled". That is about pages: a pricing page as it stood last March can't be fetched again. A search for a past day is a count taken today of the pull requests that still exist. A PR deleted since, or in a repository made private since, is missing. A PR in a repository made public since is counted. So a backfilled day is a different measurement from a live one, and it is labelled as one.

**How it runs.** The Worker walks back on its own, with no owner step. Each survey tick (every six hours) counts yesterday, then the six days before the oldest stored day, oldest last, through the Worker's `NUXT_GITHUB_TOKEN`. Three agents at seven searches each is 21 a tick, inside the authenticated search limit of 30 a minute. The walk stops at the agent's public launch, read 2026-11-20:

| Recipe | Floor | Launch |
|---|---|---|
| `github-prs-claude-code` | 2025-02-24 | Claude Code's research preview, released with Claude 3.7 Sonnet (anthropic.com/news/claude-3-7-sonnet) |
| `github-prs-codex` | 2025-05-16 | Codex in ChatGPT (openai.com/index/introducing-codex). Before it, a `codex/` branch is someone else's |
| `github-prs-jules` | 2025-05-20 | Jules's public beta (blog.google/technology/google-labs/jules). Google showed it to testers from December 2024 |

At 24 days a day, Claude Code's 20 months fill in under four weeks, Codex's and Jules's in about three.

**Rules the runner keeps** (`layers/terminal/server/theses/recipes/run.ts`, the recipe contract's `backfill`):

- Every backfilled row carries `retrospective: true` in its payload, and the export carries the payload. Its `first_seen_at` and `fetched_at` are the day it was counted, so a point-in-time read never sees it earlier.
- The walk runs only after the recipe's own run read its source, and it stops at the first failed day. The next tick asks for that day again, so the series has no hole.
- A failed day raises `recipe_failed`, except a 429, which the next tick retries.
- No thesis claim and no alert rule reads these recipes, so a past day can't become a change or an alert.

**Verdict: include**, as retrospective counts, with the caveat on each entry in `sources.yaml` and on the adoption panel. Rights stay `not-cleared`.

## Addendum, 2026-11-20: GDELT GKG before 2026-09-01

Checked because a buyer asked for press scored against filings, and Anthropic's S-1 (first filed 2026-10-26) prints revenue for 2023, 2024, 2025 and the first nine months of 2026, so press from well before `GKG_FROM` could be scored. GDELT publishes a GKG file for every quarter hour back to 2015, under the terms already read (`gdelt-gkg`). Measured 2026-11-20 between 23:15Z and 00:30Z with a generic client: HEAD requests, 21 files parsed with the pipeline's own `parseGkgRow` and `figureHeadline`, and a pilot read of six whole days. Production's counts come from its public export and its GitHub Actions logs. Nothing was stored.

| Measure | Result |
|---|---|
| File size | HEAD on all 96 files of four days: 7.5 MB a file on average on 2024-03-12 (718 MB that day), 6.7 MB on 2025-03-12 (643 MB), 6.1 MB on 2025-09-17 (585 MB), 5.1 MB on 2026-11-10 (490 MB). A file runs 1.8 MB at 03:15Z to 9.5 MB at 17:00Z, and unzips to about three times that. None of the 384 was missing. The registry's "~2.5 MB" was wrong and is corrected |
| Bytes | From 2025-01-01: 608 days, 58,368 files, about 360 GB. From 2024-01-01: 974 days, 93,504 files, about 610 GB |
| Job throughput | The backlog runs of 2026-11-07 read 3,120 files in 40 minutes for mentions (78 a minute) and 3,975 in 36 minutes for figures alone (110 a minute), one file at a time, about 6.5 MB/s. The scheduler started about five such runs a day, so about 3.3 hours of reading a day |
| Runtime at that rate | From 2025-01-01: 9 to 15 hours of reading, 3 to 5 days. From 2024-01-01: 14 to 26 hours, 5 to 8 days |
| Runtime, four at once | The pilot fetched 576 files (3.23 GB) in 95 seconds from the Mac mini with four downloads at a time, 34 MB/s. At that rate 360 GB is about 3 hours |
| Rows kept by the vocabulary filter | 56 a file on 2026-11-07 (98,639 over 1,773 files), 98 on 2026-11-20 (2,358 over 24). These are pruned after `MENTION_RETAIN_DAYS` (15), and no alert's window starts before 2026-09-01, so an old file's mentions would be deleted as they were written. They add nothing to D1 |
| Figure rows | Production since 2026-09-01: 1,917 figure articles (975 headlines) over about 7,800 files, 0.25 a file and about 500 bytes each. Nine files sampled from 2024-03 to 2026-03 had none. The six pilot days, each a known Anthropic round or revenue report (2025-03-03/04, 05-30/31, 09-02/03), had 121 rows and 89 headlines, 0.21 a file |
| D1 growth | Figure rows: a few thousand at most from 2025-01-01, under 5 MB. A `gdelt_files` row per file adds about 15 MB (2025) or 23 MB (2024). Either way under 30 MB |
| Judge | Reads 60 figure headlines an hour, 1,440 a day, so a few thousand old headlines take a day or two. But `figureReview` offers the oldest first, so until they are read no new headline would be |
| Sampled files instead of all | Simulated on production's headlines since 2026-09-01: reading every second quarter hour keeps 54% of figure headlines and 79% of distinct claims (lab, metric, amount); every fourth keeps 29% and 57%. Most headlines appear in only one or two files, so sampling loses them |

**What the pilot found.** GDELT carried each event: the Series E at $61.5 billion (27 Anthropic headlines over two days), Reuters' "Anthropic hits $3 billion in annualized revenue" (4 headlines, 7 copies), and the Series F at $183 billion with its "$5B run-rate" (36). It also carried deals with other companies: OpenAI's Statsig purchase, Telegram's $300 million with xAI, SoftBank's Stargate loan.

**What the ground truth would do with them.** Nothing bounds a report by date. `scoreReport` scores a USD `reported` revenue headline against any filed period that had ended when it ran and was first filed after it, and marks it `held_before_filing: false`, so the page counts it as the press's and not ours. Deal sizes are scored the same way against the counterparty's filings (Amazon, Alphabet, Microsoft and the rest, which the terminal holds from 2020). Two limits:

- **Only period revenue is scored.** Every Anthropic revenue headline in the pilot was a run rate, which `revenue_run_rate` keeps and the page lists under "waiting", never scored against a filed period. Headlines that state a finished year's revenue were not seen in the pilot. How many exist is the open number.
- **Valuations and rounds aren't filed.** They extend the "Reported in the press" series back, which has its own value, but nothing scores them.

No live alert is touched: alerts start at `TRACK_RECORD_FROM` (2026-09-08), the matcher reads only mentions inside an alert's window, and mentions from an old file are pruned on write.

**Verdict: not built.** The full read is 360 GB from 2025-01-01 and 610 GB from 2024-01-01, ten times what a backfill on the owner's home connection should take, for a scored yield the pilot can't yet put a number on. Two ways that fit:

1. **Figures only, from 2025-01-01, on a hosted runner.** GitHub's runners carry the bytes for nothing on a public repository, so the 360 GB never touches the mini's line. Read four files at a time (about 3 hours of downloads, a few runs), post only figure headlines, keep no mentions, and record the old files apart from `gdelt_files`' contiguous run so `GKG_FROM`, `oldestUnread` and the coverage count stay as they are. Before it runs, `figureReview` must offer new headlines ahead of the backlog. 2024 can follow if 2025 yields scored reports.
2. **One month first.** The same build pointed at one month of 2025 (about 2,900 files, 18 GB), to count how many headlines state a finished period's revenue, before committing to the rest.

Also possible, not checked: GDELT's public BigQuery table (`gdelt-bq.gdeltv2.gkg_partitioned`) would return only the matching rows from one query, inside BigQuery's free monthly scan if the title column is small enough. It needs a Google Cloud account, and the scan size wasn't measured.

**Built the same day, as event windows on the Mac mini.** The owner chose to read only the days that matter, back as far as the events go, from the mini. 2023 was sized too: all 96 files of 2023-06-14 came to 785 MB (8.2 MB a file), and two 2023 files parsed with the same columns and page titles as 2026's. `ARCHIVE_FROM` is 2023-01-01, which takes in Microsoft's January 2023 investment in OpenAI, Amazon's and Google's 2023 stakes in Anthropic, and the press on Anthropic's 2023 revenue, the first year its S-1 prints. A list of event dates was considered and not used, because it would miss what nobody wrote down. The Worker finds the days from the files themselves instead (`layers/terminal/server/pipeline/reported/archive.ts`):

- **Scout.** The first file of every hour of every day from 2023-01-01 to 2026-08-31: 32,136 files, about 230 GB.
- **Fill.** Every other quarter hour of each day whose scout files carried two distinct figure headlines or one stating revenue, and of the day either side. Coverage that runs for a week is filled day by day. A day is judged on its scout files alone, so the fill can't widen itself. Each hot day costs at most three days of files, about 1.5 GB. How many days qualify is known only once the scout is done.
- **Figures only.** The job posts only figure headlines (`/api/gdelt/archive`), recorded in `gdelt_archive_files` apart from `gdelt_files`, so `GKG_FROM`, the live cursor and freshness are unchanged. No mention is kept from an archive file, so no alert is matched against one.
- **Live first.** `/api/gdelt/work` hands out archive files only when no live file and no figure backlog is waiting. The job downloads four archive files at a time and posts them in order. The judge's queue offers headlines from 2026-09-01 on before any archive headline.

## Addendum, 2026-11-20: Internet Archive (GPU rental prices)

Checked for the GPU price backfill (`scripts/wayback-backfill.ts --axis gpu`; eras in `layers/compute/server/pipeline/archive/gpu-eras.ts`, parsers for the layouts the live recipes don't read in `layers/compute/server/pipeline/parsers/gpu/wayback-gpu.ts`). The live `gpu-*` recipes start 2026-11-01 (Google Cloud 2026-11-20). Same client, pace, User-Agent and terms as the price backfill above: one request at a time, 4 seconds apart, the same back-off. The User-Agent now says "history backfill" rather than naming the price and hiring backfills, so the next axis can reuse it. Every CDX listing and capture below was fetched on 2026-11-20 and 21. Rights: `not-cleared` (`sources.yaml › archive_sources › wayback-gpu`). Rows are CC BY-NC 4.0 under any key (`ARCHIVED_EXPORTS`).

**URLs checked** (CDX, plain URL queries, 2023-01 → 2026-11-08). Lambda: `lambda.ai/pricing`, `lambdalabs.com/service/gpu-cloud`, `…/gpu-cloud/pricing`, `lambdalabs.com/pricing` (none), `lambda.ai/service/gpu-cloud`. CoreWeave: `coreweave.com/pricing`, `coreweave.com/gpu-cloud-pricing`, `coreweave.com/pricing/classic`. Nebius: `nebius.com/prices`, `nebius.ai/prices`, `nebius.com/prices-ai-studio` (inference prices, not read). Crusoe: `crusoe.ai/cloud/pricing` (with and without `www.`), `crusoe.ai/pricing` (none). Together AI: `together.ai/pricing`, `together.ai/gpu-clusters`. DigitalOcean: `digitalocean.com/pricing/gpu-droplets`, `paperspace.com/pricing` (Paperspace's own product, not read). Verda: `verda.com/pricing`, `datacrunch.io/products`, `datacrunch.io/pricing` (none), `datacrunch.io/`. Oracle: the Price List API URL the live recipe reads (4 copies). Azure: the filtered Retail Prices query the live recipe sends (none). Google Cloud: the accelerator-optimized pricing page (15 copies from 2026-03-19). One copy every ~60 days of each was read by hand first, to find the layouts.

**Layouts and the counting rule.** Each era is one page in one layout, read like the live recipe: the on-demand price per GPU-hour, an instance price divided by the GPU count the page prints, PCIe and NVL cards kept but not counted. Reserved, commitment, spot-only and inference-endpoint prices are other products. Lambda's late-2023 table printed a "2023 Price" and a "2024 Price (effective 1/1/2024)" column; the copy is read as of its own day, so a price not yet in effect is not a price. Together's pricing page until 2026 priced the H100 only as a dedicated inference endpoint, which the live recipe excludes; its GPU-clusters page printed on-demand cluster prices from March 2026, and an inference build of the cluster is left out. Google's page drops its closing tags, so its copies count as whole when they end at `</footer>`.

| Provider | Era (URL) | Window | Shape | Read | Skipped |
|---|---|---|---|---|---|
| Lambda | lambdalabs.com/service/gpu-cloud | 2023-01 → 2025-03-28 | on-demand table per instance, per instance-hour, then per GPU-hour | 45 | 9 (no H100 before May 2023) |
| Lambda | lambda.ai/service/gpu-cloud | 2025-03-28 → 2025-06-04 | the same table | 5 | 0 |
| Lambda | lambda.ai/pricing | 2025-06-04 → 2025-11-15 | a table per GPU-count tab | 12 | 0 |
| Lambda | lambda.ai/pricing | 2025-11-15 → 2026-11-01 | "Instances pricing", read live | 27 | 0 |
| CoreWeave | coreweave.com/pricing | 2025-01 → 2026-04 | Webflow lists, "Instance Price (Per Hour)" | 31 | 0 |
| CoreWeave | coreweave.com/pricing | 2026-04 → 2026-11-01 | on-demand and spot, read live | 18 | 0 |
| Nebius | nebius.ai/prices | 2023-11 → 2024-11 | "GPU type: H100 SXM5. PAYG price – $4.85/h" | 10 | 0 |
| Nebius | nebius.com/prices | 2024-11 → 2025-07 | a VM table with an On demand column, then per GPU | 12 | 0 |
| Nebius | nebius.com/prices | 2025-07 → 2026-04 | "NVIDIA GPU Instances", "Price per GPU-hour" | 8 | 0 |
| Nebius | nebius.com/prices | 2026-04 → 2026-11-01 | "On-demand, GPU-hour", read live | 10 | 1 (a column headed "GPU-hour", one copy) |
| Crusoe | crusoe.ai/cloud/pricing | 2024-05 → 2025-11 | "GPU Pricing" table | 6 | 2 (no H100 in 2024) |
| Crusoe | crusoe.ai/cloud/pricing | 2025-11 → 2026-10-26 | Webflow list, "GPU model, On-demand, Current spot" | 13 | 0 |
| Crusoe | crusoe.ai/cloud/pricing | 2026-10-26 → 2026-11-01 | read live | 1 | 0 |
| Together AI | together.ai/gpu-clusters | 2026-02 → 2026-11-01 | a card per cluster, on-demand per GPU-hour | 25 | 2 (no prices yet) |
| DigitalOcean | digitalocean.com/pricing/gpu-droplets | 2024-10 → 2026-11-01 | a card per GPU, read live | 33 | 2 (unlabelled cards; one replayed from another day) |
| Verda | datacrunch.io/products | 2023-01 → 2025-09 | a table per GPU family, on-demand per instance-hour | 16 | 4 (no H100 before September 2023) |
| Verda | verda.com/pricing | 2026-07 → 2026-11-01 | read live | 10 | 0 |
| Oracle | Price List API | 2026-08 → 2026-11-01 | read live | 4 | 0 |
| Google Cloud | accelerator-optimized pricing | 2026-03 → 2026-11-01 | read live | 4 | 4 (no machine table; two cut short) |

Totals on the local run (one copy per week of each era): 290 copies read (852 rows, 55 keys), 24 skipped. Earliest readable copy per provider: Lambda 2023-05-12, Verda (DataCrunch) 2023-09-23, Nebius 2023-11-01, DigitalOcean 2024-10-20, CoreWeave 2025-01-01, Crusoe 2025-04-03, Together AI 2026-03-08, Oracle 2026-08-12, Google Cloud 2026-09-21. The copies are 42 kB to 6.0 MB, 121 MB in all.

**Findings.** Lambda's 8x H100 SXM went from $2.59 per GPU-hour (2023) to $3.49 (2024), back to $2.99 (late 2024 to 2025) and $3.99 by May 2026. CoreWeave's HGX H100 instance stayed at $49.24 an hour ($6.155 per GPU) on every copy since January 2025. DataCrunch's 1x H100 fell from $3.50 (2023) to $1.77 (August 2025) before Verda's $4.79 at the live start. DigitalOcean's single-H100 card read $6.74 until August 2025, $3.39 from late September (beside an 8-GPU card at $2.99 a GPU-hour until November) and $4.41 from late August 2026. Together's cluster H100 read $2.99 from March 2026, $5.49 from late May (one copy at $4.79 in June) and $3.99 from August.

**Gaps.** Stated in `GPU_ARCHIVE_GAPS`, each with its reason: Lambda before 2023-05-12; CoreWeave before 2025 (it priced each GPU as a component, with vCPUs and RAM on top, which isn't the instance price the live page prints); Nebius before 2023-11-01 and 2024-09-15 → 2024-11-15 (the move to nebius.com); Crusoe before 2025-04-03; Together before 2026-03-08; DigitalOcean before 2024-10-20; Verda before 2023-09-23 and 2025-09 → 2026-07 (no copy of either products page); Oracle before 2026-08-12; Google Cloud before 2026-09-21. Not covered (`GPU_ARCHIVE_NOT_COVERED`): Azure, whose query has no copy. Within an era, the weekly median drops a provider whose newest copy is more than 90 days old, so a stretch with few copies shows as fewer providers, never a carried price.

**Verdict.** Include, as a one-off backfill (never on a cron), `rights: not-cleared`. Archived rows carry `basis: archived` and stay in `archived_gpu_prices`: the median floor, the Compute thesis, the alerts and the judge read `recipe_observations` only. `/compute` and `get_gpu_prices` show them as `archived`, and `/export/archived_gpu_prices` has every row.

## Addendum, 2026-11-20: MLPerf Inference rounds before v6.0

Checked so tokens per second per accelerator has a history across chip generations. Each `mlcommons/inference_results_v*` repository was read through the GitHub API, and each `summary_results.json` was fetched from `raw.githubusercontent.com` on 2026-11-21 00:15Z (2026-11-20 in New York) with a generic client.

| Round | Summary file | Shape against v6.0 | License | Verdict |
|---|---|---|---|---|
| v6.0 | 200, 784,457 bytes, 520 results | The shape the recipe was written for | Apache License 2.0 (`LICENSE.md`) | **Included** since 2026-11-19 |
| v5.1 | 200, 2,221,336 bytes, 1,448 results, every one `"version": "v5.1"` | The same field names and values, except that `Total Accelerators` is missing. It gives `Nodes` and `a#` (accelerators per node). In v6.0, `Total Accelerators` equals `Nodes` × `a#` on all 156 kept results, so the count is that product. Closed, available, Server results in tokens per second: 155, across llama2-70b-99 and -99.9, llama3.1-8b, llama3.1-405b, mixtral-8x7b and deepseek-r1. Six are CPU-only (`a#` empty), leaving 149 | Apache License 2.0. `LICENSE.md` was added on 2026-01-16 (commit f40471c) | **Include** |
| v5.0 | 200, 27,696,289 bytes, 17,454 results | The same as v5.1. 248 kept results, including gptj and llama2-70b-interactive | No license file, and GitHub detects none. The only license files are inside submitters' vendored code (`closed/AMD/setup/vllm/LICENSE` and similar) | **Cut**: no license for the results. Revisit if MLCommons adds one, as it did for v5.1 |
| v4.1, v4.0, v3.1, v3.0 | 404 | No summary file. Results are per-run `mlperf_log_summary.txt` files, one per system, model and scenario. v4.1 has llama2-70b and mixtral among them | Apache License 2.0 | **Not read**: a different shape and hundreds of fetches per round |

Rounds are dated by MLCommons's announcements: v5.1 on 2025-09-09 (`mlcommons.org/2025/09/mlperf-inference-v5-1-results/`) and v6.0 on 2026-04-01 (`mlcommons.org/2026/04/mlperf-inference-v6-0-results/`).

**How they are stored.** One recipe (`mlperf-inference-datacenter`) with a fixed list of rounds. Each row is dated by its round and cites its round's URL and round label. A run reads the oldest listed round newer than the newest stored date, through the `newest` the contract already passes to `url`, so the runner needs no change. Each past round is read once, and the newest round is re-read every survey. Migration 0062 clears the v6.0 rows dated by their fetch day (2026-11-20), so the first two surveys after deploy read v5.1 and then v6.0. For about six hours in between, the implied read on `/compute` shows v5.1, labeled as v5.1.

**Surfaces.** The implied read on `/compute`, `/api/utilization` and the `get_utilization` MCP tool show one benchmark round, the newest stored, and name it in the footnote and citation. The bulk export carries every round's rows, each with its `round`, date and source URL. No thesis or alert reads this recipe, so a past round never appears as a change.

**Verdict: include v5.1. Cut v5.0 until it has a license. Leave v4.1 and earlier unread.**

## Addendum, 2026-11-21: Internet Archive (status-page incidents)

Checked for the incident backfill (`scripts/wayback-backfill.ts --axis status`; eras in `layers/terminal/server/pipeline/archive/status-eras.ts`, readers for the older shapes in `layers/terminal/server/pipeline/parsers/status/wayback-status.ts`). Each live status feed lists only its newest incidents (Statuspage's `history.atom` 25 entries, its `incidents.json` 50), so older history is only in copies. Same client, pace, User-Agent and terms as the price backfill: one request at a time, 4 seconds apart, the same back-off. Every CDX listing and copy below was fetched on 2026-11-21 (UTC). Rights: `not-cleared` (`sources.yaml › archive_sources › wayback-status`). Rows are CC BY-NC 4.0 under any key (`ARCHIVED_EXPORTS`).

**robots.txt, read 2026-11-21.** A copy of a URL the live site's robots.txt disallows is never read. `status.claude.com`: `Disallow: /api/`, `Disallow: /embed/` (`status.anthropic.com` 301s to it), so Anthropic is read from `history.atom` only. `status.x.ai`: `Disallow: /api/`, `/mp/`, `/design`; `feed.xml` is allowed. `status.cloud.google.com`: allows everything. `status.openai.com` and `status.deepseek.com`: no robots.txt (404, or the status app's own page). `status.mistral.ai`: a Cloudflare challenge (403) to a headless client; the Archive's one copy of its robots.txt (2026-04-19) reads `User-agent: *`, `Allow: /`, `Disallow: /api/`. That copy also bears on the live `mistral-status` source, which reads `/api/v2/incidents.json`. It is a live-lane question, not this backfill's, and is noted for its own review.

**URLs checked** (CDX, 2019 → 2026-11-21). OpenAI: `history.atom` (170 copies, 2021-08 → 2026-06), `history.rss` (174), `api/v2/incidents.json` (10, from 2025-04), `feed.rss` (46, 2025-03 → 2026-09), `feed.atom` (35). Anthropic: `status.anthropic.com/history.atom` (34, 2023-10 → 2025-09), `status.claude.com/history.atom` (54, 2025-09 →), `status.anthropic.com/api/v2/incidents.json` (none, and disallowed). Google: `incidents.json` (274, 2019 →). Mistral: `api/v2/incidents.json`, `history.atom`, `history.rss` (none). DeepSeek: `history.rss` (53, 2024-06 → 2026-10), `history.atom` (53, 2024-06 → 2026-05). xAI: `feed.xml` (126, 2025-01 →). Read: one feed per lab per era, below. Not read: OpenAI's `history.rss` and `feed.atom` (the same incidents as the feeds read) and its 10 `incidents.json` copies (impact, but reading two feeds of one incident would mix their fields); DeepSeek's Flashduty-era `history.rss` (one copy, no end printed).

**Is the history already there?** Google Cloud's live `incidents.json` holds 8 incidents from 2026-02-27, so no. Its copies each list about the year before them (a 2023-12 copy lists 360 incidents from 2022-12-07), so one copy a month reaches every month.

**Shapes and how each is read.** Statuspage `history.atom` (OpenAI to 2025-02, Anthropic, DeepSeek to 2026-05) by the live Atom parser, with the zone each page printed: Pacific (PDT/PST) for OpenAI and Anthropic until they set UTC, China (CST, +08:00) for DeepSeek. incident.io `feed.rss` (OpenAI from 2025-02-25): start is the instant the incident's ULID was minted and end the `pubDate` of a resolved item; on the JSON API copy of 2025-04-07 both matched `created_at` (the live start for OpenAI) and `resolved_at` for 8 of 8 incidents. When OpenAI moved, incident.io copied the Statuspage history in at 10:40 UTC on 2025-02-25 under new ids, so ids minted before 10:45 that day are left out (54 of 61 items on the first copy): those incidents are read from the Statuspage copies with their own starts. Google `incidents.json` by the live parser (Gemini and Vertex AI products only). xAI `feed.xml` by the live parser; until mid-2025 an item carried one category and printed its status in the description, which the reader adds as the second category. A copy without its closing `</feed>` or `</rss>` is skipped, since a cut feed would read as fewer incidents.

**One incident per row.** Keyed `<provider>:<feed id>`. Every field comes from the newest copy that lists the incident, with that copy as `source_url`; `first_captured_at` is the oldest. Each copy records `covers_from`, the oldest start it lists: it speaks for incidents that started from then to the moment the Archive took it. A month counts the incidents that started in it, and the read side says how much of the month the copies reach. Uptime and durations aren't computed: they would need every incident.

| Lab | Era (URL) | Window | Read | Skipped |
|---|---|---|---|---|
| OpenAI | status.openai.com/history.atom | 2023-01 → 2025-02-25 | 122 | 0 |
| OpenAI | status.openai.com/feed.rss | 2025-02-25 → 2026-09-09 | 36 | 0 |
| Anthropic | status.anthropic.com/history.atom | 2023-01 → 2025-09-23 | 33 | 0 |
| Anthropic | status.claude.com/history.atom | 2025-09-23 → 2026-09-09 | 37 | 0 |
| Google | status.cloud.google.com/incidents.json (one a month) | 2023-12 → 2026-09-09 | 22 | 3 (two cut short, one replayed from another day) |
| DeepSeek | status.deepseek.com/history.atom | 2023-01 → 2026-07 | 43 | 0 |
| xAI | status.x.ai/feed.xml | 2023-01 → 2026-11-05 | 87 | 0 |

Totals on the local run: 380 copies read, 3 skipped, 52.5 MB. Distinct incidents: OpenAI 862 (starts 2022-09 → 2026-06), Anthropic 790 (2023-03 → 2026-09), xAI 236 (2025-01 → 2026-11), DeepSeek 63 (2024-05 → 2026-05), Google 10 Gemini or Vertex AI (2024-11 → 2026-02). Months the copies reach whole: OpenAI 40 of 42, Anthropic 29 of 42 (13 partial), Google 43 of 44, DeepSeek 23 of 25, xAI 21 of 22.

**Findings.** OpenAI posted 6 to 34 incidents a month in 2023–24 and 14 to 41 from March 2025, on the new page. Anthropic went from under 10 a month in 2023 to 13 to 51 a month from 2025. Google's Gemini and Vertex AI incidents are rare (10 in three years, none before November 2024 under the live filter). xAI's count jumps from August 2026 (26, 42 and 36 a month to October); the page also covers Cursor's products (see `xai-status`), and only incidents filed solely under Cursor's third-party model component are left out, as in the live count.

**Gaps.** Stated in `STATUS_ARCHIVE_GAPS`, each with its reason: OpenAI 2025-02-19 → 02-26 (the move to incident.io) and 2026-06-17 → 09-09 (no copy); Anthropic before 2023-03-16 and 2024-05-04 → 06-21, with shorter stretches between copies listed per lab (`holes` on `/api/incidents`); DeepSeek before 2024-05-10 and from 2026-05-06 (the move to Flashduty); xAI before 2025-01-15; Google 2026-08-12 → 09-09. Mistral is not covered (`STATUS_ARCHIVE_NOT_COVERED`): no copies of any of its feeds.

**Verdict.** Include, as a one-off backfill (never on a cron), `rights: not-cleared`. Archived incidents carry `basis: archived` and stay in `archived_incidents`. The live incident windows, the signal band, the alerts and the judge read `entities` only. `/incidents` charts the months the copies reach whole, `/api/incidents` and `get_incidents` return them as `archived`, and `/export/archived_incidents` has every row.

## Addendum, 2026-11-21: grid load where the lab sites are

Checked to see whether public grid data can show load growing where the labs build. Data buyers asked whether data-center utilization can be backed out of public data. It can't, and nothing here claims to: a balancing authority's demand moves with weather, the economy and every other customer. What the data can show is load on the grids that hold a lab site, and ERCOT's own count of large loads it has let energize.

| Publisher | What | robots.txt | Terms (read 2026-11-21) | Rights |
|---|---|---|---|---|
| U.S. Energy Information Administration, EIA-930 six-month files (`eia.gov/electricity/gridmonitor/sixMonthFiles/`) | Hourly adjusted demand for eight authorities, 2018 on | Allows `/electricity/` | Public domain. EIA asks for "Source: U.S. Energy Information Administration" | `upstream` (public domain) |
| U.S. Energy Information Administration, API v2 (`api.eia.gov/v2/electricity/rto/daily-region-data/`) | Daily demand for the same eight authorities, 2019 on | The API host answers 403; `www.eia.gov` allows `/opendata/`, where EIA documents the API | Same EIA terms. Free key, sent as a header | `upstream` (public domain) |
| U.S. Energy Information Administration, EIA-861 2025 (`f8612025.zip`) | The balancing authority of five utilities tied to a lab site | Same | Same | `upstream` (public domain) |
| ERCOT, Monthly Operational Overview and ERCOT Monthly PDFs | Approved-to-energize and observed large load, the large-load queue | Allows `/committees/`, `/news/`, `/files/docs/` | Raw data "may be used, reproduced, and redistributed in compilations, charts, and analyses"; whole contents unmodified with notices | `ours` |

The exact sentences are in `sources.yaml` under `grid_load_sources`.

**How a site is placed.** A site sits in an authority when a page we already cite names its grid operator (a `grid` row of `power_site_ties`; Crusoe's page naming ERCOT for Abilene was added in this pass), or when a page ties it to a utility and EIA-861 lists that utility's BA Code. Nine of the thirteen sites with a power tie are placed this way, in ERCOT, PJM, MISO, NYISO and Arizona Public Service. Meta Prometheus isn't: its gas plant (Williams, WMB) is behind the meter and "will not be physically connected to the electric power grid", per the Ohio Power Siting Board. OpenAI's New Mexico site (Bloom Energy, BE) and CoreWeave's Denton site have no page naming a grid.

**Left out, and why.**

- **EIA's API v2, at first.** It needs a key only the owner can register. The owner registered one later on 2026-11-21, so the API is now the primary read from 2019 (`eia930-api`): its daily series equals the six-month files' adjusted hours summed by local date for all eight authorities, it is a day fresher, and the key goes in a header, never a URL. The files stay for 2018 and as the fallback.
- **EIA's bulk ZIP (`EBA.zip`, 705 MB).** Too large for a Worker. The six-month files (30 to 47 MB) are read as a stream and only the tracked authorities' lines are kept.
- **The Grid Monitor's own JSON endpoints.** Undocumented, so they can change without notice.
- **ERCOT's queue breakdown.** It's a chart in the overview PDFs, not text. Only sentences are read.
- **Overviews before April 2025.** January to March 2025 don't carry the large-load sentence. They're stored as read with no figure.

**Limits.**

- **ERCOT's observed figure is a sum of peaks.** "This is calculated as the sum of the maximum value for each individual load per month." It isn't the loads' combined draw at one time.
- **A report's month isn't always its own.** The December 2025 overview states January 2026, and the January 2026 overview states January 2026 again with a different figure (3,349 MW, then 4,049 MW). Each report is a vintage. The panel shows a month from the newest report that states it.
- **The PDF reader is ours.** No PDF library is installed, so `layers/core/server/pipeline/pdf-text.ts` reads the text operators of Flate streams through each font's ToUnicode map. Spacing is collapsed, so a quote reads as the PDF's text, not its layout ("non -simultaneous").

**Verdict: include `eia930-api`, `eia930-balance`, `eia861-utility-ba` and `ercot-large-loads` under `grid_load_sources`.** The owner approved the alpha program on 2026-11-20.

## Addendum, 2026-11-21: hardware prints (Taiwan revenue, Korea chip exports)

Taiwan's listed companies must publish the month before's revenue by the 10th (Securities and Exchange Act art. 36(1)(iii)). They land weeks before NVIDIA, Super Micro, Dell, HPE and AMD report the same quarter, so what we keep is each figure as it stood when first printed.

| Source | What we found | Verdict |
| --- | --- | --- |
| TWSE OpenAPI `t187ap05_L` | 200, JSON, every listed company's newest month in NT$ thousand, with the month before and the year before restated. data.gov.tw dataset 18420 under OGDL v1, which allows commercial use and sublicensing and states it is compatible with CC BY 4.0. No robots.txt | **Include** (`twse-monthly-revenue`, upstream), hourly |
| TSMC 6-K revenue reports | Every month since 2015 in EDGAR's recent list, one table in NT$ million, layout unchanged since 2015 except a decrease in parentheses. EDGAR's acceptance time dates each one | **Include** (`tsmc-revenue-6k`, ours), backfilled oldest first |
| Accton's own page | 40 months in one server-rendered table, robots.txt allows it, no terms on reuse | **Include** (`accton-monthly-revenue`, restricted) |
| MOPS history (mopsov.twse.com.tw) | Every company back to 2013 as HTML and UTF-8 CSV, but `User-Agent: * / Disallow: /`, and TWSE's terms bar crawlers and reuse of anything outside the open-data platform | **Cut**: needs TWSE's written consent |
| Company IR pages | Wiwynn's terms forbid reproduction; Delta loads its figures from a disallowed /api/; Quanta, Wistron and Gigabyte block every non-browser request; Hon Hai's PDFs are allowed but need a PDF reader in the Worker | **Cut** for now |
| Census HS 8471.50 | Public domain, but every keyless request now redirects to missing_key.html | **Cut** until a key is set |
| Korea Customs Service releases | 10-day, 20-day and monthly figures, fetchable without a key through KCS's own document viewer. KOGL Type 1 on every release page from 2026-09-29; none before | **Include** (`kcs-chip-exports`, upstream, KOGL Type 1). Earlier releases kept for the signals harness only (`kcs-chip-exports-unmarked`, not-cleared) |

Korea Customs Service, read 2026-11-21. The press board (bbsId 1362) searched on "수출입 현황" lists 471 posts back to August 2016, newest first, 20 a page. Each release page links its attachment to KCS's own viewer: `/streamdocs/v4/documents/view/tnnf/<fileKey>` answers `viewCallback({"url":"<id>"})`, and `/streamdocs/v4/documents/<id>/texts` returns the attachment as plain text, HWP, HWPX and PDF alike, so nothing in the Worker parses those formats. Where a PDF draws its digits as shapes (June 2021's confirmed release), the HWP's text is read instead. The 1–10 and 1–20 day releases list the semiconductor (반도체) export figure in an annex table in US$ million from August 2021 on. Before that they state only its change. The confirmed month (about the 15th) gives it in a table by commodity in US$ million, beside a sentence in 억 달러 (US$ 100 million) that the parser checks it against. The table's columns have moved (the month before or after the same month a year earlier, or four months across in early 2017), so the parser takes the pair whose change is the stated one. The provisional month (the 1st) gives it only some months, and then only in 억 달러. The KOGL Type 1 block first appears on the post of 2026-09-29; every release before, back to 2016, has none. KCS's copyright policy (cntntsId=2610) asks for consultation before an unmarked work is reused. So the rights split is per release, read from each page. Marked releases go out under KOGL Type 1, and unmarked ones stay in the harness. data.go.kr's keyed HS-code APIs (15101609, 15100475) would need a service key, an owner step, and weren't used.

UN Comtrade, read 2026-11-21. Korea's HS 8542 exports to the world, monthly, January 2013 to December 2025, from the keyless public API: `getDA/C/M/HS?reporterCode=410` lists 156 monthly datasets with `firstReleased` and `lastReleased`, and `preview/C/M/HS` returns one period a call (two periods in one call is refused: "Maximum number of periods for preview is 1"; a second call within a second is a 429). **Include** (`un-comtrade-hs8542`, restricted). The re-dissemination policy says permission is not required for "Publication of limited amounts of UN Comtrade data in a few tables, graphs, visualization in printed or digital platform" or a "Free-of-charge data extraction and/or streaming application offering only a small number of records (up to 100,000)"; we hold about 160. Attribution reads "Source: UN Comtrade." A commercial API needs a fee-bearing arrangement "regardless of database size", so these rows stay out of any paid tier. The release dates matter more than the terms. Korea comes out in yearly batches, 5 to 16 months after a month ends, and 114 of the 156 months were re-released later: 2015 to 2022 in July and August 2024, 2014 in June 2025. The value served now is the latest, so each month is dated public at its `lastReleased`, and most of the history shares a few public days. It fills the page's history; as a lead on MU and NVIDIA it is thin, and KCS's own releases (held for the harness) remain the timely series.

Ties from each Taiwan company to whom it builds for or supplies are quotes from NVIDIA's and AMD's 10-Ks, NVIDIA, OpenAI, Samsung, Micron and Meta newsrooms, and Wiwynn's annual report (`layers/compute/server/curated/print-ties.json`). No hyperscaler tie for Quanta, Wiwynn, TSMC, Gigabyte or Delta came from a primary source, so none is listed.

## Addendum, 2026-11-21: earnings-call guidance for the 45 listed companies

What management guided on each call (capex, revenue, a segment or AI line, gross margin, backlog), scored against what the company filed later. The reader is `layers/terminal/server/calls/`; every company's source and gap is in `layers/terminal/server/curated/earnings-calls.json`.

**What each company posts, read 2026-11-21.** A survey on 2026-11-20 sorted the 45; this pass fetched each file it lists.

| Posts | Companies | What we read |
| --- | --- | --- |
| Own transcript | MSFT, GOOGL, META, NVDA, AMD, QCOM, DELL, HPE, CRWV, CIEN, HUT, GEV, DTE | Every file the company links at a fixed address since October 2025: 54 transcripts. Several are vendor files: LSEG (Qualcomm), FactSet (NVIDIA, CoreWeave, DTE), S&P Global (Ciena), Bloomberg (NVIDIA Q3 FY2027, whose body our PDF reader can't decode). |
| Own transcript, host refuses us | ARM, TSM, WMB, GLXY | investors.arm.com, investor.tsmc.com and investor.williams.com answer 403 or a bot challenge; Galaxy's IR site too. Their EDGAR exhibits only. |
| Prepared remarks | INTC, SMCI, CORZ, NBIS | Intel's five, Super Micro's one at a fixed address, Core Scientific's three; Nebius's shareholder letter from its 6-K. The Q&A is on a registration-gated webcast. |
| Replay MP3 | AMZN, AEP | Transcribed with AssemblyAI: Amazon's Q3 2026 call (its earlier replays are gone after about three months) and AEP's last five. GE Vernova posts MP3s too, beside its transcripts, so its audio isn't sent. |
| Webcast only | ORCL, AVGO, MRVL, ANET, AAOI, APLD, IREN, WULF, AKAM, CLS, ALAB, CRDO, LITE, COHR, FN, CBRS, CIFR, RIOT, BE, ETR, PNW, WEC | No transcript and no media file the company links: replays are Q4, Notified, Chorus Call, Viavid or webinar.net players, most behind registration. Their 8-K/6-K exhibits only, which for most print the next quarter's outlook. IREN filed one transcript as an 8-K exhibit (May 2026). Entergy's terms bar automatic reading. The owner decided on 2026-11-21 not to record streamed or registration-gated replays: these stay gaps. |

**EDGAR.** Every earnings 8-K (item 2.02) and 6-K since 2025-10-01, and each EX-99 exhibit on its index page: the release, NVIDIA's CFO commentary, Nebius's shareholder letter, Cipher's and Core Scientific's decks. These are read for all 45 and carry most of the scored figures.

**AssemblyAI.** Model `assemblyai-stt-3-7` with key terms (company, ticker, executives, products, segments, the labs and model families we track), a one-sentence prompt, speaker labels with a speaker range, speaker identification by name (executives, the operator, and "Analyst" for every questioner, so only an executive's sentence becomes a statement), custom spelling and no disfluencies: $0.35 an hour in all. The six backfill calls (6.15 hours) cost about $2.15 of the $50 free credit; the Worker caps spend at $40 and spools `assemblyai_credits` at the cap or on a billing refusal. Terms (effective 2026-07-01): the customer keeps its data, and Output may not be represented as human-generated, so a replay quote is labelled as our machine transcript.

**Terms and what is published.** Q4 Inc's platform terms bar crawling and storing a significant portion of its content; Bloomberg's transcripts say any reproduction is prohibited. We fetch each linked file once, keep its text (and our transcripts) privately in R2, and publish only the scored figures, quotes of at most 25 words and links to the company's own pages, as the owner decided on 2026-11-20. Audio and transcripts are never served. Verdict: include, quote-only (`rights: restricted`).

**The rule.** A sentence is taken when it looks ahead, doesn't report a result, isn't a question, and states an amount after a metric it names, as a range, a band ("plus or minus"), or one figure with its bound. The period is the one named nearest the figure, else the outlook's a few sentences back, else the next quarter for a "plus or minus" figure; a period not after the quarter the call reported is dropped. A document the rule finds nothing in is offered to the judge routine (GUIDANCE REVIEW), whose answers are checked against the stored text with the same rules.

**Scoring.** Against XBRL company concepts, at the first filing that printed the figure: total revenue (a fourth quarter as the year less the nine months), capex (Meta's with finance-lease principal; Amazon's net figure unscored), GAAP gross margin, and remaining performance obligations. A range is met when the figure is inside it, a single figure within 5% (half a point for a percentage). A segment line, an AI figure, a non-GAAP margin and the four foreign filers' quarters (6-Ks carry no XBRL) are listed and not scored.

**Verdict.** Include.

## Addendum, 2026-11-21: earnings-call guidance back to 2018

The owner approved backfilling the call guidance to calls held from 2018, AssemblyAI spend included, because the guidance surprise series needs many quarters before /signals can grade it. Same rules as the addendum above: only files a company links publicly from its own results or event page, nothing behind registration, nothing from Q4, Notified, Chorus Call or YouTube players, and a host that refuses our client is a gap.

**How the older files were found.** By hand, once, from the results or event page that links each file: the live page, a Wayback Machine capture of it when the live page no longer reaches back, or on a Q4-hosted site the feed that page renders from. Every file was then fetched with our own client. The page a row links to is the company's own page, never the capture.

**EDGAR.** Every earnings 8-K (item 2.02) and 6-K since 2018-01-01, from the submissions feed and the paged files it names for older filings: 2,094 filings and 2,254 exhibits for the 45 companies in a local run against EDGAR. Spot checks of 2018 to 2022 releases changed the rule where old layouts broke it: an outlook list under a lead-in ("the company currently expects:"), a table row whose guidance column is its last cell, a band spelled out or written "+/-", GAAP and non-GAAP margins given "respectively", the quarter a figure is compared against, a year inside a date, and figures that are not one period's guide (a multi-year CAGR, growth capex, today's backlog, a utility's kilowatt-hour sales, a slide's columns). Fixtures: `fixtures/calls/exhibit-excerpts-2018-2022.json`. Four filer quirks: Marvell (before April 2021) and Broadcom (before April 2018) filed under earlier CIKs, which are read; Nebius's CIK was Yandex's until July 2024 and TeraWulf's was IKONICS's until December 2021, so neither is read before then; DTE Gas's own releases under DTE Energy's CIK are skipped; TSMC's 6-Ks before October 2019 carry the release in the 6-K itself, with no exhibit, so nothing is read from them.

**Company files, depth reached.** Read 2026-11-21.

| Company | Reached | Kind | Why not further |
| --- | --- | --- | --- |
| META, HPE, DTE | Q4 2017 call (Jan–Feb 2018) | Transcript | Complete. |
| MSFT | Q2 FY2018 (Jan 2018) | Transcript | Complete: Word files on Microsoft's CDN until January 2022, its transcript pages since. |
| DELL | Q1 FY2019 (Jun 2018) | Transcript | Q4 FY2018's link points at a file that is gone. |
| QCOM | Q4 FY2018 (Nov 2018) | Transcript | Qualcomm posted none for the three calls before. |
| GOOGL | Q1 2022 | Transcript | Older files were on the retired abc.xyz static site and answer 404. |
| CIEN | FQ1 2022 | Transcript | Older files were on a retired IR file host and answer 404. |
| AMD | Q4 2023 | Transcript | AMD's results page links none for 2020 to 2023; its 2018 files are gone. |
| NVDA | Q1 FY2026 (May 2025) | Transcript | NVIDIA posted none before; its CFO commentary on EDGAR carries the outlook back to 2018. |
| CRWV, GEV, HUT | First call as a listed company (2025, 2024, 2024) | Transcript | Complete. |
| SMCI | FQ2 FY2020 | Remarks, 3 transcripts | No call files during the 2018–2019 restatement. No Q&A in the remarks. |
| INTC | Q4 2017 call (Jan 2018) | Audio to Q1 2021, remarks from Q3 2021 | Q2 2021 has only a registration-gated webcast. |
| CORZ | Q1 2026 | Remarks | Earlier calls only on Chorus Call. |
| AEP | Q4 2017 call (Jan 2018) | Audio | Complete. |
| AMZN | Q1 2020 | Audio (WAV until 2024) | Q2 2021 and every call before 2020 have no replay file linked. |
| CLS, HUT (audio) | — | — | Celestica linked call MP3s from 2019 to 2023 and Hut 8 from 2018 to 2025, but both hosts now refuse our client (403); not worked around. |

The other 24 post no transcript and no media file we may read, as the addendum above lists; their EDGAR exhibits are their whole record.

**Our PDF reader.** FactSet's and LSEG's transcripts draw each page's text inside a form XObject, which the reader didn't follow; it does now, which also decodes the Bloomberg NVIDIA file the addendum above lists as unreadable. Two Qualcomm files from 2022 and Hut 8's Q4 2023 file still yield no text.

**AssemblyAI.** The backfill has a one-time ceiling of $75 (`BACKFILL_SPEND_CAP_USD`), its own basis apart from the $10 monthly cap: a call held before 2025-10-01 is the backfill's. `scripts/calls-audio-backfill.ts` costed each replay from its size and header before sending it, newest first, and wrote each job id back to `curated/earnings-calls.json`; the Worker collects the transcripts. Sent 2026-11-21: 66 replays (31 AEP, 21 Amazon, 14 Intel), 61.3 hours, $21.46 billed, same model and features as the calls since October 2025. Amazon's four replays since October 2025 are left to the Worker under the monthly cap.

**What a local run against live sources found.** 2,207 statements from 40 companies, 1,699 of them from calls held before October 2025 (35 companies), against 108 from 18 companies in production; 1,209 score against later XBRL facts, 1,043 of them from the backfill, with periods back to the first quarter of 2018 for calendar and fiscal-year filers alike (NVIDIA, Marvell, Broadcom, Ciena, Dell, HPE, Qualcomm, Coherent, Lumentum, Fabrinet). By source: 1,560 from exhibits, 444 from transcripts, 142 from remarks, 61 from our machine transcripts.

**Verdict.** Include, unchanged; `sources.yaml` › `call_sources` records the depth and the ceiling.

## Addendum, 2026-11-21: hiring at the listed companies

Checked to see whether the listed companies around the labs post their open roles somewhere we may read. The hypothesis the signals harness tests: data-center operations, site and construction hiring comes two to three quarters before megawatts are energized, and before revenue at the neoclouds and miners. So the boards that matter most are the hosts': neoclouds, miners turning host, and the hyperscalers' data-center teams.

| Company | Board | robots.txt | Terms (read 2026-11-21) | Verdict |
|---|---|---|---|---|
| CoreWeave (CRWV), Nebius (NBIS), Galaxy (GLXY), Hut 8 (HUT), Cipher Digital (CIFR), Astera Labs (ALAB) | Greenhouse job board API, `/departments` | Disallows only `/embed/` | Greenhouse: "Job Board data is publicly available". No company terms we found address automated reading | Include |
| Cerebras (CBRS) | Ashby posting API | None (401) | Ashby documents it as public | Include |
| Credo (CRDO) | HiBob careers API | None served | Credo's legal page and HiBob's terms say nothing on automated access | Include |
| Google (GOOGL) | Careers feed, already read by the careers lane | As `google-careers` | As `google-careers` | Include, data-center roles only, from the archived copy |
| IREN | HiBob | None served | Bars "any text or data mining or web scraping" of its sites or services provided through them | Cut |
| NVIDIA (NVDA) | Workday | Allows the career site | Bars "any robot, spider, scraper, crawler, data mining tool" | Cut |
| Oracle (ORCL) | Oracle Recruiting | — | Bars "any robot, spider, scraper or other automated means" | Cut |
| Meta (META) | metacareers.com | "Collection of data … through automated means is prohibited" | — | Cut |
| Amazon (AMZN) | amazon.jobs search | Allows search | Its A to Z Conditions of Use exclude "any use of data mining, robots, or similar data gathering and extraction tools" | Cut |
| Supermicro (SMCI) | — | 403 to a non-browser client | — | Cut |
| Arista (ANET) | — | Careers page 406s; no board API answers | — | Cut |
| Core Scientific (CORZ) | Greenhouse, sign-in only | — | — | Cut |
| Applied Digital (APLD), TeraWulf (WULF) | ADP Workforce Now | Redirects to sign-in | No public job API | Cut |
| Riot (RIOT) | Rippling board API | Disallows only `/internal/` | Rippling's terms render only in a browser; unread | Deferred |
| HPE | Workday | Allows `/Jobsathpe/` | hpe.com's terms timed out from every client | Deferred |
| Dell (DELL) | Oracle Recruiting Cloud | — | Site terms silent; needs a reader of its own | Deferred |
| Microsoft (MSFT) | Eightfold search API | Allows `/api/pcsx` | Bars any means "not intentionally made available"; ten roles a request | Deferred |

The exact sentences are in `sources.yaml` under `listed_hiring_sources`.

**How a role is classed.** By rule, from the board's own title, then its department (`classifyRole` in `layers/talent/shared/utils/listed-hiring.ts`, tested on titles from every captured board). Data-center: operations, site, construction, facilities, commissioning, environmental health and safety, power and interconnection, real estate and site selection. Infrastructure: GPU, HPC, cluster, fleet, site reliability, networking, storage, Kubernetes, bare metal. A corporate function is other on any team: a recruiter for data-center operations, an accountant for construction, an account executive selling to data centers. On the captured boards: CoreWeave 44 data-center and 49 infrastructure of 316, Nebius 82 and 92 of 367, Cerebras 18 and 32 of 132, and 256 Google data-center roles of the 2,820 Google-employer roles in the feed (its DATA_CENTER_OPERATIONS category, plus titles naming data-center work in other categories).

**Limits.**

- **A chipmaker's data-center roles are noise.** Astera's and Credo's "data center" roles mostly sell to data centers, so only their totals are registered as signals.
- **One board, one company.** Galaxy's board covers its trading business. Hut 8's lists American Bitcoin's roles.
- **HiBob's API isn't documented.** A changed payload fails the read instead of emptying the board, and a board that lists no roles after ten or more fails too.
- **History starts at our first read.** Closed roles before 2026-11-21 aren't known, so the harness reads "not enough history" until the series grows.

**Verdict: include the nine boards above under `listed_hiring_sources`, read daily at 04:00 UTC.** The owner approved the alpha program on 2026-11-20. On 2026-11-21 the owner cut the four deferred boards (Riot, HPE, Dell, Microsoft): the terms risk or a new reader isn't worth it for one miner and two server makers the Taiwan prints already cover, and Microsoft's terms bar it.

## Addendum, 2026-11-21: history backfills (launch and price events, hyperscaler disclosures, rate limits)

Three backfills of series the terminal already carries, approved by the owner on 2026-11-21. Each keeps its history apart from the live tables and says how far it reached.

### Launch and price events from the archived price lists

Derived each harness run from `archived_prices` (the Internet Archive backfill above), never stored (`layers/pricing/server/pipeline/archive/price-events.ts`). A launch is a model's first appearance on its lab's list; a price change is a SKU's input price moving between two consecutive copies that both print it. Events end where the live record starts (`ARCHIVE_UNTIL`, 2026-08-25); the live loaders start there.

**Dating.** A copy only bounds an event: it happened between the copy before and the copy that shows it, about a week apart at the backfill's cadence. The labs' own release notes date most of them (`sources.yaml › archive_sources › release-notes`; pages committed under `fixtures/release-notes/`, reduced to `release-notes.json` by `bun run release-notes`). A note dates an event when it names the model (one spelling for "Claude 3.5 Sonnet", "Claude Sonnet 3.5" and `claude-3-5-sonnet-20240620`) and falls inside the window, or up to 14 days before it for a price change, since a lab can announce a cut before its page shows it. An event no note dates keeps its window: it is dated at the copy before, and the harness scores it only at horizons the window allows (`maxWindowDays`: within two days for 1 and 5 sessions; up to 14 days at 20 sessions and 42 at 60).

**What the notes cover.** OpenAI's changelog from 2023-10-06, the Gemini API release notes from 2023-12-13, Anthropic's platform release notes from 2024-05-10, DeepSeek's API news from 2024-05-17. From those days a launch needs a note in its window: a name that appears on a list with no note is usually a model listed late (OpenAI's `babbage-002`, a year after release), so it is skipped with the reason. A model a note named before the copy before is skipped as listed late. xAI's notes give a month, not a day, and Mistral's changelog renders in the browser, so their events keep their windows. A price that moves and moves back within 30 days is a misread copy and both moves are dropped; an event first seen on a copy read by a different parser than the copy before is kept only when a note dates it.

**Reach, local run** (the same eras and cadence as production's backfill, which holds 8,084 rows):

| Lab | Launches (dated by a release note) | Price cuts (dated) | Price raises (dated) |
|---|---|---|---|
| OpenAI | 57 (54) | 17 (14) | 0 |
| Anthropic | 15 (15) | 1 (0) | 0 |
| Google | 31 (31) | 6 (0) | 2 (0) |
| DeepSeek | 4 (4) | 3 (2) | 5 (1) |
| xAI | 12 (0) | 3 (0) | 0 |
| Mistral | 11 (0) | 7 (0) | 1 (0) |
| Alibaba | 8 (0) | 2 (0) | 0 |

185 events from 396 parsed copies (8,150 `archived_prices` rows, 2023-03-07 → 2026-08-24), 121 of them dated by a release note; 52 more skipped with their reasons. Alibaba's are derived but not registered: it has no ticker in the panel.

### Hyperscaler disclosures about the labs, back to 2023

- **Microsoft on OpenAI.** Its 10-Q for the quarter to 2024-09-30 (filed 2024-10-30) is the first to tag `msft:OpenAIGlobalLlcMember`, and the filed-facts reader already reads every instance since 2020, point in time by filing date (`filed_facts`; production's exposure series reach the quarter to 2024-06-30). Its 10-Qs and 10-Ks from 2023-04 to 2024-07 name OpenAI only as a partner: no sentence in them states a figure about it (each read on 2026-11-21). So the line starts in 2024; nothing earlier exists to backfill.
- **Amazon on Anthropic.** Amazon tags `amzn:AnthropicMember` from its 10-Q of 2026-04-30. Its ten 10-Qs and 10-Ks from 2023-10-27 to 2026-02-06 state Anthropic figures only in words, and the filed-facts reader now reads each primary document once, two a run (`filed_text_facts`, `layers/terminal/server/exposure/text-facts.ts`): each note bought (Q3 2023 $1.25 billion, Q1 2024 $2.75 billion, Q4 2024 $1.3 billion, Q2 2025 $1.3 billion, Q4 2025 $1.4 billion), the notes committed to, their fair value, and from 2025 the gains on converted notes and upward marks. Eight wordings are read; a sentence that matches none is not. On the local run: 45 rows, 22 distinct figures, the first filed 2023-10-27. Where Amazon says a figure is "primarily" from Anthropic the row says so. Fixtures of four layouts are under `fixtures/filed-facts/text/`.
- **Alphabet's token volume.** EDGAR full-text search finds "tokens" in Alphabet's earnings releases only from 2025-10-29 (Q3 2025), so `sec-googl-api-tokens` already starts where the disclosure does. Each release's dateline is now kept, so the harness dates a quarter by its release.

Registered: `msft-openai-other-income`, `amzn-anthropic-upward-marks` and `googl-api-tokens`, each a quarter as first filed or released. They are thin for years.

### Rate limits and usage tiers from Internet Archive copies

`scripts/wayback-backfill.ts --axis limits`; eras in `layers/pricing/server/pipeline/archive/limits-eras.ts`, rows in `archived_rate_limits` keyed as the live `limits-anthropic` recipe keys its own (`sources.yaml › archive_sources › wayback-limits`). Same client, pace, User-Agent and terms as the price backfill. CDX listings read 2026-11-21:

| Lab | URL | Copies (months) | Read |
|---|---|---|---|
| Anthropic | docs.anthropic.com/claude/reference/rate-limits | 2024-03 → 2024-05 | yes |
| Anthropic | docs.anthropic.com/en/api/rate-limits | 2024-05 → 2025-09 | yes |
| Anthropic | docs.claude.com/en/api/rate-limits | 2025-09 → 2025-11 | yes |
| Anthropic | platform.claude.com/docs/en/api/rate-limits (.md from 2026-06) | 2025-11 → 2026-11 | yes |
| OpenAI | platform.openai.com/docs/guides/rate-limits | 37 months from 2023-01 | no: every copy is a 3 KB script shell |
| OpenAI | developers.openai.com model pages (.md) | from 2026-10 | no: after our first read |
| xAI | docs.x.ai/docs/models, …/consumption-and-rate-limits, developers/rate-limits | 2025-01 → 2026-11 | no: the tables render in the browser |
| Meta | dev.meta.ai/docs/pricing-rate-limits | from 2026-08 | no |

**Layout drift.** Every Anthropic copy prints its usage-tier table, and its columns are read by header: the last column was the monthly spend cap ("Max usage per month") until 2025, the most a tier may deposit ("Max credit purchase") after, and from 2026 both, the cap as "Monthly Spend Limit"; each is its own row. "Build Tier 1" is read as Tier 1. The per-model rate tables sit in tier tabs: early March 2024 prints one table with a row per tier for all models, March to May 2024 labels each tier's table, and from May 2024 the copies render only the first tab (Tier 1), which is read as Tier 1. From 2025-03 the copies render every tab's table with no label, plus one more, so no table can be tied to a tier and those rates are skipped with the reason; from 2025-11 they render none, and the 2026 `.md` copies carry every tier again. **Reach, local run:** 67 copies of Anthropic's page read, none skipped (1,535 rows, 2024-03-06 → 2026-10-30): the usage-tier table in all 67, per-model rates in 26 (2024-03 → 2025-02, and the two 2026 `.md` copies). Nine limits moved between copies, all raises: Claude 3 Haiku's and Sonnet's tokens per day in April 2024 (a 20-day window), and Tier 4's and Tier 1's spend caps on 2026-03-13 and 2026-05-12 (dated by Anthropic's release notes). OpenAI, xAI and Meta: no copy that reads.

A raised limit or cap is registered as an event series, `limit-raises-anthropic`, dated by a release note that talks about rate limits inside the window, else by the window.

**Verdict: include.** Rights stay `not-cleared` for the archived copies and the release notes; the SEC filings are `ours`.
