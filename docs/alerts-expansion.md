# Alerts for the new datasets

A plan for six candidate alert sources, approved by the owner, ending with a recommended order.
Figures were read from production on 2026-11-20.

Built: step 1 (the `exposure` axis and the `filed_fact` track-record terms), step 2
(candidate 1, hyperscaler lab facts), step 3 (candidate 2, capex against guidance) and step 5's
median half (candidate 4, the GPU median rule on the `compute` axis), step 4 (candidate 3,
the `deal-score-floor` rule, below) and step 6 (candidate 6, the `supplier-passage-floor` rule,
below). Left: single-provider GPU moves (waiting for a judge block) and latency strain (5).

## How alerts work today

An alert cites one or more change rows. A change row is a diff between two reads of a source,
with the source URL and fetch time of the read that found it. Alerts come from two places.

- **Rules.** Code in the Worker writes the alert with no model in the loop. A rule's headline
  and explanation are built only from the row it cites.
  - `s1-floor`, `periodic-floor` and `cik-resolved`: `layers/companies/server/pipeline/filing-floors.ts`
  - `prospectus-floor`: `layers/companies/server/pipeline/prospectus-floor.ts`
  - `model-floor`: `layers/models/server/pipeline/model-floor.ts`
  - `hiring-rollup`: `layers/talent/server/pipeline/hiring-rollup.ts`
  - `filed-fact-floor`: `layers/companies/server/exposure/alerts.ts`
  - `guidance-floor`: `layers/companies/server/exposure/guidance-alerts.ts`
  - `gpu-median-floor`: `layers/compute/server/pipeline/gpu-median-floor.ts`
  - `supplier-passage-floor`: `layers/companies/server/suppliers/alerts.ts`, through the
    recipe-observation writer, run when the judge's supplier readings are stored. Candidate 6.
  - `adoption-floor`, `datacenter-floor`, `limits-floor`, `pay-floor`: the recipe-observation rules,
    below. One writer (`layers/core/server/pipeline/observation-alerts.ts`), one rule file per
    domain, all run by `layers/terminal/server/pipeline/observation-alerts.ts` on the survey tick.
  - `deal-score-floor`: `layers/press/server/pipeline/deal-alerts.ts`, through the same writer and
    on the same tick. Below the recipe-observation rules.
- **The judge.** The hourly routine reads `GET /api/judge/pending` (change rows since its last
  run) and sends back severity, headline and explanation. The Worker gates every field
  (`layers/core/server/pipeline/judge/`). It can only lower a severity
  (`layers/terminal/server/pipeline/judge/severity-gates.ts`, the hiring floor), and every
  number in the text must be in the cited rows.

Severity is `info`, `notable` or `critical`. `notable` and `critical` are the alert tier
(`layers/core/shared/utils/terminal-tiers.ts`). The alert tier leads the home page and
`/alerts`, goes in the Atom feed and reaches licensee webhooks by their `min_severity`.
`critical` also posts to X and Bluesky (`layers/alerts/server/pipeline/social.ts`).

Of the 894 alerts on file (since 2026-08-25), the judge wrote 840, 125 of them in the alert
tier. Rules wrote 54, and 53 of those are in the alert tier. So the judge decides most of
what is minor, and rules carry most of what must never be missed.

Each alert sits on one axis (`AXIS_DISPLAY`), read from the entity type of the rows it cites
(`ENTITY_AXIS` in `layers/alerts/shared/utils/terminal-labs.ts`).

The track record (`/alerts`, Track record tab) takes every alert-tier alert since 2026-09-08.
It searches GDELT's press files and the labs' newsrooms with terms built from the cited rows
(`termsOf` in `layers/press/server/pipeline/track-record/terms.ts`). The judge rates each
candidate as the same event or not. On 2026-11-20: 29 press matches, 18 of them after our
alert, median lead 0.5 hours. An entity type with no case in `termsOf` is `not-searchable`.

Every new alert source adds its entity type to `ChangeView`
(`layers/alerts/shared/types/alerts.ts`), an `ENTITY_AXIS` entry and a `termsOf` case, or says
why it has none. It deletes its `alerts` waivers from the surfaces gate's waiver file in the
same PR.

## The recipe-observation rules

Built for the five waivers that read "recipe observations raise no alert". Every rule compares the
newest read of a recipe with the one before, never walks history (so a first run over stored rows
alerts on nothing), ids hash the rule, entity and period (so a re-run writes nothing twice), and
writes only `notable`: never `critical`, which posts to X and Bluesky. Each cites one change row of
its own entity type (`adoption_series`, `data_center`, `rate_limit`, `pay_band`), kept from the
judge and `not-searchable` in the track record.

| Rule | Axis | Alerts when | Noise it avoids |
| --- | --- | --- | --- |
| `adoption-floor` | demand | A complete week of an npm or PyPI lab package, or of a coding agent's public PRs, moves 25% or more and 3 times its median move over the earlier 8 weeks; or a Ramp vendor's month moves 2 points or more and 3 times its monthly median | Partial weeks, retrospective (counted-after-the-fact) weeks, a series under 4 earlier changes, a week under 1,000, a series that has gone quiet |
| `datacenter-floor` | compute | An Epoch AI site of 100 MW or more appears, or a site's current power moves 25% and 50 MW | Removals and renames (Epoch edits names), small sites, owner and user edits |
| `limits-floor` | pricing | A published limit present in both snapshots moves 10% or more, or goes to or from no limit; one alert per model | New and retired models and tiers (a new model is a `model-floor` alert), prose rows |
| `pay-floor` | hiring | A cell's 7-day median of posted pay holds a move of 5% or more against the 7 days before, every day of one window beyond every day of the other, on 30 bands or more | A median that flips as one role opens or closes; a lasting move alerts once in 14 days |

Posted-pay and the recipe's other stored rows are written only on a day a cell changes, so the pay
rule carries the last stored day forward. `parents` is not a rule: the same investee facts alert
as `filed-fact-floor` series, so its waiver is `covered`.

## The deal-score rule

Candidate 3, built 2026-11-24. When a filing scores press reports of a deal's size (the deal half
of `/ground-truth`, `scoreDeal`), one `notable` alert per filed figure states the figure and each
report's error, a match and a miss alike. It cites one `deal_score` change row (revenue axis,
kept from the judge, `not-searchable` in the track record) carrying the figure, the report count,
the median error and the earliest report.

A report counts only when the figure was first filed in the last 14 days, the judge labeled the
report on an earlier day than the filing, and the report came at most 365 days before it. The
second condition is the flood guard. A headline read back from GDELT's archive, or read again
for deals, is labeled after the filings that score it, so a backfill alerts on nothing, and the
rule's first run over stored deals alerts only on a filing from its last 14 days. One filing
that scores many headlines is one alert. Ids hash the measure, period and accession.

Two departures from the plan below. Restated reports don't alert: a headline that repeats a
filed figure is the press repeating the filing. And the rule reads the same `reported_figures`
table `/api/reported` serves, so it closes that route's `alerts` waiver (`AXIS_ROUTES` on
`revenue`). Revenue headlines scored against a lab's own filing still raise no alert of their own.

## The candidates

### 1. Hyperscaler filed facts about a lab

Built, in `filed-fact-floor`. The lab series that are commitments or claims on a lab alert
beside the capex and backlog series.

### 2. Capex against guidance

Built, as `guidance-floor` (the `guidance` and `guidance_check` entity types).

### 3. A deal headline scored against a filing

- **Change row.** The ground-truth page already scores press reports of deal sizes against the
  other company's filing (`layers/press/server/utils/terminal-ground-truth-deals.ts`). Of 43
  reports, 5 are scored and all 5 missed (median error 37%). 8 were restated, and 30 can't be
  scored yet (most name a counterparty whose filings we don't read). The alert would fire when
  a report moves from open to scored, and the change row is that transition: the report, the
  filed figure, the error and the days between.
- **Rule or judge.** A rule on the scoring. The judge already labels the figure in each
  headline (FIGURE REVIEW). The comparison is fixed by `DEAL_MEASURES`, so no model needs to
  weigh it again. A deal headline on its own never alerts, because we'd be repeating the press.
- **Tier.** `notable` whether or not the filing is within `TOLERANCE_PCT` of the press figure,
  because the finding is the error itself. `info` for a restated report.
- **Track record.** This candidate doesn't fit. The event is a filing, and the filing already
  has its own alert (`periodic-floor` or `filed-fact-floor`). The press story came first by
  construction, so a search would only find the article we scored. Leave these alerts out of
  the track record with a stated reason, the way a ranking alert is `not-searchable`.
- **False positives.** Medium. The press figure is a headline, read by the judge, so it can be a
  run rate, a total over years, or a rumor. `DEAL_MEASURES` keeps unlike measures apart, which
  is why 30 of 43 are unsettled. The second risk is volume: every scored report would alert,
  including old ones the first time a filer is read. Use a baseline like `filed-fact-floor`,
  so only a report scored by a filing newer than the first read alerts.

### 4. A GPU price move

The median half is built (`gpu-median-floor`). What is left is a single provider's price.

- **Change row.** GPU rental prices are thesis recipe observations
  (`layers/compute/server/recipes/gpu-prices.ts`), read every six hours on the survey tick:
  166 prices from 9 providers. A `gpu_price` change row when a provider's price for one
  configuration changes between two reads.
- **Rule or judge.** The judge, through a new block in the pending payload, because a provider
  page that drops a region or relabels a SKU looks like a price change.
- **Tier.** `info`, and `notable` for the hyperscalers (Azure, Oracle) and CoreWeave, whose
  prices a reader would quote.
- **Track record.** `not-searchable`. The GKG vocabulary keeps only rows naming a tracked lab,
  filer or model family (`layers/press/server/pipeline/track-record/mentions.ts`), and Lambda,
  Crusoe and Nebius aren't in it, so a search would be `none-found` by construction.
- **False positives.** High. Azure's 82 H100 rows come from its retail price API, and a new
  region or a spot SKU can shift its rows with no price change. A 6-hour cadence also means a
  promotion can come and go between reads.

### 5. A latency strain spike

- **Change row.** `probe_days` gives each lab's strained share (rate-limited or failed probes ÷
  probes) and peak against off-peak throughput per UTC day. The probes started on 2026-11-19.
  A spike would be a `strain` change row when a lab's day crosses a threshold against its own
  trailing median.
- **Rule or judge.** A rule, but only after 28 days of history per lab. The judge adds nothing
  here, since there is no text to read and the reading is a count.
- **Tier.** `info` to start, and for a long time. `notable` only when strain lasts two UTC days
  in a row and the lab's status page shows nothing (so the alert adds what the incidents axis
  doesn't). Never `critical`: we probe through OpenRouter, so a spike may be OpenRouter's.
- **Track record.** Poor. The press covers outages, which the incidents axis already alerts on
  from status pages. Put strain on the `incidents` axis so the topic filter groups them. Mark
  the alert `not-searchable` unless it coincides with an incident row, whose alert already
  holds the record.
- **False positives.** High.
  - Every probe goes through OpenRouter, whose routing, provider fallback and own rate limits
    read as the lab's strain. A spike on most labs in the same hour is OpenRouter's, so the
    rule must require the lab to be an outlier against the other labs that day.
  - At 24 probes a day, a share moves about 4 points per failed probe.
  - A model change mid-day (`probe_days` rolls only the newest model) resets the baseline.

### 6. A new supplier passage

Built 2026-11-25 as `supplier-passage-floor`, under the second option below. The filings lane
reads each supplier's new 10-Q, 10-K and 8-K (20-F and 6-K for a foreign filer), the judge finds
the passages that tie it to a lab or a cloud, and the Worker checks each quote and figure
against the stored document (`layers/companies/server/suppliers/`). Once a run's readings are
stored, the rule writes one alert per filing that says something the company's earlier rows
didn't, citing one `supplier_passage` change row (exposure axis, kept from the judge) with the
filing, the counterparties and the lead passage. `/api/suppliers` is on the axis through
`AXIS_ROUTES`, so its waiver is gone.

A filing alerts only when all of these hold.

- It was filed in the last 14 days.
- Its passages were read from it. A row a later filing repeats word for word is restamped onto
  that filing before the judge reads it, and keeps the time it was first seen.
- The company was read before: it has hand-read rows, or a document read before the 14 days
  began. A filer added to the reader alerts nothing while its year of filings is read.
- A passage is news: a counterparty and relation no earlier row of the company had, or a figure
  no earlier row of that tie stated. Two filings read in one run that state the same new tie
  count it once, for the earlier filing.

That is the flood guard. The reader's first run read a year of filings per company, and a
re-read or a new filer does the same, but only filings from the last 14 days can alert, one
alert each. On 2026-11-25 production held 2 judge-read passages, both from filings older than
that, so the rule's first run writes nothing. Ids hash the company and the accession, so a re-run
writes nothing twice.

Tier, as planned: `info` by default, `notable` when a new passage names a tracked lab or cloud
and states a figure (dollars, shares, gigawatts or a share of revenue, each already checked to
be written in the quote). A customer the filing doesn't name stays `info`. In the track record
a lab tie is searched by the lab's names and the supplier's, and a tie to a cloud alone isn't
searched (the GKG vocabulary keeps rows naming a lab, a tracked filer or a model).

Two departures from the plan below. The rule is not a judge alert: the judge only finds the
passage, and the alert's text is built from the stored row, so the judge's own severity gates
don't apply. And a share of revenue counts as a figure for the tier, alongside dollars.

The plan, as approved:

- **Change row.** None exists yet. The filings lane reads each supplier's new filings and the
  judge reads the passages from them (`layers/companies/server/suppliers/`), checked against
  the stored document. The table started from 110 passages read by hand. What is left is the
  alert. Two options:
  - Alert on deploy, with a `supplier_passage` change row per new curated row, dated by its
    `filed` date and our `fetched_at`.
  - Send each new supplier 10-Q, 10-K and 8-K to the judge as a review block, with the Worker
    checking any quote it returns against the stored document (the `filing-review.ts`
    pattern). A passage the Worker verifies becomes a change row the same day.
- **Rule or judge.** The judge, under the second option, because finding a passage that ties a
  chip maker to a lab is reading prose, and the Worker's verbatim check holds it to the
  filing. The first option is a rule on a diff of the curated file.
- **Tier.** `notable` for a passage with a figure (a commitment, a prepayment, a share of
  revenue), and `info` for a passage that only names the lab.
- **Track record.** Under the first option these would always lag the press and the filing,
  so leave them out. Under the second they fit: the filing is the event and the search terms
  are the supplier's and the lab's names.
- **False positives.** Low under the first option (a person read it). Medium under the second.
  Supplier filings name labs in risk factors and customer lists, and the judge must tell a
  boilerplate mention from a disclosed tie. Start the judge output at `info` and let the
  Worker raise it only when the verified quote contains a dollar figure.

## Recommended order

1. **The `filed_fact` axis and track-record terms.** Built.
2. **Hyperscaler lab facts (1).** Built.
3. **Capex guidance revisions and the 10-Q check (2).** Built.
4. **Deal scoring (3).** Built (`deal-score-floor`). A rule, but outside the track record. Wait until more counterparties'
   filings are read, so it isn't mostly unsettled.
5. **GPU price moves (4).** The median is built. Single-provider moves wait for the judge
   block.
6. **Supplier passages (6).** Built (`supplier-passage-floor`), as the filing-watch option.
7. **Latency strain (5).** Not before 28 days of probes, and `info` until the OpenRouter
   cross-check has run for a month.
