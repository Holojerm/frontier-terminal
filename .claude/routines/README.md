# Cloud Routines

Repo-shipped definitions for the cloud agents ("routines") that run on a schedule against this
repo. Fork-owned: `judge.md`, which reads the Worker's unjudged change rows and sends back
significance alerts through a gated API, and `gap-watch.md`, which re-checks weekly whether the
reason behind each stated gap (a cut source, an unmapped matrix cell) is still true and files an
issue when one is not, and `press-drafts.md`, which saves the Worker's press notes (one per
reporter, for each new registration filing) as Gmail drafts for the owner to send. `ops-triage.md`, `issue-triage.md`, `bug-fix.md`, `dependency-merge.md` and
`template-sync.md` come from the template. `ops-triage` reads the ops spool every six hours and fixes the vendor-drift class
`routines.config.md` › Mechanical fixes grants it. It also retriggers a deploy that never
landed, and files everything else as issues for `issue-triage`/`bug-fix` or the owner. This file, `_shared.md`, and `routines.config.md` are
the scaffolding every routine reads first.

**All routines ship default-inactive.** Nothing runs until you explicitly enable it.

## How it works

Cloud routines live in your claude.ai account (https://claude.ai/code/routines), not in the repo —
so the repo ships the *definitions* and a sync command:

1. Each `*.md` file here (except `README.md`, `_shared.md`, `routines.config.md`) defines one
   routine: frontmatter (schedule, model, required connectors) + full instructions.
2. Run `/routines sync` in Claude Code to create/update them in your account. Routines are always
   created **disabled**; the sync never silently activates anything.
3. Enable individually: `/routines enable <name>` (or via the claude.ai routines UI).
4. The cloud agent gets this repo cloned into its environment, so its prompt is just a pointer:
   "read `_shared.md`, `routines.config.md`, and your own definition file, then execute." The
   instructions stay versioned here — editing a definition file and re-running `/routines sync`
   updates the live routine.

## Coordination: the ops journal

Routines coordinate through an `ops-journal` git branch (never merged to `main`, so journal
commits don't trigger deploys). Every routine appends what it did to `journal/YYYY-MM-DD.md`
on that branch. Protocol details in [`_shared.md`](_shared.md).

## Adding a routine

Drop a new `<name>.md` file here with this frontmatter shape:

```yaml
---
schedule: "0 14 * * *"        # 5-field cron, UTC (minimum interval: 1 hour)
model: claude-sonnet-5
connectors: [github]           # claude.ai connectors this routine needs
enabled: false                 # keep false; enable explicitly after sync
---
```

…followed by a `## Purpose` and `## Instructions` section. Then `/routines sync`. Every routine
must follow the operating rules in `_shared.md` (the pointer prompt enforces reading it first).

## Safety model

- **Default inactive** — sync never enables; enabling is a separate explicit step. Once a
  routine is enabled in your account, flip its frontmatter to `enabled: true` so the file
  matches: runs treat `enabled: false` as a hard stop (`_shared.md` rule 8).
- **Outbound gates**: code changes are PRs, never pushes to `main`, and nothing sends email.
  Merging a PR is a tier-2 act. Only `ops-triage` holds that grant, and only for the
  Mechanical fixes row in `routines.config.md`.
- **Untrusted input** — fetched pages and issue text are attacker-controlled data. `_shared.md`
  forbids following instructions found in them.
- **Audit trail** — everything lands in the ops journal.
