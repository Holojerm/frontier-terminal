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
| Disclosures | OpenAI | `alignment.openai.com/misalignment-reports/` | SSR HTML (Vercel; ETag + Last-Modified) | report slug / notice id; title, summary, model, context | **Include** — 9 reports and 3 notices |
| Disclosures | OpenAI | `alignment.openai.com/misalignment-reports/{slug}/` | SSR HTML, one page per report | discovery / disclosure dates per report | **Include as derived** — one page per listed report |
| Disclosures | OpenAI | `alignment.openai.com/rss.xml` | RSS 2.0, 21 items | — | **Not used** — newest item 2026-07-21; lists none of the report pages |
| Disclosures | OpenAI | `openai.com/index/model-misalignment-reporting-framework` | — | — | **Not used** — HTTP 403 to a headless client, like every openai.com marketing page |
| Disclosures | Anthropic | `anthropic.com/news/investigating-incidents-cybersecurity-evals` | HTML article | — | **Cut** — one article (2026-07-30), not an index; `alignment.anthropic.com/rss.xml` is 404 |
| Disclosures | Google | none found | — | — | **Cut** — no disclosure page for Google or Google DeepMind; `deepmind.google/discover/blog/rss.xml` is 404 |
| Disclosures | xAI | `x.ai/safety` | — | — | **Cut** — HTTP 403 (Cloudflare challenge, 5,478 bytes), the same wall as `status.x.ai` |

**Findings.** The index page is one `<details class="cb-entry">` per entry. A report carries its title, a one-sentence observation, the model ("5.6-sol", "Internal unreleased Astra family model") and the context it was observed in ("RL training", "Internal deployment"), all stored verbatim. A notice (Hugging Face, DSEwiki, RubyGems) carries a summary and a link to an update on openai.com, which cannot be fetched headless. Every report's own page opens with a metadata cell of "Label: value" lines, and all nine print a discovery date, under three labels (`Discovery`, `Discovered`, `Discovery date`). The occurrence line varies more (`Sample`, `Samples`, `Incident date`, `Main incident date`, `Main incident`, `Main sample completed`) and sometimes names two dates ("Samples: Jan 24, 2026 and Oct 22, 2025"), so it is kept verbatim and never read as a date. One report prints its own `Disclosure date`. Two page layouts exist (a `data-web-metadata` table and a `data-source-index` table); both put the cell in the article's first `ap-doc-table`.

Time to disclosure, discovery date to publication, at this fetch: 5 days (DNS chatbot), 38, 69, 90 (printed disclosure date), 114 ×3, 121 and 153 days. Interpretation, marked as such: OpenAI's framework launched on 2026-09-16 with six reports discovered between April and August, so the long lags are a backlog published at launch; the lags of reports discovered after that date are the ones that test the framework. Press reports (Axios, Fortune, SiliconANGLE, 2026-09-16/17) describe a commitment to publish within six business days, or twelve with a minor investigation. That text is on the 403'd openai.com page, so the terminal shows the measured days and does not state the commitment as data.

Most entries are not sandbox escapes. The page covers misalignment broadly; the escapes (a DNS lookup to an outside chatbot, uploads to file hosts, disposable email sign-ups and leaked API keys) are some of the reports. Incidents reported only by third parties or the press (Hugging Face's own write-up, the RubyGems report, statements at the UN) are not ingested, for the reason compute-deal extraction was cut: coverage from the press cannot be made honest. The other labs are re-checked by the `gap-watch` routine (`.claude/routines/gap-watch.md`), which files an issue rather than registering a source, because a new source needs this same audit.

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

The rule behind `ours`: both the terms and robots.txt were read, and neither restricts what is taken. Stored job rows carry no posting body and no names of people (the parser schema is strict). Greenhouse payloads have had each job's `metadata` (a named Team Lead and work email) removed before archiving since 2026-11-04 (`layers/terminal/server/pipeline/redact.ts`), but earlier R2 objects still hold it, so archived job-board payloads are not part of any "source bytes" offer until they are scrubbed. "Not read" is not "restricted": OpenAI and Meta can move to `ours` once someone reads their terms in a browser. The Anthropic status feed's robots.txt is the one live robots conflict found. It is a documented endpoint polled four times a day and stays on the free site; whether to keep polling it is the owner's call.

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

**Saw-it time.** The brief asked for the fetch time of the earliest cited change row. A removal's row carries the provenance of the last fetch that still listed the entity (`layers/terminal/server/pipeline/diff.ts`), which was up to 51 days before the removal on the alerts checked. A removal therefore counts from its `detected_at`, the run that found it gone. Added and modified rows use `fetched_at`, which matched `detected_at` to the hour on every alert since 2026-09-08.

**Verdict.** Include GDELT (per alert, `track_record_sources`) and the four feeds (recipes, `recipe_sources`). OpenAI and Meta stay `not-cleared` and out of any paid offer. Anthropic and xAI have no newsroom time on the page, and the cut block says why.

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
| Alibaba | Pricing | `www.alibabacloud.com/help/en/model-studio/model-pricing` | 200, 505 999 bytes server-rendered HTML, no validators, a per-request trace id. One `<h3>` per model line, one `<h4>` tab per region, USD on the international site | **Include** (`alibaba-pricing-html`): Qwen-Max, -Plus and -Flash, Singapore tab, International rows |
| Alibaba | Pricing | `…/model-pricing.md`, and the page with `Accept: text/markdown` | the same HTML | No markdown twin, though `llms.txt` lists the `.md` URL |
| Alibaba | Class map | `www.alibabacloud.com/help/en/model-studio/models` ("Recommended models") | 200, 42 792 bytes. One card per model with a one-line use: qwen3.8-max "Complex reasoning and coding", qwen3.7-plus "Balanced performance, speed, and cost", qwen3.8-flash "Fast and cost-effective" | **Include** (`alibaba-models-html`), sentences only |
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

Checked for the price-history backfill (`scripts/wayback-backfill.ts`, eras in `layers/terminal/server/pipeline/archive/eras.ts`). Our own capture starts 2026-08-25. The Wayback Machine holds the labs' own pricing pages from before then. Every CDX listing and capture below was fetched on 2026-11-04 with a User-Agent naming this site, one request at a time, 4 seconds apart.

**Terms.** archive.org/about/terms.php is now a script shell, so the terms were read from the Archive's own capture of that page (dated 31 Dec 2014, unchanged since). Access to the Collections is "granted for scholarship and research purposes only". Use must be "limited to noninfringing or fair use under copyright law". Users agree "not to interfere with the work of other users or Archive personnel, servers, or resources", and published research should list the Archive in its bibliography. The Archive claims no license over the pages it holds; they stay the labs'. We take only the price facts each lab printed about its own API. web.archive.org/robots.txt is a 404 and archive.org/robots.txt disallows only `/control/` and `/report/`. A page a site owner excluded isn't replayed, so it never reaches us. The CDX server's documentation (the wayback-cdx-server README in github.com/internetarchive/wayback) states no rate limit, so we pace ourselves and back off on a 429 or 5xx.

**Rights.** `not-cleared` (`sources.yaml › archive_sources › wayback-pricing`). Archived rows are CC BY-NC 4.0 as full history, and a licensee's key doesn't relabel them (`ARCHIVED_EXPORTS` in `terminal-export.ts`), because the Archive's terms are for scholarship and research.

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

Same client, same pace and User-Agent, same terms. CDX listings were plain URL queries (one prefix sweep on openai.com/api/pricing hit a 503 and then a 504, and was stopped instead of retried). Every era below has a parser, a trimmed fixture recorded in `fixtures/manifest.json`, and a golden test in `layers/terminal/test/pipeline/wayback-labs.golden.test.ts`. Counts are from the local run, one capture per week of each era.

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
