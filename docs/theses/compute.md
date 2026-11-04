# Thesis: Compute

A research journal entry, not investment advice. The model behind it: [`docs/thesis-engine.md`](../thesis-engine.md).

| | |
| --- | --- |
| Stance | Bullish |
| Statement | Frontier labs keep pricing power as compute becomes a tradable commodity: token prices hold up relative to GPU rental costs, while demand and capacity buildout continue. |
| Subject | The frontier labs together (OpenAI, Anthropic, Google, xAI, Meta, Mistral) |
| Comparison set | The GPU rental providers tracked: CoreWeave, Lambda, Nebius, Crusoe, Together AI, DigitalOcean, Verda, Microsoft Azure, Oracle Cloud |
| Horizon | 2027-12-31 |
| Position | None |
| Opened | 2026-11-02 |

## Why

GPU-hours are becoming a commodity. There are public price pages from a dozen clouds and neoclouds, spot markets, and index products. If compute is a commodity and models are not, the labs should be able to sell tokens at prices that hold up against what the GPUs behind them rent for. If models are a commodity too, token prices should fall toward the cost of compute, demand should spread beyond the labs, and the buildout should slow. This thesis bets on the first reading and names, in advance, what would show the second.

## Claims

Kill conditions were registered on 2026-11-02, before any reading existed, and are not changed to fit the data. Baselines are the first readings: GPU prices from the pages fetched 2026-11-02 at 03:55Z, list prices and hiring from the terminal's store on the same day.

| # | Claim | Signal | First reading | Kill condition |
| --- | --- | --- | --- | --- |
| 1 | Token prices hold up against GPU costs | Measured: median flagship blended token price ÷ median public H100 on-demand price per GPU-hour. A modeled price relationship, not a margin | 1.78 GPU-hours per million tokens ($8.00/MTok ÷ $4.50/GPU-h, 9 H100 providers). B200 beside it, for context only: 0.94 ($8.55/GPU-h, 6 providers) | The ratio stays 30% or more below its 26-week high for 4 straight weekly readings |
| 2 | Flagship prices avoid a broad collapse | Measured: median flagship blended token price across the labs with a mapped flagship | $8.00/MTok: OpenAI GPT-6 Astra $20.00, Anthropic Claude Opus 5.5 $8.00, Meta Muse Wonder $8.00, Google Gemini 4 Argon $4.00, xAI Grok 4.7 $3.00; Mistral has no mapped flagship | It stays 30% or more below its 180-day high for 4 straight weekly readings |
| 3 | Frontier labs keep their demand share | Measured: the six labs' combined share of every OpenRouter token, trailing 7 days | 20.7% (week to 2026-11-01), against a high of 29.4% (week to 2026-08-17) and a low of 17.0% (week to 2026-10-05) | It stays 30% or more below its 90-day high for 4 straight weekly readings |
| 4 | The physical buildout continues | Measured: open physical-infrastructure roles, summed across labs with a usable hiring feed | 196 (xAI 172, Anthropic 24, OpenAI 0), 5% below the 206 of 2026-10-24. Google and Meta have no public feed; Mistral's feed has stored nothing yet | The count falls 40% or more from its 90-day high |
| 5 | Rented compute demand keeps growing | Measured: CoreWeave quarterly revenue against the same quarter a year earlier, from SEC filings | Q2 2026: $2,575M, up 112% on Q2 2025 ($1,212M); Q1 2026 up 112% | Growth is below 30% for 2 straight quarters |
| 6 | Data-center power keeps coming online | Measured: Epoch AI's estimate of current power across the AI data centers it tracks, held from one dataset update to the next | 15,078 MW across 96 sites (Epoch, updated 2026-11-01; first stored 2026-11-04) | 20% or more below its 180-day high for 4 straight weekly readings |

## Method

- **Blended price.** (3 × input + 1 × output) ÷ 4, in USD per million tokens, at each lab's standard-tier list price for its mapped flagship. The flagship is the price matrix's flagship cell: the model the vendor's own page names as the place to start (`layers/terminal/server/utils/terminal-classes.ts`, with the judge's re-mappings laid over it). A lab with no mapped flagship, or a mapped one with no input and output price, is left out and named.
- **GPU price.** The on-demand list price of an NVIDIA H100, in USD per GPU-hour. An instance price is divided by its GPUs. Only SXM/HGX boards count, plus rows that name no form factor (Crusoe, Oracle). PCIe and NVL cards are stored and not counted, so the median compares the same board across providers. Reserved, spot, preemptible, dedicated-endpoint and multi-week cluster prices are other products and are not read.
- **Median.** Each provider counts once, at the median of its own counted rows (sizes, configurations, regions). The reading is the median of those provider values. Azure's 82 regional SXM rows are one vote, like Crusoe's single row.
- **Quorum.** Claim 1 needs at least 5 H100 providers with a price that day. With fewer, the reading is stored, marked void, and the claim is unresolved; a void reading never feeds the 26-week high.
- **B200.** The same ratio over the B200 median is recorded beside claim 1 and never read by its rule.
- **Sources.** Every number is stored with its source URL and fetch time: list prices in the price tables, GPU prices in `recipe_observations` (one recipe per provider, `layers/terminal/server/theses/recipes/gpu-*.ts`), raw bytes in R2. The audit, terms and exclusions are in [`docs/source-audit.md`](../source-audit.md) and `sources.yaml` (`recipe_sources`, `cut`).

## How the status is set

- Claims 1–3 use a sustained drawdown: each weekly checkpoint (the newest reading, then one 7, 14 and 21 days back) is compared with the high of the window before it. Broken when all four sit 30% or more below; weakening once one does, or once the newest is half way (15%).
- Claim 4 compares the newest count with its 90-day high: broken at a 40% drop, weakening at 20%.
- Claim 5 reads quarters: broken when the two newest are both below 30% growth, weakening when one is.
- **History.** A claim is unresolved until its window is full, and its status says how much history it has and how much it needs. Claims 1–3 need the window plus the three weeks their checkpoints reach back: 203 days for claim 1, 201 for claim 2, 111 for claim 3. Claim 4 needs 90 days. Expected first resolutions: claim 4 around 2026-11-23, claim 3 around 2026-12-05, claims 1 and 2 around late May 2027. Claim 5 resolves now.
- **No backfill.** GPU prices and flagship prices start on the first run. The pages cannot be re-fetched as they were, and the class map is code, not a stored history. Claims 3 and 4 are rebuilt from the rankings and job history the terminal already holds (from 2026-08-10 and 2026-08-25).
- **New flagships are ordinary readings.** When a lab's mapped flagship changes, the reading records the change ("OpenAI gpt-6-astra → …") and the thesis page notes it in the readings table, so a step in the series can be explained. The step itself counts.

## Assumptions

- A flagship list price is a fair proxy for what a lab can charge at the frontier. It is not: volume discounts, batch tiers and enterprise contracts are lower, and the mix of tokens sold is not 3:1 everywhere.
- The public on-demand price of an H100 tracks what compute costs. Labs mostly buy on multi-year contracts or own their capacity, so this is the price a marginal renter sees, not the labs' own cost.
- A lab's flagship is served on hardware comparable to an H100. Newer models run on newer GPUs (B200, GB200), which is why the B200 ratio is kept beside it.

## Limits

- **Claim 1 is a price relationship, not a margin.** It assumes no throughput (tokens per GPU-hour) and no serving cost. A falling ratio can mean pricing power is going, or that tokens got cheaper to serve and the lab passed it on. The ratio does not separate the two.
- **List prices, not transaction prices.** At the audit, Vast.ai's marketplace listed H100 SXM offers at a median of $2.40 per GPU-hour, against the first-party median of $4.50. Spot, reserved and negotiated prices sit below the list.
- **The provider set is what passed the audit**, not the market. AWS (its price file is 482 MB, over the fetch cap), Google Cloud (client-rendered page, keyed API) and RunPod (terms bar scrapers) are cut. Azure ($14.38) and Oracle ($10.00) list far above the neoclouds, so the median sits among the neoclouds. A provider dropping out moves it.
- **One page each.** A redesign fails that provider's recipe, which is flagged in the ops digest and shown on `/data`; it is left out of that day's median, never carried forward. Below five H100 providers, claim 1 is unresolved.
- **OpenRouter is one aggregator's traffic, not market share.** Claim 3 sees developer traffic routed through OpenRouter, not direct API or enterprise volume. The daily rankings list the top 50 models and fold the rest into one "other" row, so a lab model outside the top 50 counts as not-a-lab: the share is a lower bound. A kill there prompts a revision, not a verdict.
- **Claim 3 starts near its kill line.** The first reading is 29.5% below the 90-day high of the week to 2026-08-17 and has been lower (42% below at 2026-10-05). The rule needs 111 days of history before it can break, and 2026-08-17 leaves the 90-day window on 2026-11-15.
- **Hiring feeds cover five labs.** OpenAI, Anthropic, xAI, Mistral (reporting since 2026-11-02) and, from 2026-11-04, Google DeepMind: the DeepMind rows of Google's careers feed, where the `HARDWARE_ENGINEERING` category counts toward the cluster. Meta has no usable public feed, and its roles are not imputed. xAI's board is blended with SpaceX (every row says SpaceXAI) and supplies most of the count, so claim 4 mostly reads xAI's data-center hiring. A lab joining steps the sum up from its first day; a feed that stops reporting steps it down. Either shows in the reading's per-lab breakdown, which is read before a fall is taken as evidence. The cluster's department terms are in `sources.yaml` (`department_clusters`).
- **CoreWeave stands alone.** Nebius files under IFRS (no us-gaap revenue tag to read), IREN's revenue is mostly bitcoin mining, and Applied Digital leases data-center capacity rather than renting GPUs. No comparable is shown. CoreWeave's revenue is concentrated in a few customers, including labs this thesis is about.
- **Claim 6 is Epoch's estimate, and starts unresolved.** 80% of Epoch's power estimates fall within a factor of 1.4; coverage starts with sites operational in 2024 or later, so older fleets are missing. Epoch also revises and adds sites, so the total can step either way on an update. The rule needs 180 days of stored history behind four weekly readings, so the claim cannot break before about 2027-05-29. It was added on 2026-11-04, after the other claims, with the first reading in view.
- **Mistral has no flagship.** Its docs name no start-here model (`CLASS_GAPS`), so claims 1 and 2 read five labs.

## Revisions

| Date | Change | Reason |
| --- | --- | --- |
| 2026-11-02 | Opened | Third thesis; the first about a group of companies rather than one |
| 2026-11-04 | Claim 6 added: Epoch AI data-center power | A supply number beside claim 4's hiring proxy, from the dataset audited that day (`docs/source-audit.md`) |
| 2026-11-04 | Claim 4 reads Google DeepMind's roles too | Google's careers feed became a usable source (`google-careers`, DeepMind rows only); claim 4 sums every lab with a feed, so its count steps up from DeepMind's first poll. The kill condition is unchanged |
