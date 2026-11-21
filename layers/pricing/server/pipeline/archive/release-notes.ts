// The labs' own dated release notes, read to date the events the archived price lists show
// (price-events.ts): a pricing-page copy says a model was listed by the day the Archive saw it,
// the changelog says the day it shipped. Each note keeps its date, page, a short title, the
// model names it mentions and whether it talks about price or rate limits.
//
// Read from the pages as they stand now: OpenAI's changelog from October 2023, Anthropic's
// platform release notes from May 2024, the Gemini API release notes from December 2023 and
// DeepSeek's API news from May 2024. xAI's notes give a month, not a day, so only a note that
// states a full date is kept. Mistral's changelog renders in the browser and is not read.
// Terms: sources.yaml › archive_recipes › release-notes.

import type { ArchiveProvider } from './eras'

export interface ReleaseNote {
  provider: ArchiveProvider
  /** YYYY-MM-DD, as the lab dated the note. */
  date: string
  /** The page the note is on. */
  url: string
  /** The note's heading or first words, at most TITLE_CHARS. */
  title: string
  /** Every model name the note mentions, canonical (canonicalModel). */
  names: string[]
  /** Whether the note talks about price: a dated price change needs one. */
  price: boolean
  /** Whether the note talks about rate limits or usage tiers: a dated limit change needs one. */
  limits: boolean
}

export const TITLE_CHARS = 120

export interface ReleaseNoteSource {
  provider: ArchiveProvider
  url: string
  ext: 'md' | 'html'
  parse: (text: string) => ReleaseNote[]
}

// ── model names ─────────────────────────────────────────────────────────────

const FAMILY =
  /^(gpt|chatgpt|o[1-9]|claude|gemini|gemma|grok|deepseek|mistral|mixtral|codestral|pixtral|ministral|magistral|devstral|qwen|qwq|dall|whisper|tts|davinci|babbage|imagen|veo|sora|text|omni|computer|codex)$/

/** A part that can follow a family word inside one model name. */
const PART =
  /^(\d+(?:\.\d+)*[a-z]?|v\d+(?:\.\d+)*|r\d+|\d+[kmb]|\d{8}|mini|nano|turbo|pro|flash|lite|opus|sonnet|haiku|instant|ultra|vision|preview|latest|chat|reasoner|coder|fast|code|exp|experimental|thinking|audio|realtime|search|image|live|instruct|max|plus|large|medium|small|tiny|embedding|embed|beta|high|low|e|transcribe|deep|research|moderation|use|saba|nemo|ocr|astra|terra|luna|sol)$/

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})(?=$|-)/g

/** Names a lab's list and its notes spell differently: OpenAI listed GPT-4 Turbo's preview as gpt-4-1106-preview. */
const ALIASES: Readonly<Record<string, string>> = {
  'gpt-4-preview': 'gpt-4-turbo-preview',
  'gpt-4-vision-preview': 'gpt-4-turbo-preview',
}

/**
 * One spelling for a model however it is written: lowercase, dots and
 * spaces as hyphens, a dated snapshot suffix dropped (-20240620,
 * -2024-08-06, -0125), and Claude's tier and version in one order, since
 * Anthropic writes "Claude 3.5 Sonnet" and later "Claude Sonnet 3.5".
 */
export function canonicalModel(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
  s = s.replace(DATE_SUFFIX, '')
  s = s.replace(/^claude-(opus|sonnet|haiku|instant)-(\d+(?:-\d+)?)/, 'claude-$2-$1')
  s = s.replace(/-$/, '')
  return ALIASES[s] ?? s
}

const stripMarkup = (text: string) =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|​/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')

/** Model slugs a link names: …/models/gpt-4o, …/models/gemini-2.5-pro. */
function linkedModels(text: string): string[] {
  return [...text.matchAll(/\/models\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)].map((m) =>
    canonicalModel(m[1]!),
  )
}

/**
 * Every model name a note mentions: a family word ("Claude", "gpt") and the
 * name parts after it, up to the first word that can't be part of a name.
 * Only whole names count, so a note about gpt-4o-mini doesn't date gpt-4o.
 */
export function modelNames(raw: string): string[] {
  const text = stripMarkup(raw).toLowerCase()
  const words = text
    .split(/[\s,;:()[\]{}"'“”‘’!?=/]+/)
    .map((w) => w.replace(/\.$/, ''))
    .filter(Boolean)
  const parts = words.flatMap((w) => w.split('-').filter(Boolean))
  const names = new Set<string>(linkedModels(raw))
  for (let i = 0; i < parts.length; i++) {
    if (!FAMILY.test(parts[i]!)) continue
    const name = [parts[i]!]
    let j = i + 1
    // A tier word the lexicon doesn't know yet ("Claude Fable 5") counts when a version follows it.
    if (
      j + 1 < parts.length &&
      !PART.test(parts[j]!) &&
      /^[a-z]{3,}$/.test(parts[j]!) &&
      /^\d+(?:\.\d+)*$/.test(parts[j + 1]!)
    ) {
      name.push(parts[j++]!)
    }
    while (j < parts.length && PART.test(parts[j]!) && name.length < 7) name.push(parts[j++]!)
    // "dall e 3", "text embedding 3 small": a bare family word is no name.
    if (name.length === 1 && !/^o[1-9]$/.test(name[0]!)) continue
    names.add(canonicalModel(name.join('-')))
    i = j - 1
  }
  return [...names].sort()
}

const LIMITS =
  /\b(rate limits?|usage tiers?|spend limits?|spend caps?|ITPM|OTPM|tokens per minute)\b/i

const PRICE =
  /\b(price|prices|pricing|priced|cheaper|cost|costs|per million|discount|discounts|reduced|reduction|off-peak|lower rates?)\b/i

function note(
  provider: ArchiveProvider,
  date: string,
  url: string,
  title: string,
  body: string,
): ReleaseNote {
  const flat = stripMarkup(title).replace(/\s+/g, ' ').trim()
  return {
    provider,
    date,
    url,
    title: flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat,
    names: modelNames(`${title}\n${body}`),
    price: PRICE.test(stripMarkup(`${title}\n${body}`)),
    limits: LIMITS.test(stripMarkup(`${title}\n${body}`)),
  }
}

// ── dates ───────────────────────────────────────────────────────────────────

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const pad = (n: number) => String(n).padStart(2, '0')

/** "June 20, 2024", "Jun 20 2024" → 2024-06-20; null for anything else. */
export function dateOf(month: string, day: string, year: string): string | null {
  const m = MONTHS.findIndex((name) => name.startsWith(month.toLowerCase().slice(0, 3)))
  const d = Number(day)
  if (m === -1 || !Number.isInteger(d) || d < 1 || d > 31 || !/^\d{4}$/.test(year)) return null
  const iso = `${year}-${pad(m + 1)}-${pad(d)}`
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null
}

/** Split a page into (heading, body) by a heading pattern, in page order. */
function sections(text: string, heading: RegExp): { match: RegExpExecArray; body: string }[] {
  const out: { match: RegExpExecArray; body: string }[] = []
  const re = new RegExp(
    heading.source,
    heading.flags.includes('g') ? heading.flags : `${heading.flags}g`,
  )
  const hits = [...text.matchAll(re)] as RegExpExecArray[]
  hits.forEach((m, i) => {
    const end = hits[i + 1]?.index ?? text.length
    out.push({ match: m, body: text.slice(m.index! + m[0].length, end) })
  })
  return out
}

const firstLine = (body: string) =>
  body
    .split('\n')
    .map((l) => l.replace(/^\s*[*-]\s*/, '').trim())
    .find((l) => l && !/^(update|feature|fix|deprecation)\b/i.test(l)) ?? ''

function requireNotes(notes: ReleaseNote[], what: string): ReleaseNote[] {
  if (notes.length === 0) throw new Error(`no dated notes on ${what}`)
  return notes
}

// ── the pages ───────────────────────────────────────────────────────────────

export const ANTHROPIC_RELEASE_NOTES_URL =
  'https://platform.claude.com/docs/en/release-notes/overview.md'
export const OPENAI_CHANGELOG_URL = 'https://developers.openai.com/api/docs/changelog.md'
export const GEMINI_RELEASE_NOTES_URL = 'https://ai.google.dev/gemini-api/docs/changelog.md.txt'
export const XAI_RELEASE_NOTES_URL = 'https://docs.x.ai/developers/release-notes.md'
export const DEEPSEEK_NEWS_URL = 'https://api-docs.deepseek.com/updates'

/** Anthropic: one `### June 20, 2024` heading per day, bullets under it. */
export function parseAnthropicReleaseNotes(md: string): ReleaseNote[] {
  if (!/release notes/i.test(md.slice(0, 2000))) throw new Error('not the release notes page')
  const notes: ReleaseNote[] = []
  for (const { match, body } of sections(md, /^###\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s*$/m)) {
    const date = dateOf(match[1]!, match[2]!, match[3]!)
    if (!date) continue
    notes.push(note('anthropic', date, ANTHROPIC_RELEASE_NOTES_URL, firstLine(body), body))
  }
  return requireNotes(notes, 'Anthropic release notes')
}

/** OpenAI: `## May, 2024` months, `### May 13` days, a "Model: slug" tag line. */
export function parseOpenAiChangelog(md: string): ReleaseNote[] {
  if (!/^# Changelog/m.test(md)) throw new Error('not the OpenAI changelog')
  const notes: ReleaseNote[] = []
  for (const month of sections(md, /^##\s+([A-Z][a-z]+),\s+(\d{4})\s*$/m)) {
    for (const { match, body } of sections(month.body, /^###\s+([A-Z][a-z]+)\s+(\d{1,2})\s*$/m)) {
      const date = dateOf(match[1]!, match[2]!, month.match[2]!)
      if (!date) continue
      const tagged = [...body.matchAll(/Model:\s*([a-z0-9][a-z0-9.-]*)/gi)].map((m) => m[1]!)
      const n = note('openai', date, OPENAI_CHANGELOG_URL, firstLine(body), body)
      n.names = [...new Set([...n.names, ...tagged.map(canonicalModel)])].sort()
      notes.push(n)
    }
  }
  return requireNotes(notes, 'the OpenAI changelog')
}

/** Gemini API: `## May 14, 2024  {% id=… %}` per day. */
export function parseGeminiReleaseNotes(md: string): ReleaseNote[] {
  if (!/Release notes/.test(md.slice(0, 3000))) throw new Error('not the Gemini release notes')
  const notes: ReleaseNote[] = []
  for (const { match, body } of sections(md, /^##\s+([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})\b.*$/m)) {
    const date = dateOf(match[1]!, match[2]!, match[3]!)
    if (!date) continue
    notes.push(note('google', date, GEMINI_RELEASE_NOTES_URL, firstLine(body), body))
  }
  return requireNotes(notes, 'the Gemini release notes')
}

/**
 * xAI: `## November 2024` months and a `###` per item, no day. Only an item
 * that states a full date ("on November 19, 2026") is dated, by that date.
 */
export function parseXaiReleaseNotes(md: string): ReleaseNote[] {
  if (!/^# Release Notes/m.test(md)) throw new Error('not the xAI release notes')
  const notes: ReleaseNote[] = []
  for (const { match, body } of sections(md, /^###\s+(.+)$/m)) {
    const stated = /\b([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\b/.exec(body)
    const date = stated ? dateOf(stated[1]!, stated[2]!, stated[3]!) : null
    if (date) notes.push(note('xai', date, XAI_RELEASE_NOTES_URL, match[1]!, body))
  }
  return notes
}

/** DeepSeek: one `<h2 id="date-2025-01-20">` per day, its items under it. */
export function parseDeepseekNews(html: string): ReleaseNote[] {
  if (!/<h2[^>]*id="date-\d{4}-\d{2}-\d{2}"/.test(html))
    throw new Error('not the DeepSeek news page')
  // The table of contents repeats every date as a link; the h2s are the notes.
  const notes: ReleaseNote[] = []
  for (const { match, body } of sections(html, /<h2[^>]*id="date-(\d{4})-(\d{2})-(\d{2})"[^>]*>/)) {
    const date = `${match[1]}-${match[2]}-${match[3]}`
    const end = body.search(/<\/article>|<nav\b|<footer\b/)
    const content = end === -1 ? body : body.slice(0, end)
    const title = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(content)?.[1] ?? ''
    notes.push(note('deepseek', date, `${DEEPSEEK_NEWS_URL}#date-${date}`, title, content))
  }
  return requireNotes(notes, 'the DeepSeek news page')
}

export const RELEASE_NOTE_SOURCES: readonly ReleaseNoteSource[] = [
  { provider: 'openai', url: OPENAI_CHANGELOG_URL, ext: 'md', parse: parseOpenAiChangelog },
  {
    provider: 'anthropic',
    url: ANTHROPIC_RELEASE_NOTES_URL,
    ext: 'md',
    parse: parseAnthropicReleaseNotes,
  },
  { provider: 'google', url: GEMINI_RELEASE_NOTES_URL, ext: 'md', parse: parseGeminiReleaseNotes },
  { provider: 'xai', url: XAI_RELEASE_NOTES_URL, ext: 'md', parse: parseXaiReleaseNotes },
  { provider: 'deepseek', url: DEEPSEEK_NEWS_URL, ext: 'html', parse: parseDeepseekNews },
]
