# Local data

A fresh checkout's `.data/db/sqlite.db` is empty, and an empty store renders every page's
gap state. That hides real bugs: axe checks empty boxes, filters filter nothing, and the
alert table never shows its icons. Fill it before judging anything visual. Each of the three
sources fills something the others can't.

| Command | Fills | From | Needs |
| --- | --- | --- | --- |
| `bun run dev:poll --fixtures` | entities (prices, jobs, incidents, filings, rankings, disclosures, one lab’s prospectus), filed facts and capex guidance for the five filers, recipe observations, thesis readings | the committed `fixtures/`, through the real pipeline (`layers/terminal/server/dev/fixture-fill.ts`) | a running dev server; nothing else, offline |
| `bun run dev:poll` | the same tables, current | the live sources, the fetches a production tick makes (~30s) | a running dev server; `NUXT_SEC_CONTACT_EMAIL` and `NUXT_OPENROUTER_API_KEY` in `.env` for the SEC and rankings sources |
| `bun run dev:seed` | `alerts`, `changes` (the last 90 days) | production's public `/export/*.json` | the dev server **stopped** (it writes the file) and a DB `bun dev` has migrated once |

A typical first run: `bun dev`, then `bun run dev:poll` (or `--fixtures` offline); stop the
server, `bun run dev:seed`, start it again.

Alerts come from production because most are written by the cloud judge routine through
`/api/judge`, and a local poll's first tick is a baseline, which records no changes. A later
poll records only what moved since.

## What each one is not

- **Fixtures are a fixed moment.** The bytes are as old as `fixtures/manifest.json` says,
  though each row is stamped with the time of the fill. They cover about 45 sources; the rest
  record an absent run.
- **Fixture filings are a sample.** Five filers’ company facts, one quarter’s instance each for
  Microsoft, Alphabet and Amazon (the ones that name OpenAI, Anthropic and Crux AI), four
  earnings releases, and Anthropic’s S-1 with its first amendment. That fills `/exposure`,
  `/dependencies`, `/revenue` and the guidance table on `/ground-truth`. Press reports scored
  against filings come from the judge, so those tables stay empty.
- **The live poll is a real client of the vendors.** It's one tick's worth of requests;
  don't loop it.
- **The seed is production's rows.** Local and seeded changes share content-hash ids, so
  re-running either is harmless, but a seeded alert can cite a change for an entity your local
  poll never stored.

## The browser suites use the fixtures

`test/server/fill.ts` runs `fillFromFixtures` into the built Worker's local store before the
axe and CSP suites, and the run fails if it can't. That store is `.data-browser` (wiped at the
start of each run by `test/server/start.ts`), so a local `test:a11y` never overwrites a dev DB
you filled from a live poll. The sweep also fails on any duplicate `id`, which axe no longer
flags on its own. Without the fill the suites sweep empty pages and miss violations on the
rendered rows (126 `target-size` failures on source links once shipped that way). Keep it in
front of any suite that judges rendered UI.

`layers/terminal/test/fixture-fill.test.ts` runs the same fill in vitest and pins the rows the
filed-figure pages need, so a fill that stops reaching them fails `bun run ci`.
