# Thesis: Anthropic

A research journal entry, not investment advice. The model behind it: [`docs/thesis-engine.md`](../thesis-engine.md).

| | |
| --- | --- |
| Stance | Bullish |
| Statement | Anthropic becomes the premium lab for developers and enterprises, and earns it in price, demand and hiring. |
| Comparison set | OpenAI, Google, xAI, Meta, Mistral, DeepSeek, Alibaba, Moonshot AI |
| Horizon | Until Anthropic's first annual report (10-K) as a listed company, or 2027-12-31 if none. First horizon, "Until Anthropic's public S-1, or 2027-06-30 if none", reached 2026-10-26 |
| Position | None |
| Opened | 2026-10-08 |

## Claims

Baselines are as of 2026-10-08. OpenRouter figures cover the week of 2026-10-01 to 2026-10-07, among the four labs only.

| # | Claim | Signal | Baseline | Kill condition |
| --- | --- | --- | --- | --- |
| 1 | Anthropic earns more per token than its rivals | Measured: OpenRouter spend share ÷ token share | 1.85× (44.3% of spend on 23.9% of tokens); OpenAI 0.9×, Google 0.25× | Below 1.3×, or below OpenAI's ratio, for 4 straight weeks |
| 2 | Developer demand is growing, not only price | Measured: Anthropic's share of the tracked labs' OpenRouter tokens (nine since 2026-11-04) | 23.9%; its share of all OpenRouter tokens rose from 3.2% to 4.0% week over week | More than 5 points below its trailing 13-week average |
| 3 | Rivals do not force a price war on the premium tier | Judged: each rival flagship price cut rated a generational step-down or a competitive cut | No competitive cut rated yet | Two competitive cuts of 30% or more on rival flagships within 90 days, and Anthropic matches one |
| 4 | Hiring scales where revenue and compute come from | Measured: open roles in Sales, Applied AI, Infrastructure and Compute | 249 of 645 (Sales 120, Applied AI 58, Infrastructure 45, Compute 26) | Those roles fall 25% or more from their 90-day high |
| 5 | Safety is an asset, not a liability | Judged: Anthropic incidents and misalignment disclosures rated against a severity rubric, beside rivals' | Set at M1 | The judge rates an event material and Jeremy confirms: a multi-hour flagship API outage, or a disclosure Anthropic calls high severity |
| 6 | Businesses pay for Anthropic at least as often as OpenAI | Measured: Ramp AI Index, share of US businesses on Ramp paying Anthropic ÷ paying OpenAI, monthly | 1.08× in September 2026 (43.77% against 40.63%); first above 1.0× in May 2026 | Below 1.0× for 3 straight months |
| 7 | Developers keep building on Anthropic's API | Measured: npm downloads of `@anthropic-ai/sdk`, trailing 28 days | 183.7M to 2026-11-02, its high; 36M to 2026-03-28 | 30% or more below its 90-day high for 4 straight weeks |
| 8 | Business adoption of Anthropic keeps growing | Measured: Ramp AI Index, Anthropic's share of US businesses on Ramp against the same month a year earlier | +173% in September 2026 (43.77% against 16.02%) | Growth below 25% for 2 straight months |
| 9 | Revenue at least doubles year over year | Measured: revenue Anthropic reports to the SEC, against the same-length period a year earlier | +1206% for the nine months to 2026-09-30 ($33.24B against $2.545B, unaudited, S-1/A); +1088% for 2025 ($4.585B against $386M) | Growth below 100% in 2 straight reported periods |

## Caveats

- OpenRouter is one aggregator. Claims 1 and 2 see developer traffic, not enterprise or direct API volume, so a kill there prompts a revision, not a verdict.
- Claims 2 and 4 are rebuilt from history the terminal already holds: rankings since 2026-08-10, the Anthropic job board since 2026-08-25. Until the full 13 weeks or 90 days exist, claim 2 compares against the weeks available once there are at least 4, and claim 4 measures from the highest point seen once there are 30 days; each status says how much history it rests on.
- Each rule reads weekly checkpoints (the newest reading, then one 7, 14, 21… days back), not every day. A claim is weakening once it is half way to its kill condition: half the run of weeks, half the margin, or half the drop.
- Claims 6–8 were written on 2026-11-04 with their history already in view: Ramp's series back to July 2023 and npm's 540 days. Their thresholds were set against that history, not before it, unlike claims 1–5.
- Ramp sees US businesses on Ramp that pay by card or bill pay, counted as adopters for any positive spend in a month: adoption, not spend. Ramp restates past months between releases, and the claims read the newest release; each earlier one is kept beside it. Claims 6 and 8 rest on the same series, so a Ramp revision can move both.
- npm counts every download, CI included, and had 11 outage days of zero in the last eight months, each of which dents a 28-day sum by about 4%. Claim 7 reads the SDK, not Claude Code, whose series swings too far for a kill line.
- The S-1 (filed 2026-10-26) reached the first horizon. All five claims then on the thesis were holding, each since 2026-10-09; the horizon was extended and claim 9 opened, as planned.
- Claim 9 reads the periods the revenue page shows: the newest filing's value per period, restatements applied, the lab's own filings only (a parent's figure never counts). Each period is compared with the same-length period a year earlier; where one filing reports several spans to the same date (a quarter and the year to date), the longest is read. The S-1's interim periods are unaudited. Like claims 6–8, its threshold was set with the history in view.

## How the judged claims are rated

Claims 3 and 5 are rated by the judge routine, hourly, from 2026-10-09 on. The Worker picks the events and computes every number about them; the judge only picks a verdict and says why, and a rationale that cites anything not in the record is dropped.

- **Claim 3.** An event is a price cut on a lab's flagship: the model its vendor recommends as the place to start (the terminal's class map). The cut is the larger fall of the input and output list prices. The judge rates each cut competitive (the model still leads, nothing replaces it) or generational (a newer model is taking its place), and rates generational when the records cannot tell.
- **Claim 5.** An event is an incident that lasted two hours or more and whose impact is major, critical or high, or a new entry on a lab's misalignment-disclosure index. Anthropic's status feed publishes no impact (since 2026-11-04), so an Anthropic incident needs only the two hours; rivals' feeds still state one and are still held to it. The judge rates it material when it hit the API or a flagship model rather than a consumer app, connector, console or billing, or when the disclosure itself says high severity. An incident whose record cannot show what it hit is not material, and the judge never infers a severity from the wording. Anthropic publishes no disclosure index today, so for Anthropic only incidents can count. Rivals' events are rated too, for comparison.
- **Confirming.** A material Anthropic event leaves claim 5 weakening until you rule on it: add `{ subject, decision, on, note }` to the claim's `confirmations` in `layers/terminal/server/theses/anthropic.ts` and a row below. Confirmed breaks the claim; rejected sets it aside.

## Revisions

| Date | Change | Reason |
| --- | --- | --- |
| 2026-10-08 | Opened | First thesis on the engine |
| 2026-10-08 | Evaluation rules written down: weekly checkpoints, weakening at half way, partial history | Automated in M1 (`layers/terminal/server/theses/`) |
| 2026-10-09 | Judged claims 3 and 5 get their rubrics and candidate rules; "multi-hour" set at two hours | Automated in M2 |
| 2026-10-12 | Meta joins the comparison set; claims 1 and 2 read among five labs | Meta became the terminal's fifth lab, so its OpenRouter tokens now count in both shares and its flagship cuts and incidents are rival events. The 2026-10-08 baselines above are among four labs |
| 2026-11-01 | Mistral joins the comparison set; claims 1 and 2 read among six labs | Mistral became the terminal's sixth lab, so its OpenRouter tokens count in both shares and its incidents are rival events. It has no flagship class-map cell, so claim 3 sees no Mistral flagship cut until one is mapped |
| 2026-11-04 | Claims 6–8 added: Ramp adoption lead over OpenAI, `@anthropic-ai/sdk` downloads, Ramp adoption growth | Every demand claim read OpenRouter, which sees developer traffic only; Ramp adds enterprise spend and npm adds developer installs (`docs/source-audit.md`, 2026-11-04). Written with their history in view |
| 2026-11-04 | Horizon reached and extended; claim 9 added: revenue at least doubles year over year | The public S-1 (2026-10-26) was the first horizon, and every claim was holding at it. The horizon now runs to Anthropic's first 10-K as a listed company, or 2027-12-31; the S-1's revenue opens the claim this journal said it would |
| 2026-11-04 | DeepSeek, Alibaba and Moonshot AI join the comparison set; claims 1 and 2 read among nine labs | They became tracked labs (`docs/source-audit.md`, 2026-11-04), so their OpenRouter tokens (`deepseek/*`, `qwen/*`, `moonshotai/*`) leave "other" and count in both shares. The share is now read off each row's model id on every query, so the whole stored history moves to nine labs at once and no week mixes the two sets. The move is large: on the rankings fixture's week to 2026-09-08, the labs' share of all OpenRouter tokens goes from 26.7% to 45.5%, and Anthropic's share of the labs' tokens from 16.7% to 9.8%, because DeepSeek alone carried 16.8% of all tokens. Claim 2's kill margin stays 5 points, which is now about half of Anthropic's share rather than a fifth: the claim is harder to break than when it was written, and that is stated here rather than rescaled after seeing the numbers. Claim 1's ratios rise for every lab, because the new labs add many tokens at low prices; the 1.3× floor is unchanged. Alibaba's Qwen 3.8 Max is a mapped flagship, so its price cuts are rival events for claim 3; DeepSeek has no mapped flagship and Moonshot's flagship has no readable price, so neither can produce one. DeepSeek's status feeds publish no impact, so, as with Anthropic's, a DeepSeek incident becomes a claim 5 rival event on the two-hour bar alone and the rubric decides whether it was material |
| 2026-11-04 | Claim 5 takes Anthropic incidents on duration alone (two hours or more); the rubric decides materiality, and an incident whose title cannot show it hit the API or a flagship model is not material | status.claude.com's robots.txt disallows `/api/`, so the source moved to the Atom feed, which publishes no impact. Filtering on a field that is always null would offer no Anthropic incident at all; inferring an impact from the wording would invent one. Rivals keep the impact bar. Atom-era candidates also carry no component names, so the judge rates on the title (`docs/source-audit.md`, 2026-11-04) |
