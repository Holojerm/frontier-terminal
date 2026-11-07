# Local data

A fresh checkout's `.data/db/sqlite.db` is empty, and an empty store renders every page's
gap state. That hides real bugs: with no rows, axe checks empty boxes, filters filter
nothing, and the alert table never shows its icons. Fill it before judging anything
visual. There are three sources, and each one fills something the others can't.

| Command | Fills | From | Needs |
| --- | --- | --- | --- |
| `bun run dev:poll --fixtures` | entities (prices, jobs, incidents, filings, rankings, disclosures), recipe observations, thesis readings | the committed `fixtures/`, through the real pipeline (`layers/terminal/server/tasks/dev/fixtures.ts`) | a running dev server; nothing else, offline |
| `bun run dev:poll` | the same tables, current | the live sources, the fetches a production tick makes (~30s) | a running dev server; `NUXT_SEC_CONTACT_EMAIL` and `NUXT_OPENROUTER_API_KEY` in `.env` for the SEC and rankings sources |
| `bun run dev:seed` | `alerts`, `changes` (the last 90 days) | production's public `/export/*.json` | the dev server **stopped** (it writes the file) and a DB `bun dev` has migrated once |

A typical first run: `bun dev`, then `bun run dev:poll` (or `--fixtures` offline); stop the
server, `bun run dev:seed`, start it again.

Why alerts come from production: most are written by the cloud judge routine through
`/api/judge`, and a local poll's first tick is a baseline, which records no changes. A
second poll later records only what moved since.

## What each one is not

- **Fixtures are a fixed moment.** Their `fetched_at` comes from `fixtures/manifest.json`, so
  pages read as weeks old. They cover about 45 sources; the rest record an absent run.
- **The live poll is a real client of the vendors.** It's one tick's worth of requests;
  don't loop it.
- **The seed is production's rows, not yours.** A local poll's changes and the seeded ones
  share content-hash ids, so re-running either is harmless, but a seeded alert can cite a
  change for an entity your local poll never stored.

## The browser suites use the fixtures

`test/warmup/fill-store.ts` runs `dev:fixtures` before the axe and CSP suites, and the run
fails if it can't. The suites' server uses its own NuxtHub dir, `.data-browser` (wiped at the
start of each run, `NUXT_HUB_DIR` in `playwright.config.ts`), so a local `test:a11y` never
rewrites the dev DB you filled from a live poll with older fixture values. The sweep also
fails on any duplicate `id`, which axe stopped flagging on its own. Before it did, the suites swept empty pages, and 126 `target-size`
violations on source links went out to five public pages. Keep it in front of any suite
that judges rendered UI.
