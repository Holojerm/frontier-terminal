# Methods

How the figures on a few pages are formed. These paragraphs used to sit on the pages
themselves; they moved here on 2026-11-20, when the pages were cut back to the data, a source
credit and links. Each dataset's one-line method is also in its table description on `/data`
and in the `method` field of its API route.

## Revenue: how a lab gets a number

We check EDGAR every 30 minutes. That covers the full-text search for new S-1s, the filings of
each company we track (S-1, 424B4, 10-Q, 10-K, 20-F, and 8-K), and the XBRL company facts of
each company whose total revenue we show. A new S-1, 424B4, 10-Q, 10-K, or 20-F from a company
we track always raises an alert.

When a lab files for itself, nobody has to do anything. Two full-text searches look for S-1s
that mention Anthropic or OpenAI. When one comes from a company whose name matches the lab, we
read its CIK (the SEC's company ID) from the filing and raise a critical alert. From the next
check on, we track that company's filings and XBRL data. Its revenue then shows up on
`/revenue` as an issuer filing, linked to the filing that identified it. A public parent that
consolidates a lab is marked parent instead, and its numbers are labeled as the parent's
everywhere they appear.

Some parents report the lab's business inside one segment (Google inside Alphabet's Google
Cloud). There the numbers are that segment's, read from the XBRL in each 10-Q and 10-K on our
6-hour check, and labeled as the segment instead of the lab.

## Ground truth: how we score press reports

We read news headlines from GDELT (a public index of news sites). When a headline states a
lab's revenue, a model labels the amount. We keep it only when the amount and the lab's name
are in the headline as written. We never fetch the article.

When the lab files with the SEC, we compare. A report counts only if GDELT read it before the
filing day. One from the filing day or later repeats the filing, so we leave it out.

Most headlines name no year. For those we take the nearest filed figure that wasn't public yet,
for a period that had already ended, and count it when it's within the tolerance
(`tolerance_pct` in `/api/ground-truth`). When a headline names the year or quarter, we use
that period, and a gap over the tolerance is a miss.

Filings print year-to-date columns. A quarter is the nine-month figure minus the six-month one,
public from the later of the two filings. Interim figures in a registration statement are
unaudited.

GDELT's time is the quarter hour it read the article. It doesn't read Bloomberg, Reuters, the
Wall Street Journal or the Financial Times, so a figure they break shows up when another outlet
repeats it. "Stored before" counts the reports our store held before the filing day. The rest
we read back from GDELT's archive later.

Only a lab that files for itself is scored on revenue. A parent's consolidated revenue isn't
the lab's.

Deal sizes go through the same steps. The model labels the amount as a contract, an investment
or a loan and names the other company. We keep the label only when the amount, the lab and that
company are in the headline as written. The filed side is the other company's own number, or
the lab's prospectus for its total commitments.

A filed figure often measures something else. Amazon files what Anthropic added to its backlog
in a quarter, and a contract's stated value can be held to that. For OpenAI it files the
backlog left at each quarter end, which falls as Amazon delivers, so we score no headline
against it. The table under the deal reports lists every filed figure we use and how.

A report of an amount added is held to the quarter it was published in. One published after a
quarter ended and before its filing is held to that quarter only when it's within the
tolerance. A report of a total is held to the first balance dated on or after the report. A
report within the tolerance of a figure already filed repeats it and isn't scored. Before we
started labeling deal sizes (`deals.first_labeled_at`), we kept a headline only when it used a
revenue, valuation or funding word, so older deal headlines are there only if they used one.

For capex guidance we read the earnings release each filer attaches to its 8-K (exhibit 99.1),
for releases filed since `guidance.since`. We take the sentence that names capital
expenditures, says expect or anticipate, names a year and states an amount in billions of
dollars. We compare it with the capex the annual report files for that year. A range is met
when the filed figure is inside it, and a single figure within the tolerance. We don't read
call transcripts, and each filer defines capex its own way.

## Track record: how we time alerts against the press

"We saw it" is when we fetched the page that showed the change. When an alert cites several
changes, we use the earliest. A removal counts from the check that found it gone. The alert
itself can be written up to an hour later.

Once the search window (`window_days` in `/api/track-record`) has passed, we search GDELT and
the lab's own newsroom feed for that many days either side. The search terms come from the
changes themselves: the model name, the department, the filer and form. A model reads every
headline and says whether it reports the same event. We show the earliest one it says does.
Until every earlier candidate is rated, the row says "Not yet rated".

The press time is the quarter hour GDELT read the article, not when the outlet published it.
GDELT doesn't read every outlet, and paywalled wires and newsletters are thin in it. It gives us
headlines but no article text, so an article counts only when the event is in its headline or
web address. A report from before the window isn't searched, so an old story can't show as a
lag.

Anthropic and xAI publish no newsroom feed, and we don't read DeepSeek's, Alibaba's or Moonshot
AI's newsrooms yet. Meta's feed holds only its newest 10 posts. Leads are rounded to a tenth of
an hour.

## Exposure: how we read hyperscaler filings

EDGAR's company facts list each company-wide figure with the filing that reported it, back past
2020. A figure tagged on a segment, a customer, or an investee is only in each 10-Q and 10-K's
own XBRL file, so we read that file once per filing. Each period shows the newest filing's
value. When a later filing restates a value, the old one stays in the table as restated. A new
10-Q or 10-K that moves a series raises an alert that states the number.

## Incidents before the live feeds: archived copies

Before our first read of each lab's status feed, the monthly counts on `/incidents` come from
the Internet Archive's copies of the same feed. A feed lists only its newest incidents, so a
copy speaks for incidents that started from the oldest start it lists (`covers_from`) to the
moment the Archive took it. An incident listed in many copies is one row, in the newest copy's
state. A month is drawn only where the copies reach all of it; a month they reach in part is a
break in the line, and `/api/incidents` gives its count and the share reached. Counts are
filtered as the live feed is. We don't compute uptime or durations from copies, since they
can't promise every incident. Archived incidents never reach the live windows, alerts or the
judge. Sources, shapes and gaps: `docs/source-audit.md`, the 2026-11-21 Internet Archive
addendum.
