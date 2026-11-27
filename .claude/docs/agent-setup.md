# Agent tooling: MCP servers, skills, commands, routines

What ships in `.mcp.json.example` and `.claude/`.

> **Load this when:** configuring Claude Code for this repo, wiring a new MCP server, or adding a cloud routine.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## MCP Servers (`.mcp.json.example`)

`.mcp.json` is untracked (`.gitignore`). Copy the example once:

```bash
cp .mcp.json.example .mcp.json
```

It stays out of the repo because it is machine-local (it names servers and hostnames one
machine can reach), and `nuxt-mcp` rewrites it with that machine's dev URL on every `bun dev`.
Tracked, it would put one developer's hostnames in a public repo and leave a diff after every
dev session.

| Server | Type | Purpose |
| --- | --- | --- |
| `cloudflare-docs` | Remote HTTP | Workers, D1, KV, R2, Pages documentation (no credentials) |
| `cloudflare` | Remote HTTP | The whole Cloudflare API through `search` + `execute` (OAuth sign-in on first use) |
| `nuxt-ui` | Remote HTTP | NuxtUI v4 component API docs, composables, templates, migration guide (no credentials) |
| `github` | Remote HTTP | GitHub repo/PR/issue context; needs `GITHUB_TOKEN` (a PAT with repo read scope) |
| `nuxt` | Local SSE | Live project introspection (pages, components, auto-imports, config); needs `bun dev` |
| `drizzle` | Local stdio | Schema introspection against `server/db/schema.ts`, via `bunx` |

For live Nuxt introspection, start `bun dev` before opening Claude Code. The `nuxt` server URL
is `https://<portless-name>.localhost/__mcp/sse` and must match `portless.name` in
`package.json`. A linked worktree gets a different host ([gotchas.md](gotchas.md) › `bun dev`
gets a per-worktree hostname); `bun dev` prints it, and `nuxt-mcp` repoints `.mcp.json` at it
on boot.

## Skills (`.claude/skills/`)

Every skill here is listed in every session, and `AGENTS.md` › Agent tooling names the moment
each one is loaded. A skill nobody is told to load never runs, so a new one comes with its row
there. The pack comes from the template: each skill is a plain copy pinned in
`skills-lock.json` (source, commit, hash), and a template sync carries it. Licences and
copyright lines are in `.claude/skills/THIRD_PARTY_NOTICES.md`.

| Skill | Source | Purpose |
| --- | --- | --- |
| `nuxt-ui` | nuxt/ui | NuxtUI v4 components, theming, forms, layouts. Complements the `nuxt-ui` MCP server (live API lookups) |
| `frontend-design` | anthropics/skills | Visual direction for a new page or a redesign, inside `DESIGN.md` |
| `web-design-guidelines` | vercel-labs/agent-skills | Reviews changed UI files against a pinned copy of the Web Interface Guidelines |
| `design-qa-checklist` | Owl-Listener/designer-skills | Every state, touch target and edge case checked before UI work is called done |
| `state-machine` | Owl-Listener/designer-skills | Enumerates a flow's states so none is impossible or a dead end |
| `loading-states` | Owl-Listener/designer-skills | Waiting by duration tier, no layout shift, optimistic updates with rollback |
| `error-handling-ux` | Owl-Listener/designer-skills | Error placement by context, preserved input, what/why/what-next messages |
| `feedback-patterns` | Owl-Listener/designer-skills | Confirmations and toasts: where, how long, undo over "are you sure" |
| `ux-writing` | Owl-Listener/designer-skills | Labels, errors, empty states, CTAs (voice comes from `.claude/docs/voice.md`) |
| `a-b-test-design` | Owl-Listener/designer-skills | Hypothesis, one primary metric plus guardrails, sample size, when not to test |
| `copywriting` | coreyhaines31/marketingskills | Landing copy whose every claim can be backed |
| `seo-audit` | coreyhaines31/marketingskills | Technical and on-page SEO audit beyond `bun run seo:check` |
| `workers-best-practices` | cloudflare/skills | Workers code and config rules, for sessions without the Cloudflare plugin |
| `systematic-debugging` | obra/superpowers | Root cause before any fix |

## Slash Commands (`.claude/commands/`)

| Command | Usage | Purpose |
| --- | --- | --- |
| `/scaffold-component` | `/scaffold-component Feature/Name` | Generate a Vue component following project conventions |
| `/design-sync` | `/design-sync [brief\|url]` | Compile `DESIGN.md` into the NuxtUI token layer, then verify |
| `/logo-sync` | `/logo-sync [brief\|path.svg]` | Design the brand mark from `DESIGN.md`, then generate every icon from it |
| `/scaffold-api` | `/scaffold-api [path] [method]` | Generate a public, rate-limited API route with Zod validation |
| `/db-migrate` | `/db-migrate` | Run the full Drizzle migration workflow |
| `/new-feature` | `/new-feature FeatureName` | Full stack scaffold: component + API routes + schema |
| `/routines` | `/routines sync\|status\|enable\|disable\|run` | Manage the cloud routines defined in `.claude/routines/` |

## Cloud Routines (`.claude/routines/`)

Repo-shipped definitions for scheduled cloud agents. All ship inactive: `/routines sync`
registers them (disabled) in your claude.ai account, and each is enabled explicitly. The
`enabled:` flag mirrors the account state instead of setting it, so after enabling one, flip
its frontmatter to match: a run whose file says `enabled: false` hard-stops (`_shared.md`
rule 8). Routines coordinate through an `ops-journal` branch, never merged to `main`, so
journal commits don't trigger deploys. Before enabling one, fill in
`.claude/routines/routines.config.md`, connect the connectors it needs at
claude.ai/customize/connectors, then `/routines sync`. Full docs:
[.claude/routines/README.md](../routines/README.md).
