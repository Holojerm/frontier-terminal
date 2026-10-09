# Thesis: Anthropic

A research journal entry, not investment advice. The model behind it: [`docs/thesis-engine.md`](../thesis-engine.md).

| | |
| --- | --- |
| Stance | Bullish |
| Statement | Anthropic becomes the premium lab for developers and enterprises, and earns it in price, demand and hiring. |
| Comparison set | OpenAI, Google, xAI |
| Horizon | Until Anthropic's public S-1, or 2027-06-30 if none |
| Position | None |
| Opened | 2026-10-08 |

## Claims

Baselines are as of 2026-10-08. OpenRouter figures cover the week of 2026-10-01 to 2026-10-07, among the four labs only.

| # | Claim | Signal | Baseline | Kill condition |
| --- | --- | --- | --- | --- |
| 1 | Anthropic earns more per token than its rivals | Measured: OpenRouter spend share ÷ token share | 1.85× (44.3% of spend on 23.9% of tokens); OpenAI 0.9×, Google 0.25× | Below 1.3×, or below OpenAI's ratio, for 4 straight weeks |
| 2 | Developer demand is growing, not only price | Measured: Anthropic's share of the four labs' OpenRouter tokens | 23.9%; its share of all OpenRouter tokens rose from 3.2% to 4.0% week over week | More than 5 points below its trailing 13-week average |
| 3 | Rivals do not force a price war on the premium tier | Judged: each rival flagship price cut rated a generational step-down or a competitive cut | No competitive cut rated yet | Two competitive cuts of 30% or more on rival flagships within 90 days, and Anthropic matches one |
| 4 | Hiring scales where revenue and compute come from | Measured: open roles in Sales, Applied AI, Infrastructure and Compute | 249 of 645 (Sales 120, Applied AI 58, Infrastructure 45, Compute 26) | Those roles fall 25% or more from their 90-day high |
| 5 | Safety is an asset, not a liability | Judged: Anthropic incidents and misalignment disclosures rated against a severity rubric, beside rivals' | Set at M1 | The judge rates an event material and Jeremy confirms: a multi-hour flagship API outage, or a disclosure Anthropic calls high severity |

## Caveats

- OpenRouter is one aggregator. Claims 1 and 2 see developer traffic, not enterprise or direct API volume, so a kill there prompts a revision, not a verdict.
- Claims 2 and 4 are rebuilt from history the terminal already holds: rankings since 2026-08-10, the Anthropic job board since 2026-08-25. Until the full 13 weeks or 90 days exist, claim 2 compares against the weeks available once there are at least 4, and claim 4 measures from the highest point seen once there are 30 days; each status says how much history it rests on.
- Each rule reads weekly checkpoints (the newest reading, then one 7, 14, 21… days back), not every day. A claim is weakening once it is half way to its kill condition: half the run of weeks, half the margin, or half the drop.
- The public S-1 ends the horizon and opens a revenue claim; until then the revenue axis stays empty.

## How the judged claims are rated

Claims 3 and 5 are rated by the judge routine, hourly, from 2026-10-09 on. The Worker picks the events and computes every number about them; the judge only picks a verdict and says why, and a rationale that cites anything not in the record is dropped.

- **Claim 3.** An event is a price cut on a lab's flagship: the model its vendor recommends as the place to start (the terminal's class map). The cut is the larger fall of the input and output list prices. The judge rates each cut competitive (the model still leads, nothing replaces it) or generational (a newer model is taking its place), and rates generational when the records cannot tell.
- **Claim 5.** An event is an incident whose impact is major, critical or high and that lasted two hours or more, or a new entry on a lab's misalignment-disclosure index. The judge rates it material when it hit the API or a flagship model rather than a consumer app, console or billing, or when the disclosure itself says high severity. Anthropic publishes no disclosure index today, so for Anthropic only incidents can count. Rivals' events are rated too, for comparison.
- **Confirming.** A material Anthropic event leaves claim 5 weakening until you rule on it: add `{ subject, decision, on, note }` to the claim's `confirmations` in `server/theses/anthropic.ts` and a row below. Confirmed breaks the claim; rejected sets it aside.

## Revisions

| Date | Change | Reason |
| --- | --- | --- |
| 2026-10-08 | Opened | First thesis on the engine |
| 2026-10-08 | Evaluation rules written down: weekly checkpoints, weakening at half way, partial history | Automated in M1 (`server/theses/`) |
| 2026-10-09 | Judged claims 3 and 5 get their rubrics and candidate rules; "multi-hour" set at two hours | Automated in M2 |
