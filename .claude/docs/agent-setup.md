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
| `cloudflare-bindings` | Remote HTTP | Workers bindings and API reference (no credentials) |
| `nuxt-ui` | Remote HTTP | NuxtUI v4 component API docs, composables, templates, migration guide (no credentials) |
| `github` | Remote HTTP | GitHub repo/PR/issue context; needs `GITHUB_TOKEN` (a PAT with repo read scope) |
| `nuxt` | Local SSE | Live project introspection (pages, components, auto-imports, config); needs `bun dev` |
| `drizzle` | Local stdio | Schema introspection against `server/db/schema.ts`, via `bunx` |

For live Nuxt introspection, start `bun dev` before opening Claude Code. The `nuxt` server URL
is `https://<portless-name>.localhost/__mcp/sse` and must match `portless.name` in
`package.json`. A linked worktree gets a different host ([gotchas.md](gotchas.md) › `bun dev`
gets a per-worktree hostname); `bun dev` prints it, and `nuxt-mcp` repoints `.mcp.json` at it
on boot.

## NuxtUI Skill (`.claude/skills/nuxt-ui/`)

Installed with `npx skills add nuxt/ui --agent claude-code`. It covers NuxtUI's component
patterns, theming and composables; the `nuxt-ui` MCP server adds live API lookups.

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
