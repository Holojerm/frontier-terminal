# Alpha program — signal waves

## Summary

The alpha program grades every series the terminal stores against the stocks it should lead (`layers/signals`, `/signals`). The harness and scorecard exist (#686, #704). This doc lists the datasets still to register, in waves, each wave one PR. It is a draft for the owner: nothing below is built until he signs off on the list and the decisions at the end.

A graded signal is a test of understanding, not a trade. The scorecard publishes correlations and mean abnormal returns, never prices, and says "research, not investment advice" beside them. Companies under the $10B floor stay out, and no source joins without its terms checked (`docs/source-audit.md`).

## Wave 0: the price backfill (checked 2026-11-23)

**Landed.** Production's scorecard (`GET /api/signals`) on 2026-11-23 shows `tests: 999` and `prices_through: 2026-11-20`, against `tests: 0` and `2024-06-28` on 2026-11-21. In D1 (`market_bars`, read-only SELECTs):

| Dataset | Sessions | Symbols | Rows |
| --- | --- | --- | --- |
| `XNAS.ITCH` | 2018-05-01 to 2024-06-28 | 43 | 54,990 |
| `EQUS.SUMMARY` | 2024-07-01 to 2026-11-20 | 49 | 27,945 |

SPY runs 2018-05-01 to 2026-11-20 (2,153 sessions), so the calendar starts at `ITCH_FROM`. Five symbols have no Nasdaq rows because they listed after 2024-06 (ANT, CBRS, CRWV, GLXY, NBIS); their fetch rows record `rows: 0`, as intended. QQQ has no Nasdaq backfill: it is a benchmark, and abnormal returns are measured against SPY, so nothing reads it before 2024-07. The one `market_pull_failed` event (2026-11-21 06:45Z) was a Databento 504 on `EQUS.SUMMARY`; the next run filled the gap. No fix is needed.

## What a series must give the harness

From `registry.ts` › `SignalDef` and `sources.ts`:

- **A date the public could act on.** `available_after_days` after each period, or the event's own timestamp. Returns are measured from the first session after it, so a series that restates its past (Epoch's site timelines, a backfilled count) must be read as it stood then, or labelled retrospective.
- **Tickers in `MARKET_SYMBOLS`.** That list is the listed universe, already cut at the $10B floor. A counterparty outside it is dropped, not added.
- **A direction and a test.** `lead_lag` correlates each period's change with forward abnormal returns at 1, 5, 20 and 60 sessions; `event` averages the abnormal return after each event, `signed` by its value.
- **Enough history.** Lead-lag needs 20 periods in sample and 10 out; an event series needs 8 and 4. The newest third is held out.
- **A short ticker list.** Every cell is a test. The scorecard corrects for all of them at once (999 tests today, Bonferroni bar 5.0e-5), so each wave raises the bar for every series.

## The waves

| Wave | Dataset | Hypothesis (tickers, direction, horizon) | Build | Blocker |
| --- | --- | --- | --- | --- |
| 1 | Hyperscaler capex, as first filed | Capex growth leads NVDA, AVGO, AMD, ANET, up, 20–60 days | New source kind on stored `filed_facts` | None |
| 1 | Remaining performance obligations, as first filed | Backlog growth leads the filer's own stock, up, 20–60 days | Same source kind | None |
| 2 | Archived open roles (Internet Archive) | Hiring growth leads the lab's tickers, up, 20–60 days | Extend the `hiring` loader | Owner: may the harness read `basis: archived` rows |
| 2 | Archived GPU rental prices | H100 price change leads NVDA, CRWV, NBIS, ORCL, up, 5–60 days | Extend the `gpu` loader | Same |
| 2 | Archived status-page incidents | Incident count leads the lab's tickers, two-sided, 5–20 days | New `incidents` source kind | Same |
| 2 | Ramp AI Index, unregistered keys | Overall adoption leads MSFT, GOOGL, AMZN, up, 20–60 days | Registry entries only | Same PR as the archives |
| 3 | Press-reported compute deals | First report of a deal lifts the named counterparty, 1–20 days | Event dedup plus a per-event-ticker test in the harness | None, but the largest build |
| 3 | Press-reported rounds and valuations | A valuation step-up lifts the lab's stakeholders, 1–20 days | Same dedup | None |
| 4 | GitHub agent pull requests | PR volume leads the agent's lab tickers, up, 20–60 days | Registry entries | The backfill reaches its floor (mid-December) |
| 4 | Earnings-release dates | Re-dates wave 1 from the 10-Q to the release | Small EDGAR reader | None |
| Blocked | Six TWSE monthly-revenue series | Taiwan ODM revenue leads NVDA, SMCI, DELL, HPE | Registered; one month each | TWSE consent (request unsent) |
| Blocked | KCS 10- and 20-day chip exports | Early exports lead MU, NVDA | Registered; no rows | KCS petition (unsent) |
| Blocked | Cloudflare (npm `wrangler`, careers, revenue) | Developer adoption leads NET | Stored | Owner: add NET to the listed universe |

### Wave 1: SEC filed facts

`filed_facts` holds every quarter since 2017 as filed, and the filings are US government works under fair access (`docs/source-audit.md`, 2026-11-04 hyperscaler addendum). With prices from 2018-05, each filer gives about 33 quarters, enough for 20 in sample and 10 out.

- **Hyperscaler capex.** `PaymentsToAcquirePropertyPlantAndEquipment` for MSFT, GOOGL, META, ORCL; `PaymentsToAcquireProductiveAssets` for AMZN. Two series to keep the test count down: the four calendar-quarter filers summed, and Oracle alone (its quarters end a month earlier). Year-on-year log change, tested against NVDA, AVGO, AMD, ANET, the basket `guidance-capex-surprise-*` already uses. That series has 1 to 6 events per filer; this one has 33 quarters.
- **Remaining performance obligations.** `RevenueRemainingPerformanceObligation` for MSFT, GOOGL, AMZN, ORCL (2019 on), and HPE, CIEN. Quarter-on-quarter log change against the filer's own ticker, plus NVDA for the four hyperscalers. The question is whether backlog growth carries past the filing day.
- **Build.** A `filed_growth` source kind beside `filed_quarters`: facts with no member, cash-flow figures differenced from year-to-date to quarters (Q4 from the 10-K less nine months), each quarter as first filed. About 8 registry entries and their tests.
- **Caveat.** Each quarter is dated at its 10-Q or 10-K, which can trail the earnings release by a day (Alphabet, Amazon, Meta) or two weeks (Oracle). That never reads a number early, but it measures from after the release's own move, so it is conservative. Wave 4's release dates fix it.

### Wave 2: the Internet Archive histories

All three tables were filled as one-off backfills with `rights: not-cleared` (`docs/source-audit.md` addenda of 2026-11-05, 2026-11-20 and 2026-11-21). Each verdict lists what the archived rows never reach (the hiring floor, the median floor, the incident windows, alerts, the judge, theses). The harness isn't on either list, which is the owner's decision below. The harness publishes only statistics, as it does for the Databento prices.

- **Open roles.** `archived_hiring`, 2023-01 to 2026-08: Anthropic 1,152 captures, OpenAI 1,276, Google (DeepMind) 325, Mistral 476, xAI 231. Today's `hiring-open-roles-*` series start 2026-08-24 with 14 weeks and no OK cell. Read archived captures before the live history, weekly, last value, captures far apart left as gaps.
- **GPU rental prices.** `archived_gpu_prices`, 2023-05 on, mostly Lambda (455 captures), then Verda, CoreWeave, Nebius. `gpu-h100-median` starts 2026-11-02 with 4 weeks. A cross-provider median from sparse captures mixes providers week to week, so the archived part is Lambda's H100 price alone, as its own series.
- **Status-page incidents.** `archived_incidents`: OpenAI 862 from 2022-09, Anthropic 790 from 2023-03, xAI 236 from 2025-01. The probe strain series has 2 weeks. Weekly incident count per lab against the lab's tickers. The sign is open: strain can mean demand past capacity (good for the compute suppliers) or an outage that costs customers, so it is read two-sided.
- **Ramp keys.** `ramp-ai-index` stores `overall`, `deepseek` and `mistral-ai` beside the three registered labs. `overall` (any AI, share of businesses) goes against MSFT, GOOGL, AMZN. Ramp is `not-cleared` too, and already registered on that basis.

### Wave 3: press-reported figures

`reported_figures` holds headlines from GDELT (terms read, `gdelt-gkg`), back to 2023-01 since the archive scout of 2026-11-20. Stored per headline, so one deal appears dozens of times: Amazon's investment in Anthropic has 280 rows.

- **Compute deals.** `commitment` and `investment` rows whose counterparty maps to a ticker in `MARKET_SYMBOLS`: Oracle, CoreWeave, AMD, Nvidia, Amazon/AWS, Microsoft, Alphabet/Google, Dell, Akamai, TeraWulf, Meta, TSMC. The event is the first headline per (lab, counterparty, metric) after 30 days without one. SoftBank, Disney, Tesla, Lambda, Nscale and SB Energy fall outside the universe. Each counterparty has only a few deals, so the test pools them: the abnormal return of each event's own counterparty. The harness tests a fixed ticker list per series today, so this needs a per-event ticker.
- **Rounds and valuations.** `funding` and `valuation` rows per lab, signed by the step from the last reported valuation, against the lab's tickers (MSFT for OpenAI, AMZN and GOOGL for Anthropic). Same dedup, no harness change.
- **Why third.** The dedup decides what an "event" is, and the scorecard inherits that choice, so it deserves its own review.

### Wave 4: waiting on time or a small fetcher

- **GitHub agent pull requests.** `github-prs-claude-code`, `-codex` and `-jules` are walking back to their launch floors (2025-02-24, 2025-05-16, 2025-05-20) at about 24 days a day from 2026-11-20, done around mid-December. Then weekly sums against each lab's tickers: three entries. Rows are retrospective counts and `not-cleared`, so this shares wave 2's rights decision.
- **Earnings-release dates.** The `8-K` item 2.02 date for each quarter from EDGAR submissions, a source already read, so wave 1 can be dated at the release.

### Not testable yet

- **Epoch AI data centers** (CC BY 4.0, 2018-12 on). The timelines are today's knowledge of past build-outs, and vintages are stored only from 2026-11-04. Testing it now would read the future. It becomes testable once a year or so of vintages exist.
- **GDELT mention volume.** Mentions are pruned after 15 days (`MENTION_RETAIN_DAYS`), so no history accrues. A daily count per lab would have to be kept first.
- **Posted pay, rate limits for the other labs, newsrooms, CoreWeave active power, Alphabet tokens.** Weeks to quarters of history; the registered ones grade themselves as they grow.

### Cut, and why

Kalshi, Polymarket, Ornn, AWS Capacity Blocks, Vast.ai, Vercel's leaderboards and Artificial Analysis are cut on their terms (`docs/source-audit.md`). AWS and Azure spot history need a signed-in account. Fastly is under the floor.

## Decisions for the owner

1. **The list and its order.** Wave 1 first, on SEC facts alone.
2. **Archived rows in the harness.** May the harness read `basis: archived` rows (hiring, GPU prices, incidents) and the retrospective GitHub counts, publishing only statistics? Wave 2 and part of wave 4 wait on it.
3. **The test budget.** Every wave raises the bar for all 141 series. Keep one family across the scorecard, or correct per wave?
4. **NET.** Add Cloudflare to the listed universe (and the Databento pull), so its stored series can be graded?
5. **What a press "event" is.** The 30-day dedup window, and whether wave 3's pooled counterparty test is worth a harness change.
6. **The two unsent requests.** TWSE consent and the KCS petition stay his to send; until then their series stay registered and empty.
