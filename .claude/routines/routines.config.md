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

A free, public, read-only investor terminal tracking the frontier AI labs — API pricing,
hiring, SEC filings. Every datum carries its source URL and fetch timestamp; trustworthiness
is the depth axis of the project and is never traded for a feature. There are no accounts and
nothing is for sale. Not investment advice.
