// Pure parsers for Korea Customs Service's export releases (customs.go.kr
// press board, bbsId 1362): the board listing, a release's own page, its
// document viewer's answer and the text the viewer extracts from the
// attachment (HWP, HWPX or PDF alike). Bytes in, values out; a body that
// isn't what KCS sends throws.

import type { PrintWindow } from '../../shared/utils/prints'
import type { PrintObservation } from './parse'

export const KCS_HOST = 'https://www.customs.go.kr'
/** Rows per board page. The board answers 10 to 50; larger pages have timed out. */
export const KCS_PAGE_SIZE = 20
/** The board searched on titles containing "수출입 현황" (export and import status). */
export const kcsBoardUrl = (page: number): string =>
  `${KCS_HOST}/kcs/na/ntt/selectNttList.do?mi=2891&bbsId=1362&listCo=${KCS_PAGE_SIZE}` +
  `&searchType=sj&searchValue=%EC%88%98%EC%B6%9C%EC%9E%85+%ED%98%84%ED%99%A9&currPage=${page}`
/** A release's own page. The board refuses the id without its hash. */
export const kcsReleaseUrl = (ntt_sn: string, ntt_url: string): string =>
  `${KCS_HOST}/kcs/na/ntt/selectNttInfo.do?mi=2891&bbsId=1362&nttSn=${ntt_sn}&nttSnUrl=${ntt_url}`
export const kcsViewerUrl = (file_key: string): string =>
  `${KCS_HOST}/streamdocs/v4/documents/view/tnnf/${file_key}`
export const kcsTextsUrl = (doc_id: string): string =>
  `${KCS_HOST}/streamdocs/v4/documents/${doc_id}/texts`

export interface KcsListing {
  ntt_sn: string
  ntt_url: string
  title: string
  /** The board's posting date, YYYY-MM-DD. */
  posted: string
}

const unescape = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

/** One page of the board: its rows and the result count it states ("전체 471건"). */
export function parseKcsBoard(html: string): { total: number; rows: KcsListing[] } {
  const total = /전체\s*<span>\s*([\d,]+)\s*<\/span>\s*건/.exec(html)
  if (!total) throw new Error('kcs board: no result count')
  const rows: KcsListing[] = []
  const row =
    /data-id="(\d+)"\s+data-url="([0-9a-f]+)"\s+class="nttInfoBtn"\s+title="([^"]*)"[\s\S]*?data-table="date">\s*(\d{4})\.(\d{2})\.(\d{2})/g
  for (const m of html.matchAll(row)) {
    rows.push({
      ntt_sn: m[1]!,
      ntt_url: m[2]!,
      title: unescape(m[3]!).replace(/\s+/g, ' ').trim(),
      posted: `${m[4]}-${m[5]}-${m[6]}`,
    })
  }
  return { total: Number(total[1]!.replace(/,/g, '')), rows }
}

export interface KcsRelease {
  /** The month the figure is for, YYYY-MM. */
  period: string
  window: PrintWindow
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Which figure a release is for, from its board title: the first 10 or 20
 * days of a month, or a month. A title without a year ("10월 수출입
 * 현황(확정치)") takes the year it was posted in, or the year before for a
 * month after the posting month. null for a release of anything else: the
 * annual review, the figures by company size, an FTA's use.
 */
export function kcsRelease(title: string, posted: string): KcsRelease | null {
  if (/기업|협정|품목별|국가별/.test(title)) return null
  const yearOf = (m: number, y: string | undefined) => {
    if (y) return y.length === 4 ? Number(y) : 2000 + Number(y)
    const py = Number(posted.slice(0, 4))
    return m > Number(posted.slice(5, 7)) ? py - 1 : py
  }
  const days =
    /(?:(\d{4}|\d{2})\s*년\s*)?(\d{1,2})\s*(?:월\s*1\s*일|\.\s*1)\s*[~∼～\-–]\s*(?:\d{1,2}\s*월\s*)?(10|20)\s*일?\s*수출입/.exec(
      title,
    )
  if (days) {
    const m = Number(days[2])
    if (m < 1 || m > 12) return null
    return { period: `${yearOf(m, days[1])}-${pad(m)}`, window: days[3] === '10' ? 'd10' : 'd20' }
  }
  const month =
    /(?:(\d{4}|\d{2})\s*년\s*(?:연간\s*및\s*)?)?(\d{1,2})\s*월\s*(?:및\s*연간\s*|월간\s*)?수출입\s*현황/.exec(
      title,
    )
  if (!month) return null
  const m = Number(month[2])
  if (m < 1 || m > 12) return null
  return { period: `${yearOf(m, month[1])}-${pad(m)}`, window: 'month' }
}

export interface KcsReleasePage {
  /** The page states KOGL Type 1 ("출처표시": commercial use and changes allowed, with the source). */
  kogl_type1: boolean
  /** The attachments the document viewer opens, as KCS names them. */
  attachments: { name: string; file_key: string }[]
}

/** A release's own page: its licence mark and its viewable attachments. */
export function parseKcsReleasePage(html: string): KcsReleasePage {
  if (!html.includes('nttFileDownload.do') && !html.includes('list_file')) {
    throw new Error('kcs release page: no attachment list')
  }
  const attachments = [
    ...html.matchAll(
      /viewer\('\/streamdocs\/v4\/documents\/view\/tnnf\/([0-9a-f]+)'\)[^>]*title="([^"]+?)\s*바로보기/g,
    ),
  ].map((m) => ({ file_key: m[1]!, name: unescape(m[2]!).trim() }))
  // The KOGL block names its type by image and by link: both must say Type 1.
  const kogl_type1 =
    /images\/board\/kogl\/new_img_opentype01\.png/.test(html) &&
    /kogl\.or\.kr\/info\/licenseType1\.do/.test(html)
  return { kogl_type1, attachments }
}

/** The attachment whose text is read: the PDF where there is one, else the first. */
export function kcsAttachment(page: KcsReleasePage): { name: string; file_key: string } | null {
  return page.attachments.find((a) => /\.pdf$/i.test(a.name)) ?? page.attachments[0] ?? null
}

/** The viewer's JSONP answer, `viewCallback({"url":"<document id>","status":"SUCCESS"})`. */
export function parseKcsViewer(body: string): string {
  const m = /viewCallback\(\s*(\{[\s\S]*\})\s*\)/.exec(body)
  if (!m) throw new Error('kcs viewer: not a viewCallback answer')
  const v = JSON.parse(m[1]!) as { url?: unknown; status?: unknown }
  if (v.status !== 'SUCCESS' || typeof v.url !== 'string' || !/^\d+$/.test(v.url)) {
    throw new Error(`kcs viewer: ${String(v.status)}`)
  }
  return v.url
}

// ── the release text ──────────────────────────────────────────────────────

/** "1,234" → 1234. */
const num = (s: string) => Number(s.replace(/[,\s]/g, ''))
/** "△24.7" (KCS's minus) or "24.7" → a number. */
const change = (s: string) => {
  const v = Number(s.replace(/[△▽\s]/g, '').replace(/^-/, ''))
  return /[△▽-]/.test(s) ? -v : v
}

/** The multiplier a 단위 (unit) line states for US dollars. */
function unitOf(text: string, at: number): number {
  const from = text.lastIndexOf('단위', at)
  if (from < 0) throw new Error('kcs: no unit before the chip row')
  const unit = text.slice(from, from + 40).replace(/\s+/g, '')
  if (/^단위[:：]?(백만달러|백만불|백만\$)/.test(unit)) return 1e6
  if (/^단위[:：]?(억달러|억불)/.test(unit)) return 1e8
  if (/^단위[:：]?(천달러|천불)/.test(unit)) return 1e3
  throw new Error(`kcs: unit not in dollars: ${unit.slice(0, 20)}`)
}

/** "98억 3천만 달러" → 9.83e9; "567억 달러" → 5.67e10. Returns the value and its precision. */
function eok(m: RegExpExecArray, at: number): { value: number; step: number } {
  const eokPart = num(m[at]!)
  const cheon = m[at + 1] ? Number(m[at + 1]) * 1e7 : 0
  const baek = m[at + 2] ? Number(m[at + 2]) * 1e6 : 0
  return { value: eokPart * 1e8 + cheon + baek, step: m[at + 2] ? 1e6 : m[at + 1] ? 1e7 : 1e8 }
}

const EOK = '([\\d,.]+)\\s*억(?:\\s*(\\d)\\s*천)?(?:\\s*(\\d)\\s*백)?\\s*만?\\s*달러'

/** The year and month a release's text says it is for, from its title line. */
function statesPeriod(text: string, period: string): boolean {
  const head = text.slice(0, 800).replace(/\s+/g, '')
  const y = period.slice(0, 4)
  const m = Number(period.slice(5, 7))
  const year = new RegExp(`(${y}|[’‘']${y.slice(2)}|^${y.slice(2)}|[^\\d]${y.slice(2)})년`)
  return year.test(head) && new RegExp(`(^|[^\\d])${m}월`).test(head)
}

/** When the release says it may be reported (보도시점), in UTC; null when it gives only a date. */
export function kcsPublishedAt(text: string): string | null {
  const m =
    /(?:보도시점|보도일시)[^\n]{0,40}?(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(?:\([^)]{1,3}\))?\s*(\d{1,2}):(\d{2})/.exec(
      text.slice(0, 600),
    )
  if (!m) return null
  // KST is UTC+9 and has no daylight saving.
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 9, +m[5]!)
  return new Date(utc).toISOString()
}

export type KcsReading =
  | { kind: 'figures'; observations: PrintObservation[] }
  | { kind: 'none'; reason: string }

/**
 * The semiconductor export figure a release states, with its year-on-year
 * change. The 10- and 20-day releases since 2021 list it in their annex
 * table ("반 도 체 16,632 331.2", US$ million); the month's confirmed
 * release lists it in its table by commodity ("(반 도 체) 15,862 56,702
 * 257.5": a year earlier, the month, the change) and states it in a
 * sentence in 억 달러 (US$ 100 million). A table figure is checked against
 * the sentence or headline wherever both are given, and a disagreement
 * throws. A release that states only the change, or no chip figure at all
 * (the provisional monthly release on the 1st), reads as none.
 */
export function parseKcsChipExports(text: string, release: KcsRelease): KcsReading {
  const t = text.replace(/ /g, ' ').replace(/\r/g, '')
  if (!statesPeriod(t, release.period)) {
    return { kind: 'none', reason: `the attachment is not the ${release.period} release` }
  }
  const published_at = kcsPublishedAt(t)
  const base = {
    series: 'kr_chip_exports' as const,
    entity: 'kr-semiconductors',
    ticker: null,
    window: release.window,
    currency: 'USD' as const,
    published_at,
    due_on: null,
  }

  // The sentence and the headline, in 억 달러.
  const sentence = new RegExp(
    `\\(\\s*반\\s*도\\s*체\\s*\\)\\s*전년\\s*동[월기]\\s*대비\\s*([\\d.]+)\\s*%\\s*(증가|감소)한\\s*${EOK}`,
  ).exec(t)
  const headline = new RegExp(
    `반도체(?:\\s*수출)?\\s*\\(\\s*${EOK.replace('달러', '달러\\s*\\)')}`,
  ).exec(t)
  const stated = sentence
    ? { ...eok(sentence, 3), yoy: change((sentence[2] === '감소' ? '△' : '') + sentence[1]) }
    : headline
      ? { ...eok(headline, 1), yoy: null }
      : null

  // The table row, in the unit the table states.
  const row =
    release.window === 'month'
      ? /^[ \t]*\(\s*반\s*도\s*체\s*\)[ \t]+([\d,]+)[ \t]+([\d,]+)[ \t]+(△?\s*-?[\d.]+)/m.exec(t)
      : /^[ \t]*반\s*도\s*체[ \t]+([\d,]+)[ \t]+(△?\s*-?[\d.]+)/m.exec(t)

  let value: number
  let yoy: number | null
  let yearAgo: number | null = null
  if (row) {
    const unit = unitOf(t, row.index)
    if (release.window === 'month') {
      yearAgo = num(row[1]!) * unit
      value = num(row[2]!) * unit
      yoy = change(row[3]!)
    } else {
      value = num(row[1]!) * unit
      yoy = change(row[2]!)
    }
    if (stated && Math.abs(stated.value - value) >= stated.step) {
      throw new Error(
        `kcs ${release.period} ${release.window}: table ${value} against stated ${stated.value}`,
      )
    }
    if (stated?.yoy != null && Math.abs(stated.yoy - yoy) > 0.05) {
      throw new Error(
        `kcs ${release.period} ${release.window}: table change ${yoy} against stated ${stated.yoy}`,
      )
    }
  } else if (stated && (release.window === 'month' || stated.yoy !== null)) {
    value = stated.value
    yoy = stated.yoy
  } else {
    return { kind: 'none', reason: 'no chip export figure' }
  }

  const observations: PrintObservation[] = [
    { ...base, period: release.period, value, yoy_pct: yoy, observed_as: 'print' },
  ]
  if (yearAgo !== null) {
    const y = Number(release.period.slice(0, 4)) - 1
    observations.push({
      ...base,
      period: `${y}${release.period.slice(4)}`,
      value: yearAgo,
      yoy_pct: null,
      observed_as: 'year_ago',
    })
  }
  return { kind: 'figures', observations }
}
