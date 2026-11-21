# Thesis: Cloudflare

A research journal entry, not investment advice. The model behind it: [`docs/thesis-engine.md`](../thesis-engine.md).

| | |
| --- | --- |
| Stance | Bullish |
| Statement | Cloudflare compounds as the developer platform for the AI era: revenue keeps growing fast, developers keep adopting Workers, and it keeps shipping AI platform launches. |
| Comparison set | Akamai, Fastly |
| Horizon | 2027-12-31 |
| Position | Long |
| Opened | 2026-10-09 |

## Claims

Baselines are as of 2026-10-09. Every signal reads a recipe (`layers/terminal/server/theses/recipes/`), not the lab pipeline.

| # | Claim | Signal | Baseline | Kill condition |
| --- | --- | --- | --- | --- |
| 1 | Revenue grows 25% or more a year | Measured: quarterly revenue against the same quarter a year earlier, from SEC company facts; Akamai and Fastly beside it | Q2 2026: $696M, up 36% on Q2 2025 ($512M) | Below 25% for 2 straight quarters |
| 2 | Developer adoption compounds | Measured: npm downloads of wrangler, the Workers CLI, over the trailing 28 days, divided by the median of five non-AI npm packages | 92M in September 2026 (8M a month a year earlier) | The trailing 4 weeks fall 30% below their 26-week high |
| 3 | Hiring scales in engineering and sales | Measured: open roles in Engineering, Infrastructure, Production Engineering, Field Sales, Sales, Mid Market, BDR and Solution Engineering on Cloudflare's Greenhouse board | 268 of 425 open roles | Those roles fall 25% or more from their 90-day high |
| 4 | It keeps shipping AI platform launches | Judged: each Workers AI or Agents changelog entry, rated a major launch or minor | 19 entries in the 90 days to 2026-10-08, unrated | No major launch in 90 days |

## Caveats

- Revenue comes from XBRL company facts. 10-Ks report the year, so a fourth quarter is the year less its three reported quarters, marked derived. Akamai and Fastly tag revenue differently from Cloudflare; each filer's newest revenue tag is used.
- npm downloads count CI runs and coding agents as much as people, and they jumped from 8M to 92M a month in a year; read the trend, not the level. Since 2026-11-20 claim 2 divides by the median of react, typescript, express, lodash and axios, each against its own June 2025 average, so swings across all of npm cancel, and npm’s outage days are left out. The npm API serves 540 days, so claim 2 has history from the first run.
- The Greenhouse board is a current state: claim 3's series starts on 2026-10-09 and needs 30 days before it resolves. Which departments count as engineering and sales is a choice, listed above; a renamed department drops out until the list is updated.
- Claim 4 is rated by the judge from each entry's title and opening text: major is a new product, a generally available capability, a new model family, or a new major SDK or API version; minor is everything else, and unclear entries rate minor. It is unresolved until 45 days of entries are rated and can only break once 90 days are.

## Revisions

| Date | Change | Reason |
| --- | --- | --- |
| 2026-10-09 | Opened | Second thesis; the first outside the labs, and the test that the engine is general |
| 2026-11-20 | Claim 2 divides wrangler’s downloads by a basket of five non-AI npm packages, and npm’s outage days are left out | From October to November 2026 the five rose 29–40% and wrangler 61%, mostly from October’s five outage days reading as zero. Divided, wrangler’s 28 days to 2026-11-20 read 41.4M (167.8M raw), its 26-week high. Divided, it was more than 30% below its 26-week high from 2026-06-22 to 2026-08-22, before the thesis opened, and under 20% below since. The kill condition is unchanged. History is rebuilt under the new signal |
