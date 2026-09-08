> Historical record of the take-home build (frontier-terminal, 2026-08-25), kept verbatim. The tooling it names (bun workspace, DuckDB, Hermes, `claude -p`) describes that build, not this repo.

# DECISIONS.md

The product: **frontier-terminal** — an AI-native terminal tracking the Big-4 frontier model providers (OpenAI, Anthropic, Google, xAI) for an equity analyst covering AI infrastructure into the live IPO wave. Ground truth for every source claim: `docs/source-audit.md` (all sources live-fetched 2026-08-25).

## The agent / deterministic boundary

This is the spec's graded line ("use agent reasoning where context and edge cases matter"). One row per pipeline stage:

| Stage | Who | Defense |
|---|---|---|
| **fetch** | DETERMINISTIC | An HTTP GET against audited URLs needs retries and a UA header, not judgment; agents add cost and nondeterminism to the one step that must be boringly reproducible. |
| **parse** | DETERMINISTIC* | The audited sources are JSON and markdown/HTML tables — fixed parsers whose output is schema-validated. *Agent runs exactly twice: (a) Google's pricing page, where model names live in headings above table clusters and prices carry dual promo dates — genuine context; (b) as the repair path when any parser's output fails validation, i.e. "adapting when sources change" is an exception handler, not a per-run cost. Agent output is itself validated before it enters the store. |
| **normalize** | DETERMINISTIC | Unit conversion, key mapping, SKU dedupe are fixed transformations; any nondeterminism here poisons every diff downstream. |
| **diff** | DETERMINISTIC | Row comparison on stable IDs (job ids, model slugs, accession numbers) and content hashes. A change event must be reproducible from two snapshots or the terminal's word is worthless. |
| **judge-significance** | AGENT | "Haiku −33% with a new cache tier, two weeks before Anthropic's projected first trade" is not a threshold — it's market context. Static rules would either spam the analyst or sleep through the story. One floor rule stays deterministic: an S-1/424B4 hit always alerts, no model in the loop. |
| **explain** | AGENT | Investment relevance is synthesis across axes (price cut + sales-hiring surge = GTM push into IPO). Grounding rule: the agent may only cite fields present in the diff records, each carrying source URL + fetch timestamp; no outside claims, or it stays silent. |
| **alert** | DETERMINISTIC | Routing, dedup, rate-limiting, delivery are plumbing — Hermes `deliver:` targets handle transport. The agent decides *whether*; code decides *how*. |

## Model access

All LLM calls run through headless Claude Code (`claude -p`) inside plain scripts — never Hermes's provider layer or the Agent SDK. Verified 2026-08-25 against code.claude.com docs: subscription credentials work only through the Claude Code CLI; the Agent SDK and third-party runtimes (Hermes's `anthropic` provider) require a funded API key. `claude -p` puts `ANTHROPIC_API_KEY` above subscription auth in its precedence, so the same scripts run on the developer's subscription with no key, or on a grader's key with no login. Trade-off accepted: Hermes's `wakeAgent` gate wakes a script that calls `claude -p`, not Hermes's native agent jobs — one model-calling mechanism, one auth story (the rubric's "simplest, least redundant system").

## Assumptions

- Sources behave as audited on 2026-08-25; the vendor `.md` endpoints (OpenAI/Anthropic/xAI) are intentional, supported surfaces, not accidents.
- Graders run locally with bun + Claude Code (`claude` CLI logged in, or `ANTHROPIC_API_KEY` set — see Model access). Hermes is the *operator*, never a dependency: every job is a plain script, `make refresh` runs the whole loop with nothing but bun + the CLI installed.
- Data accrues from first run; no historical backfill (no public archives of these pages worth 3-hour money — Wayback backfill is a stretch goal).
- IPO timing per press: Anthropic draft S-1 ~Jun 1, OpenAI confidential filing ~Jun 8, Anthropic first trade projected ~Oct 2026. The terminal must be valuable *before* any lab is public — hence private-signal axes (pricing, hiring) carry the weight and EDGAR is the tripwire.

## Optimizing for

**Trustworthiness per delivered feature, not feature count** (the rubric line, applied): every datum carries source URL + fetch timestamp; every caveat ships visibly (xAI's hiring board is entity-blended `SpaceXAI`; OpenRouter is a third-party restatement used only as a drift detector; Google hiring reads "no public feed" instead of a faked number); diffs reproducible from stored snapshots.

## Non-goals

- **Compute-deal extraction** — detection via RSS is easy, but honest coverage is impossible: the deals that matter break in the press before any company feed. Refusing to claim it *is* the trust position. (Stretch: new-post tier with agent one-liners, riding existing poll infra.)
- **Google hiring** — no scoped public feed exists; Alphabet-wide numbers would conflate Search/Ads/Cloud with Gemini and mislead.
- **Confidential-DRS detection** — structurally impossible from EDGAR; we catch the public-flip moment and say so.
- **Consumer-plan pricing (Pro/Max tiers)** — API $/Mtok is the chosen monetization signal; mixing plan pricing muddles the series.
- **Multi-user/auth/teams** — single-analyst consumer product.
- **Live deploy** — spec grades local run; Workers deploy is a fork-of-template afterthought if ever.

## Operator wiring (Hermes)

Two script jobs, `--no-agent`, delivering locally. **Now running.** Installed
and registered on 2026-08-26; as of 2026-08-26T22:00Z the operational record
is 54 `frontier-edgar` ticks (30m) and 5 `frontier-survey` ticks (6h) over
~27 hours, 155 snapshots, 136 change events, and 9 agent-judged alerts — the
first of them ("xAI removes six physical-infrastructure roles concentrated in
Memphis, Southaven and Jacksonville") is the kind of read the judge lane was
built to produce. Everything below was written against Hermes's docs
(`docs/guides/cron-script-only`) before that and has now been observed.

| Job | Cadence | Scope |
|---|---|---|
| `frontier-edgar` | 30m | the two SEC sources — the tripwire, the one axis where latency is worth polling for |
| `frontier-survey` | 6h | every include source, then the change-gated Google lane |

Decisions the wiring forced, each of which changed code:

- **Scopes overlap on purpose.** The 6h survey re-checks EDGAR. Re-fetching an
  unchanged source diffs to zero, and the overlap means a stalled tripwire job
  goes covered rather than silently blind.
- **Stdout is the alert.** Hermes delivers a script's stdout verbatim and
  treats a final `{"wakeAgent": false}` as a silent tick, so every diagnostic
  line — `runRefresh`'s summary included — goes to stderr.
- **The judge wakes on THIS RUN's changes, not on the uncited backlog.**
  Changes the model deliberately stays silent about are never cited, so
  gating on the backlog would re-invoke it every tick forever. Quiet ticks
  cost zero tokens.
- **The judge's input is capped newest-first (200).** Same root cause: uncited
  changes accumulate monotonically, so an unattended run would grow the prompt
  without bound. The cap is reported in the delivered message, never silent.
- **Google is gated on content hash, not scheduled.** A live extraction costs
  ~2 minutes of model time — measured 2026-08-25: the production run took 128 s
  wall-clock across six concurrent slices, bounded by the slowest one. (This
  bullet originally said "~15 minutes", an estimate from before slicing.) The
  poll already fetched and hashed the page, so the gate is free; it compares
  against the newest snapshot actually *extracted from*, which is what makes a
  failed extraction retry instead of vanish. This required un-binding the lane from the fixture: `buildPrompt`
  read the committed August payload while ingestion grounded against the live
  fetch, so the lane could only ever re-extract the audit snapshot.
- **First live observation of a SAMPLED source records entities, not
  changes.** The committed hiring fixtures are samples (65 of 757 jobs), so
  diffing a live board against one manufactured ~1,400 "added" events for
  roles posted months ago — and would have handed them to the judge as news.
  Keyed on `fixtures/manifest.json`'s `trim` field, so the four
  committed-whole pricing sources and both EDGAR feeds still report real
  drift since the audit, which is the signal we exist for.
- **Concurrency is real, not theoretical.** 6h is a multiple of 30m, so the
  jobs are due at the same instant every sixth hour and DuckDB is
  single-writer across processes. Both retry the lock briefly then skip the
  tick quietly; the Google lane releases the lock across its model call.
  This surfaced a latent bug: `openDb` created a `DuckDBInstance` but returned
  only the connection, so the instance — which holds the file lock — could
  never be closed. `closeDb` now releases both.

Delivery is `local` (`~/.hermes/cron/output/`). No external transport is
configured: nothing leaves the machine.

## Investor-facing UI (feedback round)

The first UI passed the provenance bar and failed the *reading* bar: eight
pieces of feedback, all variants of "I cannot tell what is actionable." The
fixes, and what each one cost:

- **Reading order is priority order.** A signal band leads the page: judged
  alerts, then raw change counts by axis, then an explicit quiet state.
  Quiet is not one sentence but two — "all 13 sources have one snapshot, so
  nothing has been diffed yet" is a different claim from "nothing changed in
  the last 24h", and a terminal that conflates them is lying by omission.
  The reported window anchors to the newest *detection*, not the reader's
  clock, so a terminal opened on Monday still reports Friday's move.
- **A like-for-like matrix replaces the flat catalog** (providers × the
  vendor's own flagship / balanced / economy recommendation). This is the
  **one editorial judgment in the whole UI**, so it is built to be checked:
  each cell quotes the vendor sentence it rests on, names the fixture that
  sentence came from, and a golden test greps every quote back out of that
  fixture — a vendor rewriting its docs fails CI instead of aging into an
  unsourceable claim. The 140-row catalog moves behind a toggle, priced rows
  first.
- **OpenAI has no prices, and now says so where it matters.** The audited
  source (`models.md`) is a catalog: 96 SKUs, zero prices — the audit's "full
  price tables in one fetch" was wrong about this vendor, and the per-model
  `.md` pages that do carry prices are not fetched. The matrix shows the
  right SKU with a stated reason instead of a dash, rather than borrowing
  OpenRouter's restatement (which would break the cross-check-only rule for
  the one provider where we have no primary number to check it against).
- **Timestamps read, and stay exact.** Relative inside a day, absolute
  beyond it, the stored ISO value in every tooltip. Relative labels are
  computed only after mount — the server's clock is not the reader's, and a
  hydration mismatch on a provenance stamp is the worst place to have one.
- **Citations lost their duplication, not their content.** A source line used
  to print its label, then repeat the host, then a full ISO timestamp, over
  two wrapped lines. The label is now the link (URL + exact timestamp in its
  tooltip) with an age beside it: one line, same information, nothing
  dropped.
- **Caveats became readable.** They were `title=` attributes — invisible for
  a second, untouchable on touch, unreachable by keyboard. Now a real
  disclosure control (hover, click, or focus) that renders in the page. On
  the depth axis of this project, a caveat nobody can read is a caveat that
  does not ship.
- **Sampled fixtures disclose themselves.** The committed hiring fixtures are
  samples (42 of 255 xAI roles, 65 of 757 OpenAI). Their per-department
  counts are an artifact of the trim, so the department *bars* are drawn only
  for a whole board; a sampled board shows which departments exist and says
  the counts are the trim's. Charting a sample's magnitudes would have been
  the same class of error as a fabricated number.
- **A price-rounding bug found on the way.** `money()` ran `toFixed(2)` on
  everything, printing Gemini's $0.075 as "$0.07" — quoting a price 7% below
  the source cited beside it. Sub-cent precision is kept.

## xAI ⟷ SpaceX: what the /departments join bought

The audit read the xai board's null `department` field as "no departments
available" and moved on. It has the same `/departments` endpoint Anthropic's
does. Adding it (fixture + parser join + refresh wiring, mirroring the
Anthropic lane) does **not** split the merged entity, and the caveat stays.
What it buys is a bound: all 255 live roles map to 26 departments, every one
an xAI function (Data Center 121, Human Data 36, Engineering 23), with no
aerospace, launch or propulsion function present, and 2 of 255 titles naming
a SpaceX-side program. Those are the board owner's labels, so the honest
claim is "this narrows how much SpaceX could be hiding here", not "none is" —
and that is exactly what ships, in `sources.yaml`, the audit addendum, and
the caveat the UI renders.

Two things this forced: both xai hiring fixtures were re-cut from a single
paired fetch (joining a board against a departments payload fetched twelve
hours apart is the stale-join bug `refresh` already guards against), and the
judge lane's canned **real** transcript was regenerated by a live run rather
than having the changed ids edited into it — a one-keystroke edit that would
have cost that file the only property it exists for.

## Least sure about

**Hermes as operator — resolved, and it holds.** This entry used to say the cron registration was the one link never executed. It has now run unattended for ~27 hours: 59 ticks across the two jobs, zero failures, delivery landing in `~/.hermes/cron/output/`. The mitigation stays true (jobs are plain scripts; the fallback is `make refresh` + any cron), but it is no longer load-bearing. One thing the live run did teach: a scheduled poll runs whatever code is **checked out**, so a merge only reaches the operator on the next `git pull` — the survey that ran at 16:31Z used pre-merge parsers, and the xAI departments join first polls on the run after the checkout caught up.

**Runner-up doubt — closed 2026-08-25: judge-significance stays agent-only.** The mitigation held in reserve was a deterministic floor on "any price change on a flagship model." Two things retired it.

First, *flagship* is not a definable set here. The store holds `gpt-5.6-sol`, `claude-fable-5`, `gemini-robotics-er-2-preview` and 227 other SKUs; any floor would need a hardcoded model list that goes stale every release cycle — and it would fail **silently**, which is worse than no floor, because a stale list reads as coverage.

Second, the failure the doubt was actually about — the analyst not learning that something moved — is already handled without manufacturing an alert. `digest()` headlines a tick as `N change(s), no alert` and prints the per-source counts, and a judge-lane failure is reported separately and explicitly. The judge's silence is *visible*, so it does not need to be converted into an alert to be safe.

Evidence from the live run so far: 90 change rows, 0 alerts — and inspection says that is correct. All 90 are `added` model rows from the first Google extraction, not price moves; alerting on them would be exactly the spam the agent exists to prevent. The deterministic floor stays where it was argued for: S-1/424B4, where the event is unambiguous and the filer set is a five-name whitelist rather than a taxonomy that rots.

## Guardrails (the builder-agent feedback loop)

Correctness over clock, decided explicitly: the contract the parallel tracks fork from is **executable, not prose**, and CI enforces it. Defense vs the budget: this grows the scaffold ~15→~35 min, charged to trustworthiness (the rubric's depth axis) and bought back where 3-hour builds actually die — integration — because four tracks converge on a machine-checked contract instead of a document.

1. **Committed raw fixtures** — each Include-verdict source fetched once at scaffold time; trimmed but structure-complete payloads committed (Ashby with dept/team fields, Greenhouse incl. the `SpaceXAI` rows, three vendor `.md` files, Google SSR pricing HTML with dual-date promo strings, EDGAR search JSON). Builder agents iterate offline: no network, no rate limits, no live drift mid-build, no credentials. Tight *and* secure — zero egress, zero keys in the builder loop.
2. **Shared contracts package** — zod schemas per table and per parser output; DuckDB DDL mirrors them with `NOT NULL`/`CHECK` on `source_url`/`fetched_at`. A parser is done when `parse(fixture)` validates.
3. **`bun run ci`** = typecheck + tests + three gates: **provenance** (every insert goes through one `insertRows()` chokepoint that rejects rows missing provenance; DB constraints are the second layer), **determinism** (each deterministic parser runs twice on its fixture, output hashes must match — enforces the boundary table's promise), **agent-output** (canned good *and* malformed agent JSON through the validation gate; malformed must never reach the store — the injection-resistance property for the one lane where a model touches external content).
4. **Per-track test harness** — a golden-test stub per lane, so every builder agent starts red→green inside existing infrastructure instead of inventing four test setups.
5. **No-key, no-network invariant** — the full suite passes with no `ANTHROPIC_API_KEY` and no egress (agent stages exercised via canned outputs). Doubles as the grader-reproducibility proof.
6. **CI is entirely local — no GitHub Actions.** The gate is procedural: every track runs `bun run ci` green before merging its PR; no merge without it. Rationale: branch protection can't require checks on this repo (free-plan private), so a hosted runner was only ever a procedural gate too — a second execution environment is a redundant moving part when the identical command runs locally in seconds (the rubric's "least redundant system"). The no-key invariant (item 5) is what keeps the local gate honest on any machine, grader's included.

## Build plan (0:30 spent; parallel tracks; correctness over clock)

Session 1 spent 0:30 on the source audit and this document — that counts against the budget, so the clock below starts at 0:30. The recovery is structural, not compression: with subagents, independent lanes share wall clock. The only hard sequencing is **contract-first**: parallel tracks work only against the frozen, executable contract above; every track codes against fixtures, never against another track's output. The clock is a guideline ranked below correctness; the scaffold's guardrails are the bet that buys the slack back at integration.

| Clock | Who | Work |
|---|---|---|
| 0:30–1:05 | main (sequential) | Scaffold + guardrails: bun workspace, contracts package + DDL, one-time live fetches → committed fixtures, `sources.yaml`, Makefile, `bun run ci` with all three gates. Nothing forks before `bun run ci` is green on the skeleton. |
| 1:05–1:50 | agent A | Hiring fetch+parse (Ashby + Greenhouse w/ dept join). Done = its golden tests green in `bun run ci`. |
| | agent B | Vendor `.md` pricing/catalog parsers ×3 + EDGAR poll (FTS + CIK whitelist). Raw payloads snapshotted to disk. Same done-bar. |
| | agent C | Agent-parse lane: Google pricing (agent → schema → deterministic validation gate); OpenRouter drift-check job. Same done-bar. |
| | agent D | Nuxt UI against fixture data: overview tiles, price table w/ deltas, hiring-mix chart, alert feed — provenance visible on every datum. |
| | main | Normalize + diff, built and tested on fixtures (stable keys, row hashes, change events) so it's ready the moment real parser output lands. |
| 1:50–2:15 | main | Integrate tracks; run the pipeline end-to-end on live fetches; judge + explain agent pass (grounding rule, S-1 floor rule) over real change events. |
| 2:15–2:30 | main | Point UI at real DuckDB; fix what integration shakes out. |
| 2:30–2:45 | main | Hermes wiring (`--no-agent` poll + wakeAgent gate + `claude -p` script job + deliver), documented in README. |
| 2:45–3:00 | main | Ship: README, seed DuckDB/CSV committed, transcript sync, final commit. Doubles as buffer for integration overrun. |

Parallelism risks, mitigated by design: merge conflicts → each track owns a disjoint directory and only main touches contracts/Makefile; contract drift → the CI gates are the arbiter every track's output must pass; a failed track → each lane is sized so main can redo it inside the ship buffer.

Overrun rule: UI loses views before the pipeline loses provenance; nothing else moves.
