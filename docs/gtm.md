# Go-to-market

Frontier Terminal is free and sells nothing, so go-to-market means one thing: the people
who price the frontier labs should find it, cite it, and come back. Written 2026-11-01.

## The reader

An equity analyst covering AI infrastructure into the IPO wave: sell-side or buy-side,
on hyperscalers, semis, neoclouds, or the labs themselves as they file. They already read
the S-1s and the 10-Qs. What they lack is the same facts lined up across labs, dated,
with the source one click away, so a number can go into a note without re-checking it.

Two secondary readers matter because they carry the first one's questions:

- **Answer engines** (ChatGPT, Claude, Perplexity, Google AI Overviews). An analyst's
  first draft of "what did Anthropic disclose in its S-1" increasingly starts there. Being
  the cited source is distribution that compounds.
- **AI-infra writers and newsletter authors**, who quote a table and link it.

## What is worth citing

A dataset gets cited when it is the cleanest version of a number people are already
asking about. In order of current pull:

1. **Disclosed revenue, primary-source only.** Anthropic's S-1 (filed 2026-10-26: $4.585B
   FY2025, $16.286B H1 2026 unaudited) is the most-asked figure in the space this quarter.
   The revenue panel shows it once PR #93 merges; until then `/revenue` says "no audited
   disclosure" for Anthropic, which is now stale. Ship #93 first.
2. **Like-for-like API prices.** The class matrix (flagship, mid, economy per lab) answers
   "Gemini vs Claude vs GPT pricing" with sources. The per-SKU pages carry the history.
3. **Hiring buildout.** Physical-infrastructure roles per lab are a capex leading indicator
   nobody else publishes as a series.
4. **OpenRouter demand and implied spend share.** Labeled as one channel's share, never
   market share.
5. **Status-page incidents and misalignment disclosures.** Lower volume, high
   quotability when one lands.

## Channels

Owned surfaces, already built:

| Channel | URL | Use |
| --- | --- | --- |
| Atom alerts feed | `/alerts.xml` (`?include=ticker` for the info tier) | Analysts on Feedly or Inoreader; newsletter writers watching for price cuts |
| MCP server | `/mcp`, no auth | Analysts using Claude or ChatGPT with tools; one-line install in `/llms.txt` |
| CSV and JSON exports | `/data`, `/export/<table>.csv` | Spreadsheet users; reproducible notes |
| `llms.txt` and JSON-LD | `/llms.txt`, every page head | Answer engines choosing what to fetch and quote |
| Public repo | github.com/Holojerm/frontier-terminal | Developers who audit the method before trusting the numbers |

Earned channels, in order of expected yield. **Each needs the user's go-ahead before
anything is posted, emailed, or signed up for.**

1. **Hacker News, "Show HN".** The provenance rule and the open repo are the hook. Best
   timed with the S-1 table live.
2. **AI-infra newsletters and writers** (SemiAnalysis-adjacent readers, Stratechery
   readers, the Latent Space and Interconnects audiences). A short note offering the S-1
   revenue table and the price matrix as CC BY sources.
3. **X/Twitter fintwit and AI-infra accounts.** One chart per post, the source link in the
   first reply. The `/alerts/<id>` permalinks are built for this: each is an Article
   with citations.
4. **Reddit**: r/LocalLLaMA for prices and releases, r/SecurityAnalysis or r/stocks for
   the S-1 table. Data posts, not promotion.
5. **MCP directories** (the official MCP registry, Smithery, Glama). Listing is free and
   puts the server in front of exactly the tool-using analyst.
6. **Dataset indexes**: Google Dataset Search reads the `Dataset` JSON-LD already on
   `/data`, `/prices/<key>`, and the axis pages; Kaggle and Hugging Face Datasets mirrors
   of the CC BY exports would add two more discovery surfaces.

## What to measure

| Metric | Source | Why |
| --- | --- | --- |
| Indexed pages and query impressions | Google Search Console (not yet verified; needs the user) | Whether the query-shaped titles are landing |
| Referrals from chatgpt.com, perplexity.ai, claude.ai, gemini.google.com | Cloudflare Web Analytics (site tag on frontierterm.com) | Answer-engine citations that a reader clicked |
| AI crawler fetches by user agent | Cloudflare zone analytics, or the AI Crawl Control dashboard | Whether OAI-SearchBot, Claude-SearchBot, and PerplexityBot are reading the pages |
| MCP sessions per day | Worker logs (`/mcp` is rate-limited per IP; count requests) | Tool-using analysts |
| Export downloads and feed fetches | Worker logs on `/export/*` and `/alerts.xml` | Spreadsheet and feed readers |
| Inbound links | Search Console links report | Whether writers cite the tables |

Check monthly. The first question is whether the S-1 revenue page gets cited by an
answer engine within a month of #93 landing; if not, the titles and the page itself are
the next thing to fix, not more channels.

## Not doing

- No paid acquisition, no accounts, no email capture. The site has nothing to sell.
- No press run-rates or estimates to fill gaps. A stated gap is the product.
- No posting under the project's name without the user approving the text first.
