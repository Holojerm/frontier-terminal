# Routines Configuration

Repo-specific values for the cloud routines. Routines treat placeholder values as "not
configured" and skip the dependent work (journaling the gap).

| Key | Value |
| --- | --- |
| Product name | Frontier Terminal |
| Production URL | `https://frontierterm.com` |
| Owner name | Jeremy Ettlinger |
| GitHub repo | Holojerm/frontier-terminal |
| Analytics sources | Cloudflare Workers analytics for the production Worker |

## Autonomy grants

Routines above tier 1 act only where they are listed here (`_shared.md` › Autonomy tiers).
Delete a line to take the grant back.

| Routine | Tier | Granted on |
| --- | --- | --- |
| ops-triage | 2 | 2026-11-03 |
| dependency-merge | 2 | 2026-11-03 |

## Mechanical fixes

The failure classes a tier-2 routine may fix and merge itself (`_shared.md` › Mechanical
fixes). The paths are globs, and the fix may touch nothing else.

| Routine | Failure class (ops `kind` + cause) | Paths the fix may touch | Done-bar beyond `_shared.md` |
| --- | --- | --- | --- |
| ops-triage | `source_failed` / `recipe_failed` repeating across polls because the vendor moved or reshaped the page (a redirect or 404 to a new URL, a renamed header, a new table or markup format). #117 is the worked example. | `layers/terminal/server/pipeline/parsers/**`, `layers/terminal/server/theses/recipes/**`, `fixtures/**`, `sources.yaml` (only the failing source's URL and notes), `docs/source-audit.md`, `layers/terminal/test/**` | Re-capture the fixture from a live fetch and record the fetch time in `fixtures/manifest.json`. The parser's output on the new fixture must keep the old fixture's entity keys, and any value that changed must be quoted from the new page in the PR body. Class-map sentences are the next row's job. |
| ops-triage | `class_basis_stale` / `class_basis_still_stale` (and the `judge_rejected` events that come with them): a price-matrix cell whose vendor sentence left the page, and the judge could not re-map it | `layers/terminal/server/utils/terminal-classes.ts` (only the stale cell's `MODEL_CLASS_MAP` entry), `fixtures/pricing/**`, `fixtures/manifest.json`, `layers/terminal/test/**` | Re-fetch the page `CLASS_MAP_SOURCES` names, and re-capture its fixture with the fetch time in `fixtures/manifest.json`. The new basis must be a sentence copied character for character from that fixture. It must name the model or be its catalog description, which is the check the judge failed. It must answer that class's `question` in `MODEL_CLASSES`: for the flagship, the vendor's start-here model. Check live `GET /api/prices` first, because a `class_map_decisions` row overrides the seed. If the vendor's own words fit no model, record it as a `CLASS_GAPS` entry instead, with the reason, and never paraphrase a sentence to make it fit. Update the golden counts, and rebase the launch tests that replay a hypothetical next model on the fixture. |

## Product context

Frontier Terminal is a free, public, read-only investor terminal tracking the frontier AI
labs — OpenAI, Anthropic, Google, xAI, Meta, Mistral — on seven axes: API prices, hiring, SEC filings,
disclosed revenue, status-page incidents, misalignment disclosures and OpenRouter demand share.
The three below carry most of the judge's signal. **Pricing**: each lab's published
API price list, parsed into one row per model and tier (input, cached input, output per
million tokens; context window; promo windows as their own rows). **Hiring**: the labs' own
job boards (Ashby for OpenAI, Greenhouse for Anthropic and xAI), one row per posting with
title, department, team and location; the xAI board carries the company name "SpaceXAI"
verbatim, an artifact of the 2025 merger that is kept, not cleaned. **SEC**: EDGAR full-text
search and submissions for a whitelist of public filers around the labs, with S-1 / 424B4
hits alerted by a deterministic floor rule. A scheduled Worker fetches every source, stores
the raw bytes, diffs the parsed rows against the last set, and writes a change log; there are
no accounts and nothing is for sale. Not investment advice.

The provenance rule is the product. Every stored row — snapshot, entity, change, alert —
carries the URL it was read from and the timestamp it was fetched at, and the store refuses a
row without them. An alert may cite only values present in the change rows it references: no
outside figures, no market data from memory, no derived percentages. A judge that cannot
ground a claim stays silent; the Worker enforces that with a deterministic check and records
every rejection as an ops event, so a routine that starts inventing shows up in the owner's
digest rather than on the site.

The reader is an equity analyst covering the AI-infrastructure complex into the IPO wave.
What they want flagged: price moves on flagship models (and asymmetric input/output changes),
hiring-mix shifts — go-to-market and sales surges, datacenter buildout, large removals — and
cross-axis combinations, such as a price cut landing beside a sales-hiring surge. Routine
churn (a re-stamped posting, a reworded location) is not signal. Severity is `info` for a
line in a daily brief, `notable` when it changes the picture for the covered thesis, and
`critical` when the analyst should look today.
