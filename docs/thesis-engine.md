# Thesis engine — plan

Written 2026-10-08. Working copy for discussion: [claude.ai doc](https://claude.ai/code/artifact/4699c725-6ac5-43e4-bbb6-c76c0f0f4d8a); this file is the record.

## Summary

A personal research instrument, built in public on Frontier Terminal. Investment theses are bound to open, sourced datasets and scored against reality over time: measured signals where a number exists, LLM-judged signals where the evidence is fuzzy. It is built for Jeremy first; others can follow, request datasets, and later fork theses.

Frontier Terminal is the engine, and its first thesis is Anthropic, read off the seven axes it already tracks, with the other frontier labs as its comparison set.

## Decisions

- **Frontier Terminal is the engine.** Anthropic is the first thesis; new theses join the same app, not a new one.
- **The thesis layer is core.** Datasets exist to test claims, not as a product on their own.
- **Signals can be measured or judged.** A number from a recipe, or an LLM verdict on grounded change rows, as Frontier Terminal's judge already does.
- **No public-company line.** Private companies count; the frontier labs are already among the largest. One size floor applies to all.
- **Data and recipes are fully open.** If money ever comes, it comes from the platform, not the data.
- **Jeremy gates requests.** No queue promise, no SLA.
- **Hobby-first.** It succeeds if it is useful to one person.

## The model

- **Thesis.** A short statement about one company, with a horizon, a position disclosure, and a comparison set of direct competitors tracked alongside it. Revisions are dated, with a reason.
- **Claim.** One of 3–5 things the thesis rests on, each with a kill condition written before the data arrives.
- **Signal.** The evidence a claim is checked against, measured or judged.
- **Measured signal.** A number a recipe produces, such as a list price or an open-role count.
- **Judged signal.** An LLM's rating of fuzzy evidence against a rubric written with the claim, such as "is this lab's launch cadence accelerating?" Every verdict cites the change rows it read and passes a grounding gate before it lands.
- **Recipe.** A source URL plus an extractor that AI writes and a plain script re-runs.
- **Dataset.** The time series a recipe produces. Every snapshot is kept; it cannot be backfilled.
- **Claim status.** Holding, weakening, broken or unresolved, set by the kill condition, not by mood. A judged signal moves it only through its rubric.

## MVP scope

**In**

- First thesis: Anthropic, bullish, with OpenAI, Google and xAI as its comparison set, on the seven axes already tracked: [`docs/theses/anthropic.md`](theses/anthropic.md).
- Second thesis: one company outside the labs (Cloudflare is the candidate), as the test that the engine is general.
- One recipe per measured signal, every snapshot kept; one rubric per judged signal.
- Claim status computed from kill conditions.
- A weekly digest of only the changes that touch a claim. This is the product; everything else is setup.
- Thesis pages with revision history on the existing public site; datasets stay in the existing CSV and JSON exports.
- Recipes live in this repo.
- A request form, gated by Jeremy.

**Out**

- Accounts, comments, or anyone else publishing theses.
- Private overlays, payments, API, real-time alerts.
- Crypto and digital assets; small caps.
- Backfilling history or company-reported KPIs already covered elsewhere.

## Architecture

- **Home:** this repo and deployment. The pipeline (fetch, normalize, diff, store), D1, R2 and Workers cron are already the bottom half.
- **New:** thesis definitions in `server/theses/`; `claim_readings` and the append-only `claim_status_changes` beside `snapshots`, `entities` and `changes`, written after each survey tick; `GET /api/theses`; thesis pages; the weekly digest.
- **Measured signals:** AI writes and repairs extractors at dev time; plain code runs them on the cron.
- **Judged signals:** the existing judge routine (a claude.ai routine on the subscription, hourly) widens from "is this change significant?" to "what does it mean for this claim?". The Worker re-runs the schema and grounding gate before any verdict is stored.
- **Fallback runner:** the Mac mini, for sources that block cloud IPs or need a real browser.
- **Breakage:** a recipe that fails or returns an outlier is flagged, never silently skipped.
- **Generalize late:** the parser contracts name the four labs today; they widen when the second thesis needs it, not before.

## Rules of the road

**Data**

- Recipes are MIT; data is CC-BY.
- Only public, no-login sources. Terms forbid redistribution → publish the recipe and derived number, not the raw snapshot. robots.txt says no → skip.
- Every data point carries its source URL, snapshot time and recipe version.
- Errors are corrected in public with a dated note; history is never rewritten.

**Requests**

- Qualifies only if the source is public, the recipe is re-runnable, it ties to a claim, and the company is above the size floor.

**Conduct**

- Every thesis shows the current position: long, short or none.
- Publish before trading: no trades in a name within 48 hours of a significant data change on it.
- Theses are a research journal, never recommendations.

**Scope**

- Datasets can stop. A stopped dataset is marked deprecated with a date, never deleted.

## Milestones

| Milestone | Scope | Done when |
| --- | --- | --- |
| M0 · week 1 | License; first thesis written: claims, kill conditions, rubrics | Rules and thesis published in the repo |
| M1 · weeks 2–3 | Thesis layer; claim status from measured signals | Lab thesis status computed from live data |
| M2 · weeks 4–5 | Judged signals; weekly digest | Digest arrives every week |
| M3 · weeks 6–8 | Second thesis outside the labs; thesis pages; request form | Added with a new recipe and thesis only, no lab-specific code touched |
| Later | Others publish theses; private forks; paid tier | Only once people ask to fork privately |

## Success at 3 months

- **Required:** the digest is opened every week and has prompted at least one thesis revision or explicit hold.
- **Healthy:** most recipes run without hand-fixing in a typical week.
- **Signal of more:** qualified outside requests arrive unprompted.

The first is enough to keep going as a hobby.

## Monetization, if ever

The Dune model: public data and theses free; paid platform. Candidates are private theses and overlays, faster refresh and more compute, API and exports, alerts, and team seats. None of it is built until others want to fork privately.

## Risks

| Risk | Mitigation |
| --- | --- |
| Recipes break constantly | Flag failures; keep the company list small |
| LLM verdicts drift or invent | A rubric per claim; the grounding gate; verdicts cite change rows and can be re-run |
| Source terms limit redistribution | Publish recipes and derived numbers only |
| Theses used to pump tickers | Size floor, position disclosure, every claim bound to data |
| Reads as investment advice | Journal framing, disclaimers |
| Community upkeep | No social features in the MVP |

## Open questions

- Which claims carry the lab thesis, and what decisions should the digest feed: entry, sizing, exits or understanding?
- Is Cloudflare the right second thesis, or would a less familiar company test the engine better?
- Where is the size floor now that private companies count: valuation, revenue or headcount?
- Does the weekly digest replace the Atom alert feed or sit beside it?
