# Go-to-market

Frontier Terminal is a terminal of fundamentals on the frontier AI labs and the public
companies around them. Theses are a layer on top of that data, for the retail reader. The
site is free and sells nothing, so go-to-market means one thing: the people who price the
labs should find it, cite it, and come back.

## The readers

1. An equity analyst covering AI infrastructure into the IPO wave: sell-side or buy-side, on
   hyperscalers, semis, neoclouds, or the labs themselves as they file. They already read the
   S-1s and the 10-Qs. What they lack is the same facts lined up across labs, dated, with the
   source one click away, so a number can go into a note without re-checking it. The tear
   sheet (`/labs/<lab>/tear-sheet`) is built for them.
2. A researcher who wants to test a series before trusting it. They need the full tables,
   the date each row was first seen, and identifiers that join to their own security master.
   `/data` and `/signals` are built for them.
3. A retail reader who follows one lab or one trade. `/theses` and the weekly digest are
   built for them.

Two more readers matter because they carry the first three's questions:

- Answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews). A first draft of "what
  did Anthropic disclose in its S-1" often starts there, and being the cited source compounds.
- AI-infra writers and newsletter authors, who quote a table and link it.

## What is worth citing

A dataset gets cited when it is the cleanest version of a number people already ask about.
In order of current pull:

1. Disclosed revenue, primary-source only. `/revenue` shows every period a lab or its parent
   has filed, starting with Anthropic's S-1 (October 2026) and its 424B4 (November 2026).
2. Press reports against filings. `/ground-truth` scores what the press reported about a lab's
   revenue and deals against the filing that printed the figure later.
3. Like-for-like API prices. The class matrix (flagship, balanced, economy per lab) answers
   "Gemini vs Claude vs GPT pricing" with sources. The per-SKU pages hold the history.
4. The companies around the labs. `/exposure` has what the hyperscalers file about OpenAI and
   Anthropic, `/hardware` the suppliers and the monthly Taiwan revenue, `/compute` and
   `/power` GPU rental prices and data-center power.
5. Hiring buildout. Physical-infrastructure roles per lab are a capex leading indicator
   nobody else publishes as a series.
6. OpenRouter demand and implied spend share, labeled as one channel's share.
7. The scorecard. `/signals` tests every series against the stocks it should lead, holds out
   the newest third, and lists the series that fail beside the ones that pass.
8. Status-page incidents and misalignment disclosures. Lower volume, very quotable when one
   lands.

## Channels

Owned, already built:

| Channel | URL | Use |
| --- | --- | --- |
| Tear sheets | `/labs/<lab>/tear-sheet` | One printable page per lab, every figure footnoted to its source |
| Atom alerts feed | `/alerts.xml` (`?include=info` for the minor changes) | Analysts on Feedly or Inoreader; newsletter writers watching for price cuts |
| MCP server | `/mcp`, no auth | Analysts using Claude or ChatGPT with tools; one-line install in `/llms.txt` |
| CSV and JSON exports | `/data`, `/export/<table>.csv` | Spreadsheet users; reproducible notes; researchers testing a series |
| `llms.txt` and JSON-LD | `/llms.txt`, every page head | Answer engines choosing what to fetch and quote |
| Weekly thesis digest | `/theses` | Retail readers; one email each Monday |
| Public repo | github.com/Holojerm/frontier-terminal | Developers who audit the method before trusting the numbers |

Earned, in order of expected yield. Each needs the user's go-ahead before anything is posted,
emailed, or signed up for.

1. Hacker News, "Show HN". The provenance rule and the open repo are the hook.
2. AI-infra newsletters and writers (SemiAnalysis-adjacent readers, Stratechery readers, the
   Latent Space and Interconnects audiences). A short note offering the revenue table, the
   press scores and the price matrix as CC BY sources.
3. X/Twitter fintwit and AI-infra accounts. One chart per post, the source link in the first
   reply. Each `/alerts/<id>` permalink is an Article with citations, built for this.
4. Reddit: r/LocalLLaMA for prices and releases, r/SecurityAnalysis or r/stocks for the
   revenue table. Data posts only.
5. MCP directories (the official MCP registry, Smithery, Glama). Listing is free and reaches
   the tool-using analyst directly.
6. Dataset indexes. Google Dataset Search reads the `Dataset` JSON-LD already on `/data`,
   `/prices/<key>` and the dataset pages. Kaggle and Hugging Face Datasets mirrors of the
   CC BY exports would add two more.

## What to measure

| Metric | Source | Why |
| --- | --- | --- |
| Indexed pages and query impressions | Google Search Console (verified; the owner's login) | Whether the query-shaped titles are working |
| Referrals from chatgpt.com, perplexity.ai, claude.ai, gemini.google.com | Cloudflare Web Analytics (site tag on frontierterm.com) | Answer-engine citations that a reader clicked |
| AI crawler fetches by user agent | Cloudflare zone analytics, or the AI Crawl Control dashboard | Whether OAI-SearchBot, Claude-SearchBot, and PerplexityBot are reading the pages |
| MCP requests per day | Worker logs (`/mcp` is rate-limited per IP; count requests) | Tool-using analysts |
| Export downloads and feed fetches | Worker logs on `/export/*` and `/alerts.xml` | Spreadsheet, research and feed readers |
| Digest subscribers | The subscriber count | Retail readers who came back |
| Inbound links | Search Console links report | Whether writers cite the tables |

Check monthly. The first question is whether an answer engine cites the revenue page. If it
doesn't, fix the titles and the page before adding channels.

## Not doing

- No paid acquisition and no accounts. The site has nothing to sell. The only email it keeps
  is a weekly thesis digest subscriber's (double opt-in).
- No press run-rates or estimates to fill gaps. A stated gap is the product.
- No posting under the project's name without the user approving the text first.
