// Daily closes from Databento's historical API, for the signals harness only.
// The bars are licensed for internal use: they go into market_bars and never
// leave it, except as the statistics the harness derives
// (layers/signals/test/signals-private.test.ts).
//
// Two datasets, joined at EQUS_FROM:
// - EQUS.SUMMARY ohlcv-1d, the consolidated official close, from 2024-07-01
//   (where the dataset begins). Pulled daily, the last few sessions again each
//   time in case a late print revises one.
// - XNAS.ITCH ohlcv-1h before that, back to 2018-05-01: the close of the 15:00
//   ET bar, the last Nasdaq trade before the closing cross. Its daily bars run
//   to midnight UTC, so their close is an after-hours trade. Checked against
//   EQUS.SUMMARY: AVGO's 15:00 ET bar on 2024-06-28 closes at the official
//   1605.53. Backfilled once per symbol.
//
// Prices are split-adjusted from KNOWN_SPLITS at read time. Dividends are not
// added back: Databento's adjustment factors need a subscription this account
// doesn't have, so returns are price returns.

import { sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const EQUS_DATASET = 'EQUS.SUMMARY'
const ITCH_DATASET = 'XNAS.ITCH'
const EQUS_FROM = '2024-07-01'
const ITCH_FROM = '2018-05-01'
export const ITCH_THROUGH = '2024-06-30'
/** Symbols backfilled a run: about 1,500 sessions each, so a run stays well inside a cron invocation. */
export const BACKFILL_PER_RUN = 16
/** Symbols per request on a symbol's first daily pull, which asks for the whole dataset. */
const FIRST_PULL_BATCH = 12
/** Sessions re-pulled on each daily run, for prints revised after the fact. */
const REPULL_DAYS = 7

/** The benchmarks every abnormal return is measured against. */
export const BENCHMARKS = ['SPY', 'QQQ'] as const

/**
 * Every symbol pulled: the listed companies in /api/listed, Anthropic's own
 * listing, and the benchmarks. A ticker the registry names must be here
 * (signals-registry.test.ts), and every ticker the curated supplier and power
 * tables name is checked against it too.
 */
export const MARKET_SYMBOLS = [
  'MSFT',
  'AMZN',
  'GOOGL',
  'META',
  'ORCL',
  'AMD',
  'ARM',
  'AVGO',
  'CBRS',
  'INTC',
  'MRVL',
  'NVDA',
  'MU',
  'QCOM',
  'TSM',
  'ALAB',
  'ANET',
  'CRDO',
  'AAOI',
  'CIEN',
  'COHR',
  'FN',
  'LITE',
  'CLS',
  'DELL',
  'HPE',
  'SMCI',
  'AKAM',
  'CRWV',
  'IREN',
  'NBIS',
  'APLD',
  'CIFR',
  'CORZ',
  'GLXY',
  'HUT',
  'RIOT',
  'WULF',
  'AEP',
  'BE',
  'DTE',
  'ETR',
  'GEV',
  'PNW',
  'WEC',
  'WMB',
  'ANT',
  ...BENCHMARKS,
] as const

/** A symbol that traded under another ticker before a date (inclusive). */
const SYMBOL_ALIASES: Readonly<Record<string, readonly { symbol: string; until: string }[]>> = {
  META: [{ symbol: 'FB', until: '2022-06-08' }],
  // II-VI took Coherent's ticker when it bought Coherent; COHR before then is the old company.
  COHR: [{ symbol: 'IIVI', until: '2022-09-07' }],
}

/**
 * Where a symbol's usable history begins, when its closes before that are a
 * different security: an old equity cancelled in bankruptcy, a predecessor
 * company, a spin-off the closes don't adjust for, or thin prints on the
 * Nasdaq feed before a listing moved.
 */
const HISTORY_FROM: Readonly<Record<string, { date: string; why: string }>> = {
  CORZ: { date: '2024-01-24', why: 'relisted out of bankruptcy; the old equity was cancelled' },
  HUT: { date: '2023-12-04', why: 'Hut 8 Corp, the merged company, replaced Hut 8 Mining' },
  DELL: { date: '2021-11-02', why: 'the VMware spin-off, which the closes don’t adjust for' },
  APLD: {
    date: '2022-07-19',
    why: 'thin Nasdaq prints around its move to the Nasdaq Global Select',
  },
}

/** Overnight moves unexplainedJumps() would flag that are real: checked against the news, not a split. */
const CONFIRMED_MOVES: readonly string[] = [
  'CRDO 2023-02-15', // guidance cut on a customer's lower orders
  'CIFR 2022-05-10', // the May 2022 crypto selloff
]

/**
 * Forward splits since ITCH_FROM among MARKET_SYMBOLS: on `date` each share
 * became `ratio` shares, so every close before it is divided by `ratio`.
 * unexplainedJumps() flags any overnight move this list doesn't account for.
 */
const KNOWN_SPLITS: readonly { symbol: string; date: string; ratio: number }[] = [
  { symbol: 'NVDA', date: '2021-07-20', ratio: 4 },
  { symbol: 'NVDA', date: '2024-06-10', ratio: 10 },
  { symbol: 'AVGO', date: '2024-07-15', ratio: 10 },
  { symbol: 'AMZN', date: '2022-06-06', ratio: 20 },
  { symbol: 'GOOGL', date: '2022-07-18', ratio: 20 },
  { symbol: 'SMCI', date: '2024-10-01', ratio: 10 },
  { symbol: 'ANET', date: '2021-11-18', ratio: 4 },
  { symbol: 'ANET', date: '2024-12-04', ratio: 4 },
  { symbol: 'ETR', date: '2024-12-13', ratio: 2 },
]

interface Bar {
  symbol: string
  date: string
  close: number
  volume: number
}

interface MarketDeps {
  apiKey: string
  fetch: typeof fetch
  now: Date
  /** Between retries; tests pass a no-op. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

// ── Databento ───────────────────────────────────────────────────────────────

function authHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`
}

interface CsvBar {
  ts: string
  close: number
  volume: number
  symbol: string
}

/**
 * Reads CSV lines into bars, header first. Fed a line at a time, so a large
 * response is parsed as it streams and never held whole.
 */
function csvReader(onBar: (bar: CsvBar) => void) {
  let cols: { ts: number; close: number; volume: number; symbol: number } | null = null
  return (line: string) => {
    if (!line) return
    const cells = line.split(',')
    if (!cols) {
      const at = (name: string) => cells.indexOf(name)
      cols = { ts: at('ts_event'), close: at('close'), volume: at('volume'), symbol: at('symbol') }
      if (Object.values(cols).includes(-1)) {
        throw new Error(`Databento CSV header lacks a column: ${line.slice(0, 200)}`)
      }
      return
    }
    const close = Number(cells[cols.close])
    const volume = Number(cells[cols.volume])
    if (!Number.isFinite(close) || close <= 0) return
    onBar({
      ts: cells[cols.ts] ?? '',
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      symbol: cells[cols.symbol] ?? '',
    })
  }
}

async function eachLine(res: Response, onLine: (line: string) => void): Promise<void> {
  if (!res.body) {
    for (const line of (await res.text()).split('\n')) onLine(line)
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  for (;;) {
    const { done, value } = await reader.read()
    rest += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) onLine(line)
    if (done) break
  }
  onLine(rest)
}

/** Waits before each retry of a Databento request that failed with a gateway error. */
const RETRY_DELAYS_MS = [2_000, 8_000] as const

/**
 * A request retried on 429 and 5xx. Databento's edge answers a slow query with
 * a bare 504 that a second try usually clears (2026-11-21: the first run's one
 * pull failed that way, and the same query from the mini took 3.5 s).
 */
async function withRetry(
  deps: Pick<MarketDeps, 'sleep'>,
  attempt: () => Promise<Response>,
): Promise<Response> {
  let res = await attempt()
  for (const delay of RETRY_DELAYS_MS) {
    if (res.status !== 429 && res.status < 500) return res
    await (deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(delay)
    res = await attempt()
  }
  return res
}

const post = (
  deps: Pick<MarketDeps, 'apiKey' | 'fetch' | 'sleep'>,
  path: string,
  body: URLSearchParams,
) =>
  withRetry(deps, () =>
    deps.fetch(`${DATABENTO_BASE}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(deps.apiKey),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }),
  )

/**
 * Where a dataset's data ends now, as the ISO instant Databento gives. A
 * request whose end is later is refused (422), so every pull is clamped to it.
 */
async function datasetEnd(
  deps: Pick<MarketDeps, 'apiKey' | 'fetch' | 'sleep'>,
  dataset: string,
  schema: string,
): Promise<string> {
  const res = await withRetry(deps, () =>
    deps.fetch(`${DATABENTO_BASE}/metadata.get_dataset_range?${new URLSearchParams({ dataset })}`, {
      headers: { Authorization: authHeader(deps.apiKey) },
    }),
  )
  const text = await res.text()
  if (!res.ok)
    throw new Error(`Databento ${dataset} range ${res.status}: ${databentoMessage(text)}`)
  const range = JSON.parse(text) as { end?: string; schema?: Record<string, { end?: string }> }
  const end = range.schema?.[schema]?.end ?? range.end
  if (!end) throw new Error(`Databento ${dataset} range has no end`)
  return end
}

/** One timeseries.get_range request as CSV, streamed row by row. Throws with Databento's message, never the key. */
async function getRange(
  deps: Pick<MarketDeps, 'apiKey' | 'fetch' | 'sleep'>,
  q: { dataset: string; symbols: readonly string[]; schema: string; start: string; end: string },
  onBar: (bar: CsvBar) => void,
): Promise<void> {
  const res = await post(
    deps,
    'timeseries.get_range',
    new URLSearchParams({
      dataset: q.dataset,
      symbols: q.symbols.join(','),
      schema: q.schema,
      start: q.start,
      end: q.end,
      encoding: 'csv',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
      stype_in: 'raw_symbol',
    }),
  )
  if (!res.ok) {
    throw new Error(`Databento ${q.dataset} ${res.status}: ${databentoMessage(await res.text())}`)
  }
  await eachLine(res, csvReader(onBar))
}

function databentoMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: { message?: string } | string }
    const detail = parsed.detail
    return (typeof detail === 'string' ? detail : detail?.message) ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** EQUS.SUMMARY daily bars: one per session, stamped at midnight UTC of the session date. */
export function dailyBar(b: CsvBar): Bar {
  return { symbol: b.symbol, date: b.ts.slice(0, 10), close: b.close, volume: b.volume }
}

/** Whether US Eastern time is on daylight saving on this date (second Sunday of March to first Sunday of November). */
export function easternDst(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  if (m < 3 || m > 11) return false
  if (m > 3 && m < 11) return true
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const firstSunday = 1 + ((7 - firstDow) % 7)
  return m === 3 ? d >= firstSunday + 7 : d < firstSunday
}

/**
 * XNAS.ITCH hourly bars to one close per session: the bar that opens at 15:00
 * ET (19:00 UTC on daylight time, 20:00 otherwise). Volume is the session's
 * hourly bars summed. `symbol` is the ticker the bars are stored under, the
 * same across an old ticker and its new one.
 */
export function hourlyCollector(symbol: string) {
  const days = new Map<string, Bar>()
  const volume = new Map<string, number>()
  return {
    add(b: CsvBar) {
      const date = b.ts.slice(0, 10)
      const hour = Number(b.ts.slice(11, 13))
      volume.set(date, (volume.get(date) ?? 0) + b.volume)
      if (hour === (easternDst(date) ? 19 : 20))
        days.set(date, { symbol, date, close: b.close, volume: 0 })
    },
    bars(): Bar[] {
      return [...days.values()].map((bar) => ({ ...bar, volume: volume.get(bar.date) ?? 0 }))
    },
  }
}

/** A whole CSV body through csvReader, for tests and small responses. */
export function readCsv(text: string): CsvBar[] {
  const out: CsvBar[] = []
  const read = csvReader((b) => out.push(b))
  for (const line of text.split('\n')) read(line)
  return out
}

// ── storage ─────────────────────────────────────────────────────────────────

const SYMBOL_RE = /^[A-Z][A-Z.]{0,9}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ROWS_PER_INSERT = 400

/**
 * Upserts bars as multi-row literal inserts: D1 binds at most 100 parameters
 * a statement, which would make a backfill tens of thousands of statements.
 * Every value is checked against a strict pattern or is a finite number
 * before it is written into the SQL.
 */
async function storeBars(
  db: PipelineDb,
  bars: readonly Bar[],
  dataset: string,
  fetchedAt: string,
): Promise<number> {
  if (!/^[A-Z]+\.[A-Z]+$/.test(dataset)) throw new Error(`bad dataset ${dataset}`)
  if (!/^[0-9T:.\-Z]+$/.test(fetchedAt)) throw new Error(`bad timestamp ${fetchedAt}`)
  const valid = bars.filter(
    (b) =>
      SYMBOL_RE.test(b.symbol) &&
      DATE_RE.test(b.date) &&
      Number.isFinite(b.close) &&
      Number.isFinite(b.volume),
  )
  for (let i = 0; i < valid.length; i += ROWS_PER_INSERT) {
    const values = valid
      .slice(i, i + ROWS_PER_INSERT)
      .map(
        (b) =>
          `('${b.symbol}','${b.date}',${b.close},${Math.round(b.volume)},'${dataset}','${fetchedAt}')`,
      )
      .join(',')
    await db.run(
      sql.raw(
        `INSERT INTO market_bars (symbol, date, close, volume, dataset, fetched_at) VALUES ${values} ` +
          'ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close, volume = excluded.volume, ' +
          'dataset = excluded.dataset, fetched_at = excluded.fetched_at',
      ),
    )
  }
  return valid.length
}

async function markFetched(
  db: PipelineDb,
  row: typeof tables.marketFetches.$inferInsert,
): Promise<void> {
  await db
    .insert(tables.marketFetches)
    .values(row)
    .onConflictDoUpdate({
      target: [tables.marketFetches.symbol, tables.marketFetches.dataset],
      set: { through: row.through, rows: row.rows, fetched_at: row.fetched_at },
    })
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

export interface PullReport {
  daily: { symbols: number; rows: number; start: string | null }
  backfilled: { symbol: string; rows: number }[]
  failed: { what: string; detail: string }[]
}

/**
 * One run: the consolidated daily bars since each symbol's last pull, then the
 * Nasdaq hourly backfill for up to `backfillLimit` symbols that lack it. A
 * failure is reported and the rest carries on.
 */
export async function pullMarket(
  db: PipelineDb,
  deps: MarketDeps,
  opts: { symbols?: readonly string[]; backfillLimit?: number } = {},
): Promise<PullReport> {
  const symbols = opts.symbols ?? MARKET_SYMBOLS
  const fetchedAt = deps.now.toISOString()
  const fetches = await db.select().from(tables.marketFetches)
  const through = (symbol: string, dataset: string) =>
    fetches.find((f) => f.symbol === symbol && f.dataset === dataset)?.through ?? null
  const report: PullReport = {
    daily: { symbols: 0, rows: 0, start: null },
    backfilled: [],
    failed: [],
  }

  // Daily: symbols never pulled get the whole dataset; the rest one request
  // from the oldest of their last pulls, less the re-pull window.
  const fresh = symbols.filter((s) => through(s, EQUS_DATASET) === null)
  const known = symbols.filter((s) => through(s, EQUS_DATASET) !== null)
  const groups: { symbols: readonly string[]; start: string }[] = []
  // A first pull asks for the whole dataset, so it goes in small batches: one
  // slow batch then fails alone and the rest still land.
  for (let i = 0; i < fresh.length; i += FIRST_PULL_BATCH) {
    groups.push({ symbols: fresh.slice(i, i + FIRST_PULL_BATCH), start: EQUS_FROM })
  }
  if (known.length) {
    const oldest = known.map((s) => through(s, EQUS_DATASET)!).sort()[0]!
    const start = addDays(oldest, -REPULL_DAYS)
    groups.push({ symbols: known, start: start < EQUS_FROM ? EQUS_FROM : start })
  }
  let end: string | null = null
  try {
    end = await datasetEnd(deps, EQUS_DATASET, 'ohlcv-1d')
  } catch (error) {
    report.failed.push({ what: `${EQUS_DATASET} range`, detail: messageOf(error) })
  }
  // The range ends at midnight UTC after the newest session it holds.
  const asked = end ? addDays(end.slice(0, 10), -1) : null
  for (const group of end && asked ? groups : []) {
    try {
      const bars: Bar[] = []
      await getRange(
        deps,
        {
          dataset: EQUS_DATASET,
          symbols: group.symbols,
          schema: 'ohlcv-1d',
          start: group.start,
          end: end!,
        },
        (b) => {
          if (group.symbols.includes(b.symbol)) bars.push(dailyBar(b))
        },
      )
      report.daily.rows += await storeBars(db, bars, EQUS_DATASET, fetchedAt)
      report.daily.symbols += group.symbols.length
      report.daily.start =
        report.daily.start && report.daily.start < group.start ? report.daily.start : group.start
      for (const symbol of group.symbols) {
        // `through` is how far we asked, so a symbol not listed yet is asked
        // only for the re-pull window from now on.
        await markFetched(db, {
          symbol,
          dataset: EQUS_DATASET,
          start: through(symbol, EQUS_DATASET) ? group.start : EQUS_FROM,
          through: asked!,
          rows: bars.filter((b) => b.symbol === symbol).length,
          fetched_at: fetchedAt,
        })
      }
    } catch (error) {
      report.failed.push({ what: `${EQUS_DATASET} from ${group.start}`, detail: messageOf(error) })
    }
  }

  // Backfill: one symbol a request, so a large history never shares memory.
  const missing = symbols.filter((s) => through(s, ITCH_DATASET) === null)
  for (const symbol of missing.slice(0, opts.backfillLimit ?? BACKFILL_PER_RUN)) {
    try {
      const legs = [...(SYMBOL_ALIASES[symbol] ?? [])]
      const pieces: { ticker: string; start: string; end: string }[] = []
      let start = ITCH_FROM
      for (const leg of legs) {
        pieces.push({ ticker: leg.symbol, start, end: addDays(leg.until, 1) })
        start = addDays(leg.until, 1)
      }
      pieces.push({ ticker: symbol, start, end: addDays(ITCH_THROUGH, 1) })
      let rows = 0
      for (const piece of pieces) {
        const collect = hourlyCollector(symbol)
        await getRange(
          deps,
          {
            dataset: ITCH_DATASET,
            symbols: [piece.ticker],
            schema: 'ohlcv-1h',
            start: piece.start,
            end: piece.end,
          },
          (b) => collect.add(b),
        )
        const bars = collect.bars().filter((b) => b.date >= piece.start && b.date < piece.end)
        rows += await storeBars(db, bars, ITCH_DATASET, fetchedAt)
      }
      await markFetched(db, {
        symbol,
        dataset: ITCH_DATASET,
        start: ITCH_FROM,
        through: ITCH_THROUGH,
        rows,
        fetched_at: fetchedAt,
      })
      report.backfilled.push({ symbol, rows })
    } catch (error) {
      report.failed.push({ what: `${ITCH_DATASET} ${symbol}`, detail: messageOf(error) })
    }
  }
  return report
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ── reading ─────────────────────────────────────────────────────────────────

/** A symbol's closes divided back through every split after each date. */
export function adjustSplits(
  bars: readonly { date: string; close: number }[],
  splits: readonly { date: string; ratio: number }[],
): { date: string; close: number }[] {
  return bars.map((b) => {
    let factor = 1
    for (const s of splits) if (b.date < s.date) factor *= s.ratio
    return { date: b.date, close: b.close / factor }
  })
}

/**
 * Overnight moves past -45% or +80% in adjusted closes: a split or reverse
 * split KNOWN_SPLITS lacks, or a real crash. The run reports them so a person
 * can check.
 */
export function unexplainedJumps(
  symbol: string,
  adjusted: readonly { date: string; close: number }[],
): string[] {
  const out: string[] = []
  for (let i = 1; i < adjusted.length; i++) {
    const ratio = adjusted[i]!.close / adjusted[i - 1]!.close
    const at = `${symbol} ${adjusted[i]!.date}`
    if ((ratio < 0.55 || ratio > 1.8) && !CONFIRMED_MOVES.includes(at)) out.push(at)
  }
  return out
}

/** Split-adjusted closes on one trading calendar (the benchmark's sessions). */
export interface PricePanel {
  dates: string[]
  close: Map<string, (number | null)[]>
  jumps: string[]
}

export async function readPanel(db: PipelineDb): Promise<PricePanel> {
  const rows = await db
    .select({
      symbol: tables.marketBars.symbol,
      date: tables.marketBars.date,
      close: tables.marketBars.close,
    })
    .from(tables.marketBars)
  return buildPanel(rows)
}

export function buildPanel(
  rows: readonly { symbol: string; date: string; close: number }[],
): PricePanel {
  const bySymbol = new Map<string, { date: string; close: number }[]>()
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? []
    list.push({ date: r.date, close: r.close })
    bySymbol.set(r.symbol, list)
  }
  const calendar = (bySymbol.get('SPY') ?? []).map((b) => b.date).sort()
  const index = new Map(calendar.map((d, i) => [d, i]))
  const close = new Map<string, (number | null)[]>()
  const jumps: string[] = []
  for (const [symbol, list] of bySymbol) {
    const from = HISTORY_FROM[symbol]?.date ?? ''
    const usable = list.filter((b) => b.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1))
    const adjusted = adjustSplits(
      usable,
      KNOWN_SPLITS.filter((s) => s.symbol === symbol),
    )
    jumps.push(...unexplainedJumps(symbol, adjusted))
    const series: (number | null)[] = Array.from({ length: calendar.length }, () => null)
    for (const b of adjusted) {
      const i = index.get(b.date)
      if (i !== undefined) series[i] = b.close
    }
    close.set(symbol, series)
  }
  return { dates: calendar, close, jumps }
}
