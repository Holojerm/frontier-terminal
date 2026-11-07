# Voice

How the site's words should sound. It's modeled on Jeremy's own writing and on what Jeremy cuts
from AI drafts.

Read this before writing or changing anything a visitor reads.

## Scope

Everything a visitor or a crawler reads: page text, ledes, panel titles and notes, empty
states, alerts, `useSeo()` titles and descriptions, `publicPage` summaries, `/llms.txt`,
export-table descriptions, the `cut:` reasons in `sources.yaml`, and the gap strings in
`layers/terminal/server/utils/terminal-classes.ts`. `README.md` and `docs/` follow it too.

Code comments aren't copy. They follow the comment rule in `AGENTS.md`.

## The short version

Write it the way you'd explain it to a smart friend across the table. Short sentences.
Plain words. Say the thing, then stop.

## What it sounds like

- **Short declarative sentences.** Most run 6 to 15 words. A run of fragments is fine when
  it reads like a list ("Axes to chop wood. Wheels to transport items.").
- **"We" for the site, "you" for the reader.** We check EDGAR every 30 minutes. You can
  download every table. The site isn't a person and doesn't "watch", "catch", or "refuse".
- **Contractions are fine.** Isn't, doesn't, we'll, can't.
- **Concrete over abstract.** Name the lab, the number, the page. "OpenAI's pricing page
  doesn't list prices" beats "a source-level gap".
- **Parentheses for asides.** Never em dashes.
- **Plain verbs.** Check, read, show, list, miss, add. Not surface, land, carry, power,
  unlock, leverage.
- **Expand an acronym the first time** outside a table: "XBRL (the SEC's tagged financial
  data)". Analysts know SEC, API, and IPO. Spell out the rest.
- **One idea per sentence.** If a sentence needs a semicolon, it's two sentences.
- **Trust the reader.** Say it once. Don't follow a sentence with another that explains it.

Running prose (About, License, Contact, thesis bodies) uses full sentences. Panel notes,
badges, empty states, and table captions can be fragments.

## What makes copy sound like AI

These are the patterns Jeremy cuts. Avoid all of them.

| Pattern | Example from the site | Instead |
| --- | --- | --- |
| Em dashes | "six frontier model providers — OpenAI, Anthropic… — on seven axes" | A period, a comma, or parentheses |
| "X, not Y" reframes | "a claim, not data", "A proxy, not market share", "disclosure, not behavior" | Say what it is. Use "not" only when a reader would really assume the wrong thing, and at most once per page |
| Semicolon chains | "Pages show the current state and the change log; an alert is a claim about change rows only." | Two sentences, or cut one |
| Colon setups | "The overlap is deliberate: a stalled feed stays covered." | "That way a stuck feed still gets picked up." |
| Aphorisms and closing zingers | "A datum that cannot be re-fetched is a claim, not data" | State the rule plainly: "If we can't fetch it again, we don't store it." |
| Rule of three | "polled on a schedule, snapshotted whole, parsed deterministically, and diffed" | Keep the one or two that matter to the reader |
| Bolded lead-in fragments | "**Terms of your own.** A licence without…" | A plain list, or a sentence |
| Metaphor and cute phrasing | "tripwire", "carry the weight", "problem wearing a trench coat" | The literal thing: "the S-1 search", "matter most" |
| Intensifiers | genuinely, honestly, exactly, precisely, deliberately, quietly, simply, real, every single, by definition | Delete the word. The sentence is stronger without it |
| Codebase vocabulary | tick, payload, snapshotted, diffed, change rows, whitelisted CIK, tagged filer, axis | What the reader sees: "the last check", "the page we read", "changes", "the labs we track" |
| Mechanism as justification | "keyed by the newest poll tick, so a new poll invalidates the cache" | Say the effect: "Pages refresh within five minutes of a new check." |
| Meta-commentary | "Two limits worth naming precisely", "which is why I think it's the right one" | Just name them |

### Words to avoid

load-bearing, honest/honestly, genuine/genuinely, deliberate/deliberately, precisely,
exactly (as emphasis), quietly, simply, crucially, notably, robust, seamless, first-class,
tripwire, signal (as a vague noun), lens, seam, surface (as a verb), land (as a verb),
"worth noting", "by design", "on purpose", "rather than" (use "instead of").

## Before and after

Real lines from the site, rewritten.

> **Before:** Until a lab lists, the private-company signals carry the weight.
> **After:** Most of these labs are still private. Until one files to go public, hiring,
> prices, and usage are the best data there is.

> **Before:** Every figure links to the exact URL it was read from and carries the UTC
> instant it was fetched. A datum that cannot be re-fetched is a claim, not data, and is not
> stored.
> **After:** Every number links to the page we read it from and shows when we read it (UTC).
> If we can't fetch it again, we don't store it.

> **Before:** Every source, EDGAR included, is polled every 6 hours. The overlap is
> deliberate: a stalled feed stays covered.
> **After:** We also check every source, EDGAR included, every 6 hours. That way a stuck feed
> still gets picked up.

> **Before:** Share of OpenRouter tokens, newest 7 days. A proxy, not market share.
> **After:** Share of OpenRouter tokens over the last 7 days. It's one aggregator's traffic,
> so treat it as a rough read on demand.

> **Before:** This is a data terminal, not a recommendation. It reports what public sources
> say and when they said it.
> **After:** This isn't investment advice. We report what public sources say and when they
> said it.

> **Before:** Source on GitHub — MIT licensed; the source registry and every parser are in
> the repo.
> **After:** Source on GitHub (MIT). Every source and parser is in the repo.

## Hard rules

These don't change for voice.

- A quoted vendor sentence is byte-identical to its source. That covers every class-map
  `basis`, every quote inside a gap string, and every `license` term in `sources.yaml`.
- Dates, URLs, numbers, accession numbers, tags, and live-checked facts never change.
- Per-source `caveats` in `sources.yaml` are the audit's own words (`docs/source-audit.md`)
  and aren't restyled.
- "Not investment advice" and the provenance rule are stated plainly, never softened.
- US English, sentence case for headings, typographic quotes and apostrophes (’ “ ”), and the
  serial comma. State units once per panel: "$ per million tokens", "UTC", "days".

## Checking a draft

Read it out loud. If you wouldn't say it to someone across the table, rewrite it. Then search
the diff for `—`, `;`, `, not `, and the words above.
