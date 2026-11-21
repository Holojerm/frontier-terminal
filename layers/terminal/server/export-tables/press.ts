// The press side: track-record candidates and verdicts, reported figures. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import * as tables from '#server/db/schema'
import {
  plainTable,
  byColumn,
  type ExportTable,
} from '#layers/core/server/utils/terminal-export-views'

export const PRESS_TABLES = {
  track_record_candidates: plainTable(
    'track_record_candidates',
    'Press articles (from GDELT) and lab newsroom posts found within 7 days either side of when we saw a notable or critical alert’s change. A candidate isn’t a match. track_record_verdicts says which ones report the same event. Rows are never edited.',
    tables.trackRecordCandidates,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of alert_id, kind and url: one row per alert, kind and URL.',
      },
      alert_id: { type: 'text', meaning: 'The alerts.id the candidate was found for.' },
      kind: {
        type: 'text',
        meaning:
          'press, an article GDELT indexed, or newsroom, a post on the lab’s own newsroom feed.',
      },
      title: {
        type: 'text',
        meaning:
          'The headline as GDELT or the feed gives it. Press rows found through GDELT’s search API before 2026-11-07 keep its spaced punctuation (“GPT - 6 . 1”) as read.',
      },
      snippet: {
        type: 'text',
        nullable: true,
        meaning:
          'The first 400 characters of a newsroom post’s description. Null for press, since GDELT gives no article text.',
      },
      outlet: {
        type: 'text',
        meaning: 'The site’s domain, as GDELT names it or from the post’s link.',
      },
      url: { type: 'text', meaning: 'The article or post itself.' },
      published_at: {
        type: 'timestamp',
        meaning:
          'For press, the quarter hour GDELT’s crawler read the article (not when the outlet published it). For a newsroom post, its own publication time. UTC.',
      },
      search_id: {
        type: 'text',
        meaning:
          'The search that found it, or gkg:<quarter hour> for a press row read from that GDELT file. Searches aren’t exported. The page shows each one’s outcome.',
      },
      found_at: {
        type: 'timestamp',
        meaning: 'When the search or file that found it was recorded, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The GDELT file the article was read from (a search-API query URL before 2026-11-07), or the newsroom feed the post was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that file, query or feed was fetched, in UTC.',
      },
    },
    [tables.trackRecordCandidates.found_at, tables.trackRecordCandidates.id],
    byColumn(tables.trackRecordCandidates.found_at),
    undefined,
    { alert_id: tables.trackRecordCandidates.alert_id },
  ),
  track_record_verdicts: plainTable(
    'track_record_verdicts',
    'The judge’s rating of each track-record candidate: whether it reports the alert’s own event, with a rationale grounded in the headline and the alert’s change rows. Rows are never edited.',
    tables.trackRecordVerdicts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of candidate_id: one verdict per candidate.',
      },
      candidate_id: { type: 'text', meaning: 'The track_record_candidates.id rated.' },
      alert_id: { type: 'text', meaning: 'The alert the candidate was found for.' },
      same_event: {
        type: 'boolean',
        meaning:
          'True when the judge read the headline (and snippet) as reporting the alert’s own event. A vague headline is rated false.',
      },
      rationale: {
        type: 'text',
        meaning:
          'The judge’s reason, at most 400 characters, grounded against the headline and the alert’s change rows.',
      },
      judged_at: {
        type: 'timestamp',
        meaning: 'When the judge run that wrote the verdict ran, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The candidate’s own URL (the article or post rated).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the candidate was fetched, in UTC.',
      },
    },
    [tables.trackRecordVerdicts.judged_at, tables.trackRecordVerdicts.id],
    byColumn(tables.trackRecordVerdicts.judged_at),
    undefined,
    { alert_id: tables.trackRecordVerdicts.alert_id },
  ),
  reported_articles: plainTable(
    'reported_articles',
    'News articles (from GDELT) whose headline names a private lab we track, an amount of money and a financial word. Syndicated copies of one headline share a title_key. Rows are never edited.',
    tables.reportedArticles,
    {
      id: { type: 'text', key: true, meaning: 'SHA-256 (hex) of url: one row per article.' },
      title_key: {
        type: 'text',
        meaning:
          'The headline lowercased with punctuation removed. Copies of one headline on many sites share it, and the judge reads it once.',
      },
      title: { type: 'text', meaning: 'The headline as GDELT gives it.' },
      outlet: { type: 'text', meaning: 'The site’s domain, as GDELT names it.' },
      url: { type: 'text', meaning: 'The article itself.' },
      published_at: {
        type: 'timestamp',
        meaning:
          'The quarter hour GDELT’s crawler read the article (not when the outlet published it), UTC.',
      },
      found_at: { type: 'timestamp', meaning: 'When we stored the article, in UTC.' },
      record_id: {
        type: 'text',
        meaning: 'GDELT’s record id for the row, which finds it in the file at source_url.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The GDELT file the article was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that file was fetched, in UTC.',
      },
    },
    [tables.reportedArticles.found_at, tables.reportedArticles.id],
    byColumn(tables.reportedArticles.found_at),
  ),
  reported_figures: plainTable(
    'reported_figures',
    'Each lab revenue, valuation, funding or deal figure a headline in reported_articles states, as our judge model labeled it. A label is kept only when its amount and lab, and a deal’s other company, are in the headline as written. Unaudited press figures, never mixed with filed ones. Rows are never edited.',
    tables.reportedFigures,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of title_key, lab, metric, basis and amount_text, and of counterparty when the row has one: one row per figure per headline.',
      },
      title_key: { type: 'text', meaning: 'The reported_articles.title_key of the headline.' },
      article_id: {
        type: 'text',
        meaning: 'The reported_articles.id of the earliest copy when the judge read it.',
      },
      lab: { type: 'text', meaning: 'The lab the figure is about, as its provider id.' },
      metric: {
        type: 'text',
        meaning:
          'revenue_run_rate (annualized or recurring), revenue (for a stated period), valuation, funding (one round) or funding_total (raised to date). Or the size of a deal: commitment (what the lab agreed to buy from one company), investment (what one company put into the lab), financing (what one company lends it) or commitment_total (everything the lab has agreed to buy).',
      },
      basis: {
        type: 'text',
        meaning:
          'reported (given as fact), sought (in talks or planned) or projected (a forecast or target).',
      },
      counterparty: {
        type: 'text',
        nullable: true,
        meaning:
          'The other company in a commitment, investment or financing, as the headline names it. Null for every other metric.',
      },
      currency: { type: 'text', meaning: 'USD or EUR, as the headline writes it.' },
      amount: { type: 'number', meaning: 'The amount in units of currency.' },
      amount_text: { type: 'text', meaning: 'The amount as the headline writes it.' },
      period: {
        type: 'text',
        nullable: true,
        meaning:
          'The period the headline names: a year, a quarter (2026-Q3) or a month. Null when it names none.',
      },
      published_at: {
        type: 'timestamp',
        meaning: 'When GDELT read the earliest copy of the headline, UTC.',
      },
      judged_at: { type: 'timestamp', meaning: 'When the judge run that labeled it ran, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The earliest copy of the headline (the article read).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the GDELT file holding that copy was fetched, in UTC.',
      },
    },
    [tables.reportedFigures.judged_at, tables.reportedFigures.id],
    byColumn(tables.reportedFigures.judged_at),
    undefined,
    { lab: tables.reportedFigures.lab },
  ),
} satisfies Record<string, ExportTable>
