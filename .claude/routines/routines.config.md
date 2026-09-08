# Routines Configuration

Repo-specific values for the cloud routines. Routines treat placeholder values as "not
configured" and skip the dependent work (journaling the gap).

| Key | Value |
| --- | --- |
| Product name | Frontier Terminal |
| Production URL | `https://frontier-terminal.jeremy-ettlinger.workers.dev` |
| Owner name | `<your name>` |
| GitHub repo | Holojerm/frontier-terminal |
| Analytics sources | Cloudflare Workers analytics for the production Worker |

## Product context

Frontier Terminal is a free, public, read-only investor terminal tracking the frontier AI
labs — OpenAI, Anthropic, Google, xAI — along three axes. **Pricing**: each lab's published
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
