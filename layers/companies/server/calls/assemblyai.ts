// AssemblyAI, for the calls a company posts only as audio. The Worker hands
// AssemblyAI the replay's URL and AssemblyAI fetches the file itself; the next
// run reads the result back. There is no webhook (it would need a secret of
// its own) and no polling loop: one GET per submitted job per run.
//
// Choices, from AssemblyAI's docs read 2026-11-21:
// - assemblyai-stt-3-7, its flagship pre-recorded model ($0.21 an hour), the
//   one that takes contextual prompts and up to 1,000 key terms.
// - keyterms_prompt ($0.05/h): the company, ticker, the executives who speak,
//   its products, segments and sites, and the labs and model families we track.
// - prompt ($0.05/h): one sentence saying who speaks about what.
// - speaker_labels ($0.02/h) with a speaker range, never an exact count: the
//   number of analysts isn't known ahead.
// - speaker identification by name ($0.02/h, low effort): the executives, the
//   operator, and "Analyst" for every questioner, so a question is never
//   attributed to an executive.
// - custom_spelling for the names it renders as two words.
// - disfluencies off, so a quote reads as spoken without the fillers.
// Word timestamps come with every transcript; we keep each sentence's start.

import { LAB_DISPLAY } from '../../../core/shared/utils/lab-names'

export const ASSEMBLYAI_API = 'https://api.assemblyai.com'
export const SPEECH_MODEL = 'assemblyai-stt-3-7'

/** USD per hour of audio for the model and every add-on we request. */
export const RATE_PER_HOUR = {
  model: 0.21,
  keyterms: 0.05,
  prompt: 0.05,
  diarization: 0.02,
  speaker_identification: 0.02,
} as const
export const USD_PER_HOUR = Object.values(RATE_PER_HOUR).reduce((a, b) => a + b, 0)

/**
 * The owner's cap on AssemblyAI spend per UTC calendar month (2026-11-21, once
 * billing was on). AssemblyAI has no hard limit of its own, only alerts.
 */
export const MONTHLY_SPEND_CAP_USD = 10

/**
 * The owner's one-time ceiling for transcribing the replays of calls held
 * since 2018 (2026-11-21): about 210 hours. It is its own basis, so the
 * backfill never spends the monthly cap that new calls need.
 */
export const BACKFILL_SPEND_CAP_USD = 75
/** A call held before this is the backfill's; one since, the month's. */
export const BACKFILL_BEFORE = '2025-10-01'

export type SpendBasis = 'monthly' | 'backfill'
export const spendBasis = (callDate: string): SpendBasis =>
  callDate < BACKFILL_BEFORE ? 'backfill' : 'monthly'

/** Model families the labs ship, spelled as a speaker says them. */
const MODEL_FAMILIES = [
  'ChatGPT',
  'GPT-5',
  'Codex',
  'Claude',
  'Claude Code',
  'Opus',
  'Sonnet',
  'Gemini',
  'Grok',
  'Llama',
  'DeepSeek',
  'Qwen',
  'Kimi',
  'Mistral',
  'Stargate',
]

/** Names a speech model tends to split in two. `to` must be one word (AssemblyAI's rule). */
const SPELLING: readonly { from: string[]; to: string }[] = [
  { from: ['Open AI'], to: 'OpenAI' },
  { from: ['Core Weave'], to: 'CoreWeave' },
  { from: ['Deep Seek'], to: 'DeepSeek' },
  { from: ['X AI', 'x.AI'], to: 'xAI' },
  { from: ['Nvidia', 'N Video'], to: 'NVIDIA' },
  { from: ['Swepco', 'Swep Co'], to: 'SWEPCO' },
]

export interface CallSpeaker {
  name: string
  title: string
}

export interface AudioCompany {
  ticker: string
  company: string
  speakers?: readonly CallSpeaker[]
  keyterms?: readonly string[]
  prompt?: string
}

const words = (s: string) => s.trim().split(/\s+/).length

/** Key terms for one company's call: at most 6 words a phrase, 1,000 words in all, no repeats. */
export function keytermsFor(c: AudioCompany): string[] {
  const all = [
    c.company,
    c.ticker,
    ...(c.speakers ?? []).map((s) => s.name),
    ...(c.keyterms ?? []),
    ...Object.values(LAB_DISPLAY).filter((n) => n !== 'Other'),
    ...MODEL_FAMILIES,
  ]
  const out: string[] = []
  const seen = new Set<string>()
  let budget = 1000
  for (const t of all) {
    const term = t.trim()
    const key = term.toLowerCase()
    if (!term || seen.has(key) || words(term) > 6 || words(term) > budget) continue
    seen.add(key)
    out.push(term)
    budget -= words(term)
  }
  return out
}

/** The POST /v2/transcript body for one replay. */
export function transcriptRequest(audioUrl: string, c: AudioCompany): Record<string, unknown> {
  const speakers = c.speakers ?? []
  return {
    audio_url: audioUrl,
    speech_models: [SPEECH_MODEL],
    language_code: 'en',
    prompt:
      c.prompt ??
      `${c.company} quarterly earnings conference call: executives discuss results and guidance, then answer analyst questions.`,
    keyterms_prompt: keytermsFor(c),
    custom_spelling: SPELLING,
    disfluencies: false,
    speaker_labels: true,
    speaker_options: {
      // The list holds a company's past executives too; three of them speak on a call at most.
      min_speakers_expected: Math.min(speakers.length, 3) + 2,
      max_speakers_expected: speakers.length + 14,
    },
    speech_understanding: {
      request: {
        speaker_identification: {
          speaker_type: 'name',
          speakers: [
            ...speakers.map((s) => ({ name: s.name, description: `${s.title} of ${c.company}` })),
            {
              name: 'Operator',
              description: 'The conference call operator who introduces each question',
            },
            {
              name: 'Analyst',
              description:
                'A sell-side analyst asking a question; several different analysts speak',
            },
          ],
        },
      },
    },
  }
}

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/**
 * The bitrate of an MP3 from its first frame header, in kbps, or null. The
 * head of the file is enough: an ID3v2 tag is skipped by its stated size.
 */
export function mp3Kbps(head: Uint8Array): number | null {
  let at = 0
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && head.length > 10) {
    const size =
      ((head[6]! & 0x7f) << 21) |
      ((head[7]! & 0x7f) << 14) |
      ((head[8]! & 0x7f) << 7) |
      (head[9]! & 0x7f)
    at = 10 + size
  }
  for (let i = at; i + 3 < head.length; i++) {
    if (head[i] !== 0xff || (head[i + 1]! & 0xe0) !== 0xe0) continue
    const version = (head[i + 1]! >> 3) & 0x03 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (head[i + 1]! >> 1) & 0x03 // 1 = Layer III
    const index = (head[i + 2]! >> 4) & 0x0f
    if (layer !== 1 || version === 1 || index === 0 || index === 15) continue
    return (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[index] ?? null
  }
  return null
}

/** Seconds of audio a file of `bytes` holds at `kbps`. */
export const audioSeconds = (bytes: number, kbps: number) => (bytes * 8) / (kbps * 1000)

/** A WAV file's bytes per second from its RIFF header, or null (Amazon posted its replays so until 2024). */
export function wavByteRate(head: Uint8Array): number | null {
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4))
  const u32 = (at: number) =>
    (head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16) | (head[at + 3]! << 24)) >>> 0
  if (head.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  // Chunks in order; a JUNK or bext chunk may come before "fmt ".
  for (let at = 12; at + 20 <= head.length;) {
    const size = u32(at + 4)
    if (tag(at) === 'fmt ') {
      const rate = u32(at + 16)
      return rate > 0 ? rate : null
    }
    at += 8 + size + (size & 1)
  }
  return null
}

/** A replay's length from its size and its head: a WAV's byte rate, an MP3's bitrate, else the bound below. */
export function replaySeconds(head: Uint8Array, bytes: number): number {
  const wav = wavByteRate(head)
  if (wav) return bytes / wav
  return audioSeconds(bytes, mp3Kbps(head) ?? FALLBACK_KBPS)
}

/** What a transcript of `seconds` costs at the rates above. */
export const costOf = (seconds: number) => (seconds / 3600) * USD_PER_HOUR

/** A file of unknown bitrate is costed as 32 kbps, the lowest speech MP3s use: an upper bound. */
export const FALLBACK_KBPS = 32

/** How AssemblyAI refused a request, as the run needs to act on it. */
export type AssemblyRefusal = 'credits' | 'auth' | 'other'

/** Credits exhausted, a billing hold or a paused account: stop submitting until the owner acts. */
export function refusalOf(status: number, body: string): AssemblyRefusal {
  if (status === 401 || status === 403) {
    return /credit|balance|billing|payment|paused|upgrade/i.test(body) ? 'credits' : 'auth'
  }
  if (status === 402 || /insufficient|credit|balance|billing|payment/i.test(body)) return 'credits'
  return 'other'
}

/** One sentence of a finished transcript, as we keep it: never the words, never the audio. */
export interface SpokenSentence {
  text: string
  /** Milliseconds from the start of the replay. */
  start: number
  speaker: string | null
}

/**
 * Speaker identification's answer: diarization label to name, with the
 * " - 2" AssemblyAI appends when one name took two labels removed.
 */
export function speakerMapping(job: unknown): Record<string, string> {
  const mapping = (
    job as {
      speech_understanding?: {
        response?: { speaker_identification?: { mapping?: Record<string, unknown> } }
      }
    }
  )?.speech_understanding?.response?.speaker_identification?.mapping
  const out: Record<string, string> = {}
  for (const [label, name] of Object.entries(mapping ?? {})) {
    if (typeof name === 'string') out[label] = name.replace(/\s+-\s+\d+$/, '')
  }
  return out
}

/** GET /v2/transcript/{id}/sentences, reduced to what the parser reads, speakers named where identified. */
export function parseSentences(body: string, names: Record<string, string> = {}): SpokenSentence[] {
  const doc = JSON.parse(body) as {
    sentences?: { text?: unknown; start?: unknown; speaker?: unknown }[]
  }
  if (!Array.isArray(doc.sentences)) throw new Error('not an AssemblyAI sentences response')
  return doc.sentences
    .filter((s) => typeof s.text === 'string' && typeof s.start === 'number')
    .map((s) => ({
      text: s.text as string,
      start: s.start as number,
      speaker: typeof s.speaker === 'string' ? (names[s.speaker] ?? s.speaker) : null,
    }))
}
