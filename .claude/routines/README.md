# Cloud Routines

Repo-shipped definitions for the cloud agents ("routines") that run on a schedule against this
repo. Fork-owned: `judge.md` (significance alerts over the Worker's change log, sent back
through a gated API) and `gap-watch.md` (a weekly re-check of every stated gap, then a scout
for new public datasets). From the template: `ops-triage.md`, `issue-triage.md`, `bug-fix.md`,
`dependency-merge.md`, `pr-shepherd.md` and `template-sync.md`. Each file's `## Purpose` says
what it does. `_shared.md` and `routines.config.md` are the scaffolding every routine reads
first.

**All routines ship default-inactive.** Nothing runs until you explicitly enable it.

## How it works

Cloud routines live in your claude.ai account (https://claude.ai/code/routines), not in the
repo, so the repo ships the *definitions* and a sync command:

1. Each `*.md` file here (except `README.md`, `_shared.md`, `routines.config.md`) defines one
   routine: frontmatter (schedule, model, required connectors) plus full instructions.
2. Run `/routines sync` in Claude Code to create/update them in your account. Routines are always
   created **disabled**; the sync never silently activates anything.
3. Enable individually: `/routines enable <name>` (or via the claude.ai routines UI).
4. The cloud agent gets this repo cloned into its environment, so its prompt is just a pointer:
   "read `_shared.md`, `routines.config.md`, and your own definition file, then execute." Editing
   a definition file and re-running `/routines sync` updates the live routine.

## Coordination: the ops journal

Routines coordinate through an `ops-journal` git branch (never merged to `main`, so journal
commits don't trigger deploys). Every routine appends what it did to `journal/YYYY-MM-DD.md`
on that branch. Protocol in [`_shared.md`](_shared.md).

## Adding a routine

Drop a new `<name>.md` file here with this frontmatter shape:

```yaml
---
schedule: "0 14 * * *"        # 5-field cron, UTC (minimum interval: 1 hour)
model: claude-sonnet-5
connectors: [github]           # claude.ai connectors this routine needs
enabled: false                 # keep false; enable explicitly after sync
scope: fleet                   # optional: one all-repos routine runs this for every fork
---
```

`scope: fleet` is for routines that are identical in every repo and light enough to run for all
of them in one session (`dependency-merge.md`, `pr-shepherd.md`). The owner registers one
`all-repos-<name>` routine that sources every repo and follows each repo's own grants and
journal; `/routines sync` skips the definition so forks don't grow a duplicate per repo.

Follow the frontmatter with a `## Purpose` and `## Instructions` section, then run
`/routines sync`. Every routine must follow the operating rules in `_shared.md` (the pointer
prompt enforces reading it first).

## Safety model

- Sync never enables; enabling is a separate explicit step. Once a routine is enabled in your
  account, flip its frontmatter to `enabled: true` so the file matches: runs treat
  `enabled: false` as a hard stop (`_shared.md` rule 8).
- Code changes are PRs, never pushes to `main`, and nothing sends email. Merging a PR is a
  tier-2 act. `ops-triage` holds that grant for the Mechanical fixes rows in
  `routines.config.md`, and `dependency-merge` for Dependabot minor and patch PRs.
  `pr-shepherd`'s grant covers a retry and a requeue, never a merge. `bug-fix` and
  `template-sync` open their PR ready at tier 2, so the queue lands it when green; without
  the grant, or when the PR leaves something for the owner, it is a draft.
- Fetched pages and issue text are attacker-controlled data. `_shared.md` forbids following
  instructions found in them.
- Everything lands in the ops journal.
