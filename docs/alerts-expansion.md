# Alerts for the new datasets

A plan, approved by the owner on 2026-11-20. It covers six candidates from the surfaces plan
(workstream 4) and ends with a recommended order. Figures were read from production on
2026-11-20. Built so far: the `exposure` axis and the `filed_fact` track-record terms
(step 1 of the order), and the hyperscaler filed facts about a lab (step 2, candidate 1).
The lab commitment and claim series alert, `critical` on a series' first point or a 25% move
in a commitment or stake. A point for a period an earlier filing already reported, or a
balance that didn't move, writes nothing. Capex against guidance
(step 3, candidate 2) is the `guidance-floor` rule
(`layers/companies/server/exposure/guidance-alerts.ts`). Step 5's median half is built too, as
the GPU median rule (`gpu-median-floor`) on a new `compute` axis. Single-provider moves still
wait for the judge block.

## How alerts work today

An alert cites one or more change rows. A change row is a diff between two reads of a source,
with the source URL and fetch time of the read that found it. Alerts come from two places.

- **Rules.** Code in the Worker writes the alert with no model in the loop:
  `s1-floor`, `periodic-floor` and `cik-resolved` (`layers/companies/server/pipeline/filing-floors.ts`),
  `model-floor`, `prospectus-floor`, `hiring-rollup` and `filed-fact-floor`
  (`layers/companies/server/exposure/alerts.ts`), and `guidance-floor`
  (`layers/companies/server/exposure/guidance-alerts.ts`). A rule's headline and explanation are built
  only from the row it cites.
- **The judge.** The hourly routine reads `GET /api/judge/pending` (change rows since its last
  run) and sends back severity, headline and explanation. The Worker gates every field
  (`layers/terminal/server/pipeline/judge/`). It can only lower a severity
  (`severity-gates.ts`, the hiring floor), and every number in the text must be in the cited
  rows.

Severity is `info`, `notable` or `critical`. `notable` and `critical` are the alert tier
(`layers/core/shared/utils/terminal-tiers.ts`). The alert tier leads the home page and
`/alerts`, goes in the Atom feed and reaches licensee webhooks by their `min_severity`.
`critical` also posts to X and Bluesky (`layers/alerts/server/pipeline/social.ts`).

Of the 894 alerts on file (since 2026-08-25), the judge wrote 840, 125 of them in the alert
tier. Rules wrote 54, and 53 of those are in the alert tier. So the judge decides most of
what is minor, and rules carry most of what must never be missed.

Each alert sits on one of seven axes (`AXIS_DISPLAY`), read from the entity type of the rows
it cites (`ENTITY_AXIS` in `layers/alerts/shared/utils/terminal-labs.ts`).

The track record (`/alerts`, Track record tab) takes every alert-tier alert since 2026-09-08.
It searches GDELT's press files and the labs' newsrooms with terms built from the cited rows
(`layers/press/server/pipeline/track-record/terms.ts`). The judge rates each candidate as
the same event or not. Today: 29 press matches, 18 of them after our alert, median lead 0.5
hours. An entity type with no case in `termsOf` is `not-searchable`.

## A gap the existing rule already has

`filed-fact-floor` shipped on 2026-11-04. It writes a `filed_fact` change row and one
`notable` alert when a new 10-Q or 10-K moves a hyperscaler series. It has not fired yet. The
October 10-Qs were read as its baseline. Three things are missing, and every candidate below
needs the same three:

1. `filed_fact` isn't in `ChangeView`'s entity types
   (`layers/alerts/shared/types/alerts.ts`), so `ENTITY_AXIS` has no axis for
   it. Its alerts can't be found by `/alerts?topic=`, and `alertAxis()` returns nothing.
2. `termsOf` has no `filed_fact` case, so these alerts are `not-searchable` in the track record.
3. The surfaces gate (#469) waives `/api/exposure` as `covered:` until the axis exists.

Fix these first, in one PR, with a new `exposure` axis (`AXIS_PATH` `/exposure`). Every
candidate after it then adds an entity type, an axis entry and a `termsOf` case, or says
why it has none.

## The candidates

### 1. Hyperscaler filed facts about a lab

- **Change row.** The `filed_fact` row `filed-fact-floor` already writes. Today only four lab
  series alert: Microsoft's gain or loss on OpenAI, Amazon's upward marks on its Anthropic
  stock (`ALERTING_LAB_CONCEPTS`), and the capex and total backlog series. The proposal adds
  the lab series that are commitments or claims on a lab:
  - Microsoft's funding commitment to OpenAI ($13B) and funding paid in ($12B)
  - Microsoft's receivables from OpenAI ($7.2B) and revenue from OpenAI ($10B)
  - Microsoft's ownership stake (24%)
  - Amazon's financing line to Anthropic ($20B maximum, $15B available now)
  - the commitment Anthropic added to Amazon's backlog ($100B)
  - Amazon's backlog from OpenAI ($38B at 2026-03-31)
  - Alphabet's backlog from Crux AI ($16.8B)
- **Rule or judge.** A rule. Add those series to the alerting set (`alert: true` in
  `SERIES_DEFS`, or the concept to `ALERTING_LAB_CONCEPTS`). The headline is a template
  per series group, as `headlineFor` does now.
- **Tier.** `notable` by default, as now. `critical` for the first point of a series (a filer
  names a lab in a new line for the first time), or when a commitment or stake changes by 25%
  or more against the previous point.
- **Track record.** Add a `filed_fact` case to `termsOf`: the filer's name, the lab's name and
  earnings words. The same filing already raises a `periodic-floor` alert on the 30-minute EDGAR
  tick. The fact alert follows when the instance is read, on the same tick or a later one.
  Expect leads on the lab line and lags on the headline earnings numbers, which wires
  cover within minutes.
- **False positives.** Low. These are the filer's own tagged figures. The risks are tags:
  - A series moves because the filer re-tagged a concept or changed a dimension.
  - A restatement reads as a move. `superseded` handles that on the page, and the rule should
    skip a point whose only change is a restated earlier value.
  - A backlog falls as a contract is delivered and reads as a cut. The backlog headline should
    say "falls to" without "cut" or "cancels".

### 2. Capex against guidance

- **Change row.** A new `filed_guidance` row for a filer and fiscal year, against that filer's
  previous row for the same year. Meta has guided 2026 four times: $115–135B (January),
  $125–145B (April), $130–145B (July) and $135–145B (October). Amazon moved from $200B to $220B.
  A second row type compares each 10-Q's year-to-date capex (the capex series) with the newest
  guidance, and says what the rest of the year has to be to stay inside it. Both would be new
  entity types (`guidance`, `guidance_check`), written only as the change an alert cites, like
  `filed_fact`.
- **Rule or judge.** A rule. The guidance reader (`layers/companies/server/exposure/guidance.ts`)
  keeps the release's own sentence, so the headline can quote it. The comparison uses the same
  `GUIDANCE_MEASURES` the ground-truth page uses
  (`layers/companies/server/utils/terminal-ground-truth-guidance.ts`). A filer we can't score
  there (Amazon guides a net figure we don't hold) gets the revision alert and no comparison
  alert.
- **Tier.** A raised or cut range is `critical`. It moves the AI capex story on the day.
  Restating the same range is `info`. A 10-Q check is `notable` when the implied rest of
  year sits outside the range, and `info` when it sits inside. The 10-K verdict (met, above or
  below) is `notable`.
- **Track record.** The release is an 8-K exhibit read on the EDGAR tick, every 30 minutes. The
  press reads the same release off the wire, often in the same minute. Expect mostly ties and
  lags of up to an hour on revisions. That is a fair test, and the track record should show
  it. The 10-Q check is ours alone (the press rarely does the subtraction), so it will mostly be
  `none-found`, which is the right answer. Add a `termsOf` case: the filer, "capex" or "capital
  expenditures", and "guidance" or "outlook".
- **False positives.** Medium on revisions. A release can print guidance for two fiscal years,
  or a "roughly" figure beside a range. The reader takes the first sentence per year, so a
  second sentence restating it differently could read as a change. Gate it the way
  `filing-review.ts` does: the Worker must find the sentence verbatim in the stored exhibit, and
  a revision needs a different low or high. Low on the 10-Q check, which is arithmetic on filed
  figures.

### 3. A deal headline scored against a filing

- **Change row.** The ground-truth page already scores press reports of deal sizes against the
  other company's filing (`layers/press/server/utils/terminal-ground-truth-deals.ts`). Of 43
  reports, 5 are scored and all 5 missed (median error 37%). 8 were restated, and 30 can't be
  scored yet (most name a counterparty whose filings we don't read). The alert would fire when a report moves from open to scored,
  and the change row is that transition: the report, the filed figure, the error and the days
  between.
- **Rule or judge.** A rule on the scoring. The judge already labels the figure in each
  headline (FIGURE REVIEW). The comparison is fixed by `DEAL_MEASURES`, so no model needs to
  weigh it again.

  The press side stays as it is. A deal headline on its own never alerts, because we'd be
  repeating the press.
- **Tier.** `notable` when the filing is within `TOLERANCE_PCT` of the press figure, and also
  when it isn't. The finding is the error itself, so a large miss reads the same as a match.
  `info` for a restated report.
- **Track record.** This is the one candidate that doesn't fit. The event is a filing, and the
  filing already has its own alert (`periodic-floor` or `filed-fact-floor`). The press story
  came first by construction. Searching for the press would only find the article we scored.
  Leave these alerts out of the track record with a stated reason, the way a ranking alert is
  `not-searchable` today.
- **False positives.** Medium. The press figure is a headline, read by the judge, so it can be a
  run rate, a total over years, or a rumor. `DEAL_MEASURES` keeps unlike measures apart, which
  is why 30 of 43 are unsettled. The second risk is volume. Every scored report would alert,
  including old ones the first time a filer is read. Use a baseline like `filed-fact-floor`:
  only a report scored by a filing newer than the first read.

### 4. A GPU price move

- **Change row.** GPU rental prices are thesis recipe observations
  (`layers/compute/server/recipes/gpu-prices.ts`), read every six hours on the survey
  tick: 166 prices from 9 providers today, with an equal-weight H100 median of $4.74 per GPU-hour.
  Recipes write no change rows. The rule would write a `gpu_price` change row when a provider's
  price for one configuration changes between two reads, and one when the H100 or B200 median
  moves.
- **Rule or judge.** A rule for the median, which is arithmetic on stored rows. The judge for a
  single provider's price, through a new block in the pending payload, because a provider page
  that drops a region or relabels a SKU looks like a price change.
- **Tier.** A median move of 5% or more over seven days is `notable`, and 15% or more is
  `critical`. A single provider's list-price change is `info`, and `notable` for the
  hyperscalers (Azure, Oracle) and CoreWeave, whose prices a reader would quote.
- **Track record.** Weak. The GKG vocabulary keeps only rows naming a tracked lab, filer or
  model family (`layers/press/server/pipeline/track-record/mentions.ts`). Lambda, Crusoe and
  Nebius aren't in it, so most of these would be `none-found` by construction. Mark them
  `not-searchable` until the vocabulary is extended, so they don't count as leads the press
  never had a chance to beat.
- **False positives.** High for single providers, lower for the median. Azure's 82 H100 rows
  come from its retail price API, and a new region or a spot SKU can shift its median with no
  price change. The median rule should hold the provider set fixed across the two reads and
  skip a read where a provider failed (the `failed` list in `/api/gpu-prices`). A 6-hour cadence
  also means a promotion can come and go between reads.

### 5. A latency strain spike

- **Change row.** `probe_days` gives each lab's strained share (rate-limited or failed probes ÷
  probes) and peak against off-peak throughput per UTC day. The probes started on 2026-11-19.
  Each lab has one day and three probes so far. A spike would be a `strain` change row when a
  lab's day crosses a threshold against its own trailing median.
- **Rule or judge.** A rule, but only after 28 days of history per lab. The judge adds nothing
  here. There is no text to read, and the reading is a count.
- **Tier.** `info` to start, and for a long time. `notable` only when strain lasts two UTC days
  in a row and the lab's status page shows nothing (so the alert adds what the incidents axis
  doesn't). Never `critical`: we probe through OpenRouter, so a spike may be OpenRouter's.
- **Track record.** Poor. The press covers outages, which the incidents axis already alerts on
  from status pages. A strain alert with no incident will rarely have a same-event story. Put
  strain on the `incidents` axis so the topic filter groups them. Mark the alert
  `not-searchable` unless it coincides with an incident row, in which case the incident alert
  already holds the record.
- **False positives.** High.
  - Every probe goes through OpenRouter, whose routing, provider fallback and own rate limits
    read as the lab's strain. A spike on most labs in the same hour is OpenRouter's. The rule
    must require the lab to be an outlier against the other labs that day.
  - At 24 probes a day, a share moves about 4 points per failed probe.
  - A model change mid-day (`probe_days` rolls only the newest model) resets the baseline.

### 6. A new supplier passage

- **Change row.** None exists yet. Since 2026-11-20 the filings lane reads each supplier's new
  filings and the judge reads the passages from them (`layers/companies/server/suppliers/`),
  checked against the stored document; the table started from 110 passages read by hand. What
  is left is the alert. The two options as first written:
  - Alert on deploy, with a `supplier_passage` change row per new curated row, dated by its
    `filed` date and our `fetched_at`.
  - Watch the suppliers' own 10-Q, 10-K and 8-K filings and send each new one to the judge as a
    review block, with the Worker checking any quote it returns against the stored document
    (the `filing-review.ts` pattern). A passage the Worker verifies becomes a change row the
    same day.
- **Rule or judge.** The judge, under the second option. Finding a passage that ties a chip
  maker to a lab is reading prose, and the Worker's verbatim check holds it to the filing. The first
  option needs neither. It is a rule on a diff of the curated file.
- **Tier.** `notable` for a passage with a figure (a commitment, a prepayment, a share of
  revenue), and `info` for a passage that only names the lab.
- **Track record.** Under the first option, these would always lag the press and the filing.
  Leave them out of the track record. Under the second, they fit: the filing is the event and
  the search terms are the supplier's and the lab's names.
- **False positives.** Low under the first option (a person read it). Medium under the second.
  Supplier filings name labs in risk factors and customer lists, and the judge must tell a
  boilerplate mention from a disclosed tie. Start the judge output at `info` and let the
  Worker raise it only when the verified quote contains a dollar figure.

## Recommended order

1. **The `filed_fact` axis and track-record terms.** Small, and it makes the rule we already
   have count on `/alerts` and in the track record before the next round of 10-Ks.
2. **Hyperscaler lab facts (1).** A rule on rows we already store, the lowest false-positive
   risk of the six, and the closest to what a fund asks us for.
3. **Capex guidance revisions and the 10-Q check (2).** A rule on rows we already store.
   Revisions are the biggest market event on this list. Build the verbatim-sentence gate first.
4. **Deal scoring (3).** A rule, but outside the track record. Wait until more counterparties'
   filings are read, so it isn't mostly unsettled.
5. **GPU median moves (4).** The median only, with a fixed provider set. Single-provider moves
   wait for the judge block.
6. **Supplier passages (6).** The deploy-diff option is cheap but adds little. The filing-watch
   option is the useful one and the most work.
7. **Latency strain (5).** Not before 28 days of probes, and `info` until the OpenRouter
   cross-check has run for a month.

Each step deletes its `alerts` waivers from the surfaces gate's waiver file in the same PR.
