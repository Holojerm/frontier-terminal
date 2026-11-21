// What Amazon's 10-Qs and 10-Ks said about Anthropic in words before it tagged
// amzn:AnthropicMember (its 10-Q for the quarter to 2026-03-31, filed 2026-04-30). From
// the 10-Q for the quarter to 2023-09-30 the notes state each convertible note Amazon
// bought, what it committed to buy, the notes' fair value, and later the gains and upward
// marks Anthropic brought. Read from the primary document a sentence at a time against
// fixed wordings; a sentence that matches none is not read.
//
// Amazon's numbers, not Anthropic's. Where Amazon says a figure is "primarily" from
// Anthropic (its private-company marks, its gains on converted notes), the row says so.

import { decodeEntities } from '#layers/core/server/pipeline/parsers/html-text'

/** The kinds of figure read, as filed_text_facts.metric. */
export type TextMetric =
  | 'notes_invested'
  | 'notes_commitment'
  | 'notes_fair_value'
  | 'investment_value'
  | 'preferred_recorded'
  | 'upward_adjustment'
  | 'conversion_gain'
  | 'preferred_carrying_value'

export interface TextFact {
  metric: TextMetric
  /** Null for a balance or a commitment. */
  start: string | null
  end: string
  value: number
  /** 'approximately' or 'primarily' when the filing qualifies the figure, else null. */
  qualifier: string | null
  /** The sentence as the filing printed it. */
  sentence: string
}

/** The text filers, the lab their text names, and the filings read: from the first that names it to the first that tags it. */
export const TEXT_FACT_FILERS: Readonly<
  Record<string, { lab: 'anthropic'; name: RegExp; since: string; until: string }>
> = {
  AMZN: { lab: 'anthropic', name: /\bAnthropic\b/, since: '2023-10-01', until: '2026-04-30' },
}

const QUARTER_END = ['03-31', '06-30', '09-30', '12-31']
const QUARTER_START = ['01-01', '04-01', '07-01', '10-01']

const quarter = (q: string, year: string) => {
  const n = Number(q.replace(/^Q/, '')) - 1
  return { start: `${year}-${QUARTER_START[n]}`, end: `${year}-${QUARTER_END[n]}` }
}

const MONTHS: Record<string, string> = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
}

const dateOf = (month: string, day: string, year: string) =>
  `${year}-${MONTHS[month]}-${day.padStart(2, '0')}`

const usd = (n: string, scale: string) =>
  Math.round(Number(n.replace(/,/g, '')) * (scale === 'billion' ? 1e9 : 1e6))

const MONTH =
  '(January|February|March|April|May|June|July|August|September|October|November|December)'
const AMOUNT = String.raw`\$\s?([\d.,]+)\s(billion|million)`
const Q = String.raw`(Q[1-4])\s(\d{4})`

/** The filing's paragraphs as running text, each split into sentences. */
export function paragraphs(html: string): string[][] {
  if (!/<(?:html|body|div)\b/i.test(html)) throw new Error('not an HTML document')
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .split(/<\/(?:p|div|td)>/i)
    .map((block) =>
      decodeEntities(block.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .map((p) => p.split(/(?<=[a-z0-9)”"%])\.\s+(?=[A-Z“"])/).map((s) => s.replace(/\.?$/, '.')))
}

/** Every figure the filing's sentences state about the lab, in document order, each once. */
export function extractTextFacts(html: string, name: RegExp): TextFact[] {
  const out = new Map<string, TextFact>()
  const add = (f: TextFact) => {
    const key = `${f.metric}|${f.start}|${f.end}`
    if (!out.has(key)) out.set(key, f)
  }
  for (const sentences of paragraphs(html)) {
    if (!sentences.some((s) => name.test(s))) continue
    for (const s of sentences) {
      // "In Q1 2024, we invested $ 2.75 billion in a second convertible note."
      let m = new RegExp(
        String.raw`^In ${Q},? we (?:entered into an agreement and )?invested (?:in )?(?:a |an )?${AMOUNT}(?: in)? (?:a |an )?(?:(?:first|second|third|new) )?(?:convertible )?note`,
      ).exec(s)
      if (m)
        add({
          metric: 'notes_invested',
          ...quarter(m[1]!, m[2]!),
          value: usd(m[3]!, m[4]!),
          qualifier: null,
          sentence: s,
        })

      // "From Q3 2023 to Q4 2024, we invested $ 5.3 billion in convertible notes from Anthropic"
      m = new RegExp(
        String.raw`^From ${Q} to ${Q}, we invested ${AMOUNT} in convertible notes`,
      ).exec(s)
      if (m) {
        add({
          metric: 'notes_invested',
          start: quarter(m[1]!, m[2]!).start,
          end: quarter(m[3]!, m[4]!).end,
          value: usd(m[5]!, m[6]!),
          qualifier: null,
          sentence: s,
        })
      }

      // "… and will invest an additional $ 2.7 billion by Q4 2025."
      m = new RegExp(
        String.raw`will invest an additional ${AMOUNT}(?: in another convertible note)? (?:by|in) ${Q}`,
      ).exec(s)
      if (m)
        add({
          metric: 'notes_commitment',
          start: null,
          end: quarter(m[3]!, m[4]!).end,
          value: usd(m[1]!, m[2]!),
          qualifier: null,
          sentence: s,
        })

      // "… and as of December 31, 2024 had an estimated fair value of approximately $ 13.8 billion."
      m = new RegExp(
        String.raw`as of ${MONTH} (\d{1,2}), (\d{4}),? had an estimated fair value of (approximately )?${AMOUNT}`,
      ).exec(s)
      if (m)
        add({
          metric: 'notes_fair_value',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[3]!),
          value: usd(m[5]!, m[6]!),
          qualifier: m[4] ? 'approximately' : null,
          sentence: s,
        })

      // "As of June 30, 2025, the estimated fair value of our convertible notes and amounts recorded for nonvoting preferred stock investments was approximately $ 15.1 billion."
      m = new RegExp(
        String.raw`^As of ${MONTH} (\d{1,2}), (\d{4}), the estimated fair value of our convertible notes and amounts recorded for nonvoting preferred stock investments was (approximately )?${AMOUNT}`,
      ).exec(s)
      if (m)
        add({
          metric: 'investment_value',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[3]!),
          value: usd(m[5]!, m[6]!),
          qualifier: m[4] ? 'approximately' : null,
          sentence: s,
        })

      // "As of September 30, 2025, the amount recorded on our consolidated balance sheet for nonvoting preferred stock was approximately $ 14.8 billion."
      m = new RegExp(
        String.raw`^As of ${MONTH} (\d{1,2}), (\d{4}), the amount recorded on our consolidated balance sheet for nonvoting preferred stock was (approximately )?${AMOUNT}`,
      ).exec(s)
      if (m)
        add({
          metric: 'preferred_recorded',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[3]!),
          value: usd(m[5]!, m[6]!),
          qualifier: m[4] ? 'approximately' : null,
          sentence: s,
        })

      // "The upward adjustments relating to equity investments in private companies of $ 7.2 billion in Q3 2025 and $ 7.3 billion for the nine months ended September 30, 2025 reflect observable changes in prices, primarily from our nonvoting preferred stock in Anthropic."
      if (
        /^The upward adjustments relating to equity investments in private companies/.test(s) &&
        name.test(s)
      ) {
        periodFigures(s, 'upward_adjustment').forEach(add)
      }

      // "The reclassification adjustment(s) for the gain(s) on available-for-sale debt securities of $ 3.3 billion in Q1 2025 is primarily from … Anthropic …"
      if (
        /^The reclassification adjustments? for the gains? on available-for-sale debt securities/.test(
          s,
        ) &&
        name.test(s)
      ) {
        periodFigures(s, 'conversion_gain').forEach(add)
      }

      // "As of December 31, 2024 and September 30, 2025, equity investments in private companies …, which primarily relate to nonvoting preferred stock in Anthropic, had a carrying value of $ 989 million and $ 16.0 billion"
      m = new RegExp(
        String.raw`^As of ${MONTH} (\d{1,2}), (\d{4}) and ${MONTH} (\d{1,2}), (\d{4}), equity investments in private companies not accounted for under the equity-method, which primarily relate to nonvoting preferred stock in [A-Z]\w+, had a carrying value of ${AMOUNT} and ${AMOUNT}`,
      ).exec(s)
      if (m) {
        add({
          metric: 'preferred_carrying_value',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[3]!),
          value: usd(m[7]!, m[8]!),
          qualifier: 'primarily',
          sentence: s,
        })
        add({
          metric: 'preferred_carrying_value',
          start: null,
          end: dateOf(m[4]!, m[5]!, m[6]!),
          value: usd(m[9]!, m[10]!),
          qualifier: 'primarily',
          sentence: s,
        })
      }
      // The 10-K's wording: "As of December 31, 2024 and 2025, these investments had a carrying value of $ 989 million and $ 16.2 billion."
      m = new RegExp(
        String.raw`^As of ${MONTH} (\d{1,2}), (\d{4}) and (\d{4}), these investments had a carrying value of ${AMOUNT} and ${AMOUNT}`,
      ).exec(s)
      if (m && sentences.some((x) => /nonvoting preferred stock in/.test(x) && name.test(x))) {
        add({
          metric: 'preferred_carrying_value',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[3]!),
          value: usd(m[5]!, m[6]!),
          qualifier: 'primarily',
          sentence: s,
        })
        add({
          metric: 'preferred_carrying_value',
          start: null,
          end: dateOf(m[1]!, m[2]!, m[4]!),
          value: usd(m[7]!, m[8]!),
          qualifier: 'primarily',
          sentence: s,
        })
      }
    }
  }
  return [...out.values()]
}

/**
 * The figures one sentence states by period: "$ 7.2 billion in Q3 2025",
 * "$ 7.3 billion for the nine months ended September 30, 2025", "$ 7.7
 * billion for the year ended December 31, 2025". Each is primarily the lab's.
 */
function periodFigures(s: string, metric: TextMetric): TextFact[] {
  const out: TextFact[] = []
  const re = new RegExp(
    String.raw`${AMOUNT} (?:in ${Q}|for the (six|nine) months ended ${MONTH} (\d{1,2}), (\d{4})|for the year ended ${MONTH} (\d{1,2}), (\d{4}))`,
    'g',
  )
  for (const m of s.matchAll(re)) {
    const value = usd(m[1]!, m[2]!)
    if (m[3]) {
      out.push({ metric, ...quarter(m[3], m[4]!), value, qualifier: 'primarily', sentence: s })
    } else if (m[5]) {
      const year = m[8]!
      out.push({
        metric,
        start: `${year}-01-01`,
        end: dateOf(m[6]!, m[7]!, year),
        value,
        qualifier: 'primarily',
        sentence: s,
      })
    } else {
      const year = m[11]!
      out.push({
        metric,
        start: `${year}-01-01`,
        end: dateOf(m[9]!, m[10]!, year),
        value,
        qualifier: 'primarily',
        sentence: s,
      })
    }
  }
  return out
}
