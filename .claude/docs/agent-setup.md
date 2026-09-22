# Agent tooling — MCP servers, skills, commands, routines

What ships in `.mcp.json.example` and `.claude/`: the MCP servers available for live introspection, the NuxtUI skill, the slash commands, and the cloud routines.

> **Load this when:** configuring Claude Code for this repo, wiring a new MCP server, or adding a cloud routine.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

This project ships with Claude Code configuration in `.mcp.json.example` and `.claude/`.

## MCP Servers (`.mcp.json.example`)

`.mcp.json` itself is **untracked** (`.gitignore`). Copy the example once:

```bash
cp .mcp.json.example .mcp.json
```

Two reasons it is not in the repository. It is machine-local — it names servers and hostnames a
given machine can reach — and `nuxt-mcp` rewrites it on every `bun dev` with that machine's dev
URL, so tracking it means a public repo carrying one developer's hostnames plus an unasked-for
diff after every dev session.

| Server | Type | Purpose |
| --- | --- | --- |
| `cloudflare-docs` | Remote HTTP | Workers, D1, KV, R2, Pages documentation — always active |
| `cloudflare-bindings` | Remote HTTP | Workers bindings and API reference — always active |
| `nuxt-ui` | Remote HTTP | NuxtUI v4 component API docs, composables, templates, migration guide — always active |
| `github` | Remote HTTP | GitHub repo/PR/issue context — requires `GITHUB_TOKEN` env var |
| `nuxt` | Local SSE | Live project introspection (pages, components, auto-imports, config) — requires `bun dev` |
| `drizzle` | Local stdio | Schema introspection against `server/db/schema.ts` |

**Setup notes:**
- `cloudflare-*` and `nuxt-ui` work with no credentials — always available.
- For GitHub MCP: set `GITHUB_TOKEN` in your shell (a PAT with repo read scope is enough).
- For live Nuxt introspection: start `bun dev` before opening Claude Code. The `nuxt` server URL in `.mcp.json` is `https://<portless-name>.localhost/__mcp/sse` and must match the `portless.name` in `package.json`.
- **In a linked worktree the dev host is different** — see the worktree section below. `bun dev` prints the host it's using, and `nuxt-mcp` repoints your `.mcp.json` at it on boot so introspection keeps working. Since the file is untracked, that rewrite is now invisible to git.
- Drizzle MCP works automatically via `bunx`.

## NuxtUI Skill (`.claude/skills/nuxt-ui/`)

Installed via `npx skills add nuxt/ui --agent claude-code`. Provides Claude with deep knowledge of NuxtUI's component patterns, theming system, and composables. Complements the `nuxt-ui` MCP server (which provides live API lookups).

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

Repo-shipped definitions for cloud agents that run on a schedule. **All ship default-inactive**
— `/routines sync` registers them (disabled) in your claude.ai account, and each one is
enabled explicitly. The `enabled:` flag mirrors that account state rather than setting it:
after enabling one, flip its frontmatter to match, because a run whose file says
`enabled: false` hard-stops (`_shared.md` rule 8). Routines coordinate through an `ops-journal` branch (never merged to
`main`, so journal commits don't trigger deploys). Before enabling one: fill in
`.claude/routines/routines.config.md`, connect the connectors it needs at
claude.ai/customize/connectors, then `/routines sync`. Full docs in
[.claude/routines/README.md](../routines/README.md).
