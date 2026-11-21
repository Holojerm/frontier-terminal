// A call document's text, ready for the guidance parser: the words a PDF
// reader split back together, sentences cut where a sentence ends (never at
// "$9.8" or "U.S."), and each sentence with the page it is on. Pure.

import { releaseBlocks } from '../exposure/guidance'
import { pdfPages } from '#layers/core/server/pipeline/pdf-text'
import type { SpokenSentence } from './assemblyai'

export interface DocSentence {
  text: string
  /** 1-based PDF page, or null for HTML and audio. */
  page: number | null
  /** Milliseconds into the replay (audio only). */
  at_ms: number | null
  speaker: string | null
}

const WORD = /^[A-Za-z]+$/

/** Above this share of one-letter tokens (other than "a" and "I"), a text is letter-spaced. */
export const LETTER_SPACED = 0.08

// Glyph-by-glyph layouts (S&P's transcripts) come out "o f  o u r": one space
// between letters, two between words. A run of four or more single
// characters is closed up; the double space stays a word break.
function unspace(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean)
  const single = tokens.filter((t) => /^[b-zB-HJ-Z]$/.test(t)).length
  // A letter-spaced document: a run of single characters is one word ("t o",
  // "a n d", "4 5 %"), and a digit split off a number rejoins it ("$5 0").
  if (tokens.length > 200 && single / tokens.length > LETTER_SPACED) {
    return text
      .replace(/(?<!\S)\S(?: \S(?!\S))+/g, (run) => run.replace(/ /g, ''))
      .replace(/(\d) (?=\d(?!\S))/g, '$1')
      .replace(/ {2,}/g, ' ')
  }
  return text
    .split(/( {2,}|\n)/)
    .map((chunk) => chunk.replace(/(?<!\S)(?:\S ){3,}\S(?!\S)/g, (run) => run.replace(/ /g, '')))
    .join('')
    .replace(/ {2,}/g, ' ')
}

/** Words a PDF often splits once ("billio n"), healed wherever they appear. */
const HEAL = [
  'billion',
  'million',
  'trillion',
  'minus',
  'percent',
  'revenue',
  'revenues',
  'expect',
  'expects',
  'quarter',
  'guidance',
  'capital',
  'expenditures',
  'margin',
  'outlook',
  'approximately',
  'sequentially',
]
const HEAL_RE = new RegExp(
  `\\b(?:${HEAL.flatMap((w) =>
    [...w].slice(1).map((_, k) => `${w.slice(0, k + 1)}\\s{1,3}${w.slice(k + 1)}`),
  ).join('|')})\\b`,
  'gi',
)

/**
 * Join the fragments a PDF's glyph positioning splits a word into ("billio n",
 * "W e", "m inus"): two alphabetic tokens merge when the joined word occurs
 * elsewhere in the document at least twice and is commoner there than either
 * fragment alone. A word the document never spells whole is left split.
 */
export function repairWords(input: string): string {
  const tokens = unspace(input).split(/(\s+)/)
  const counts = new Map<string, number>()
  for (const t of tokens) {
    if (WORD.test(t)) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1)
  }
  const n = (w: string) => counts.get(w.toLowerCase()) ?? 0
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!
    const gap = tokens[i + 1]
    const b = tokens[i + 2]
    if (WORD.test(a) && gap === ' ' && b !== undefined && WORD.test(b)) {
      const joined = a + b
      const whole = n(joined)
      if (whole >= 2 && whole > n(a) && whole > n(b)) {
        tokens[i + 2] = joined
        continue
      }
    }
    out.push(a)
  }
  return out
    .join('')
    .replace(HEAL_RE, (m) => m.replace(/\s+/, ''))
    .replace(/(\w) - (?=\w)/g, '$1-') // "year - over - year", "non - GAAP"
    .replace(/(\d)- (?=[a-z])/g, '$1-') // "42- year"
    .replace(/\$ (?=\d)/g, '$') // "$ 14.5"
    .replace(/' (?=\d{2}\b)/g, "'") // "FY ' 26"
    .replace(/(\d) \. (?=\d)/g, '$1.')
    .replace(/[ \t]+/g, ' ')
}

// A full stop ends a sentence unless it sits inside a number or after one of these.
const ABBREVIATIONS = /(?:\b(?:U\.S|Mr|Ms|Mrs|Dr|Inc|Corp|Co|Ltd|vs|approx|No|St|Jr|Sr)|\b[A-Z])$/

/** One string's sentences, whitespace collapsed. */
export function sentencesOf(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  let start = 0
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i]!
    if (c !== '.' && c !== '?' && c !== '!') continue
    if (c === '.' && /\d/.test(flat[i - 1] ?? '') && /\d/.test(flat[i + 1] ?? '')) continue
    if (flat[i + 1] !== ' ') continue
    const next = flat[i + 2] ?? ''
    if (!/[A-Z“"(]/.test(next)) continue
    if (c === '.' && ABBREVIATIONS.test(flat.slice(Math.max(0, i - 8), i))) continue
    out.push(flat.slice(start, i + 1).trim())
    start = i + 2
  }
  const rest = flat.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter((s) => s.length > 1)
}

/** A PDF's sentences with their pages. Throws on a PDF the reader can't open. */
export async function pdfSentences(bytes: Uint8Array): Promise<DocSentence[]> {
  const pages = await pdfPages(bytes)
  const repaired = repairWords(pages.join('\u0000')).split('\u0000')
  return repaired.flatMap((p, i) =>
    sentencesOf(p).map((text) => ({ text, page: i + 1, at_ms: null, speaker: null })),
  )
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0

/** One file of a zip archive, by name, inflated. Null when the archive has no such file. */
export async function zipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  // The end-of-central-directory record is in the last 64 KiB.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = u16(bytes, eocd + 10)
  let at = u32(bytes, eocd + 16)
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error('bad zip central directory')
    const method = u16(bytes, at + 10)
    const size = u32(bytes, at + 20)
    const nameLen = u16(bytes, at + 28)
    const extra = u16(bytes, at + 30)
    const comment = u16(bytes, at + 32)
    const local = u32(bytes, at + 42)
    const entry = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extra + comment
    if (entry !== name) continue
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
    const data = bytes.subarray(start, start + size)
    if (method === 0) return data
    if (method !== 8) throw new Error(`zip method ${method}`)
    const stream = new Blob([new Uint8Array(data)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return null
}

/** A Word document's sentences, paragraph by paragraph (Microsoft posted its transcripts so until 2022). */
export async function docxSentences(bytes: Uint8Array): Promise<DocSentence[]> {
  const xml = await zipEntry(bytes, 'word/document.xml')
  if (!xml) throw new Error('no word/document.xml')
  const paragraphs = new TextDecoder()
    .decode(xml)
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
        .map((m) => m[1] ?? ' ')
        .join(''),
    )
  return releaseBlocks(paragraphs.map((p) => `<p>${p}</p>`).join('')).flatMap((block) =>
    sentencesOf(block).map((text) => ({ text, page: null, at_ms: null, speaker: null })),
  )
}

/** An HTML page's (or EDGAR exhibit's) sentences. */
export function htmlSentences(html: string): DocSentence[] {
  return releaseBlocks(html).flatMap((block) =>
    sentencesOf(block).map((text) => ({ text, page: null, at_ms: null, speaker: null })),
  )
}

/** A transcribed replay's sentences, with where each starts and who said it. */
export function spokenSentences(spoken: readonly SpokenSentence[]): DocSentence[] {
  return spoken.map((s) => ({
    text: s.text.replace(/\s+/g, ' ').trim(),
    page: null,
    at_ms: s.start,
    speaker: s.speaker,
  }))
}

/** Every sentence's text, joined: what a quote is checked against. */
export const documentText = (sentences: readonly DocSentence[]) =>
  sentences.map((s) => s.text).join(' ')
