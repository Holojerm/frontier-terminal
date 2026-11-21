// Fiscal calendars, by the month a company's fiscal year ends in. A fiscal
// year is named by the calendar year it ends in (NVIDIA's fiscal 2027 ends in
// January 2027). Companies on a 52/53-week year end a few days off the month
// end; every match against a filed period allows for that (PERIOD_SLACK_DAYS).

export interface FiscalPeriod {
  fiscal_year: number
  /** 1-4, or null for the whole year. */
  quarter: number | null
  start: string
  end: string
}

/** A filed period matches a guided one when both ends are within this many days. */
export const PERIOD_SLACK_DAYS = 10

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Add `n` months to a (year, month) pair, months 1-12. */
function addMonths(y: number, m: number, n: number): [number, number] {
  const t = y * 12 + (m - 1) + n
  return [Math.floor(t / 12), (t % 12) + 1]
}

/** The dates of a fiscal quarter, or of the whole fiscal year when `quarter` is null. */
export function fiscalPeriod(
  fyEndMonth: number,
  fiscal_year: number,
  quarter: number | null,
): FiscalPeriod {
  const [ey, em] =
    quarter === null
      ? [fiscal_year, fyEndMonth]
      : addMonths(fiscal_year, fyEndMonth, (quarter - 4) * 3)
  const months = quarter === null ? 12 : 3
  const [sy, sm] = addMonths(ey, em, -months + 1)
  return {
    fiscal_year,
    quarter,
    start: `${sy}-${pad(sm)}-01`,
    end: `${ey}-${pad(em)}-${pad(lastDay(ey, em))}`,
  }
}

/** The fiscal quarter that ends in a given calendar month. */
export function quarterEnding(fyEndMonth: number, year: number, month: number): FiscalPeriod {
  const behind = (((fyEndMonth - month) % 12) + 12) % 12
  const quarter = 4 - behind / 3
  const fiscal_year = month <= fyEndMonth ? year : year + 1
  return fiscalPeriod(fyEndMonth, fiscal_year, quarter)
}

/**
 * The quarter a call held on `callDate` reported: the newest quarter that
 * ended at least a week before it. Months off the calendar (a quarter ending
 * in February for a January year) never occur, so the month steps by three.
 */
export function reportedQuarter(fyEndMonth: number, callDate: string): FiscalPeriod {
  const [y, m, d] = callDate.split('-').map(Number) as [number, number, number]
  let [cy, cm] = d >= 8 ? [y, m - 1] : addMonths(y, m, -2)
  if (cm === 0) [cy, cm] = [y - 1, 12]
  for (let i = 0; i < 3; i++) {
    if ((((fyEndMonth - cm) % 3) + 3) % 3 === 0) return quarterEnding(fyEndMonth, cy, cm)
    ;[cy, cm] = addMonths(cy, cm, -1)
  }
  throw new Error(`no quarter end before ${callDate}`)
}

/** The quarter after `p` (p must be a quarter). */
export function nextQuarter(fyEndMonth: number, p: FiscalPeriod): FiscalPeriod {
  const q = p.quarter!
  return q === 4
    ? fiscalPeriod(fyEndMonth, p.fiscal_year + 1, 1)
    : fiscalPeriod(fyEndMonth, p.fiscal_year, q + 1)
}

/** "Q3 FY2027" for a non-calendar year, "Q3 2026" for a calendar one; "FY2027" or "2026" for a year. */
export function periodLabel(
  fyEndMonth: number,
  p: Pick<FiscalPeriod, 'fiscal_year' | 'quarter'>,
): string {
  const year = fyEndMonth === 12 ? String(p.fiscal_year) : `FY${p.fiscal_year}`
  return p.quarter === null ? year : `Q${p.quarter} ${year}`
}

const DAY_MS = 86_400_000
/** Days from `a` to `b`. */
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
