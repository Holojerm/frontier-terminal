import { describe, expect, it } from 'vitest'

import anthropicNotes from '~~/fixtures/release-notes/anthropic-release-notes.md?raw'
import deepseekNews from '~~/fixtures/release-notes/deepseek-news.html?raw'
import geminiNotes from '~~/fixtures/release-notes/gemini-release-notes.md?raw'
import openaiChangelog from '~~/fixtures/release-notes/openai-changelog.md?raw'
import xaiNotes from '~~/fixtures/release-notes/xai-release-notes.md?raw'

import { ARCHIVE_UNTIL } from '../server/pipeline/archive/eras'
import {
  derivePriceEvents,
  type EventCapture,
  type EventPriceRow,
} from '../server/pipeline/archive/price-events'
import releaseNotesJson from '../server/pipeline/archive/release-notes.json'
import { releaseNotesFile } from '../server/pipeline/archive/release-notes-file'
import {
  canonicalModel,
  modelNames,
  parseAnthropicReleaseNotes,
  parseDeepseekNews,
  parseGeminiReleaseNotes,
  parseOpenAiChangelog,
  parseXaiReleaseNotes,
  type ReleaseNote,
} from '../server/pipeline/archive/release-notes'
import { eventDays, eventStudy, maxWindowDays } from '../server/signals/harness'
import { addDays, buildPanel } from '../server/signals/market'

describe('model names in release notes', () => {
  it('spells a model one way however it is written', () => {
    expect(canonicalModel('Claude 3.5 Sonnet')).toBe('claude-3-5-sonnet')
    expect(canonicalModel('claude-sonnet-3-5')).toBe('claude-3-5-sonnet')
    expect(canonicalModel('claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet')
    expect(canonicalModel('gpt-4o-2024-08-06')).toBe('gpt-4o')
    expect(canonicalModel('gpt-3.5-turbo-0125')).toBe('gpt-3-5-turbo')
    expect(canonicalModel('gpt-4-1106-preview')).toBe('gpt-4-turbo-preview')
  })

  it('reads whole names only, so gpt-4o-mini does not name gpt-4o', () => {
    expect(modelNames('Released GPT-4o mini, our most cost-efficient model.')).toEqual([
      'gpt-4o-mini',
    ])
    expect(modelNames('Claude Sonnet 3.5, our most intelligent model yet')).toEqual([
      'claude-3-5-sonnet',
    ])
    expect(modelNames('[GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)')).toEqual([
      'gpt-4o',
    ])
  })
})

describe('the release-notes pages', () => {
  it('dates each lab’s notes by day', () => {
    const openai = parseOpenAiChangelog(openaiChangelog)
    expect(openai.find((n) => n.date === '2024-05-13')?.names).toContain('gpt-4o')
    const anthropic = parseAnthropicReleaseNotes(anthropicNotes)
    expect(anthropic.find((n) => n.date === '2024-06-20')?.names).toContain('claude-3-5-sonnet')
    const gemini = parseGeminiReleaseNotes(geminiNotes)
    expect(gemini.find((n) => n.date === '2024-05-14')?.names).toContain('gemini-1-5-flash')
    const deepseek = parseDeepseekNews(deepseekNews)
    expect(deepseek.find((n) => n.date === '2025-01-20')?.names).toContain('deepseek-reasoner')
  })

  it('keeps only the xAI items that state a full date', () => {
    for (const n of parseXaiReleaseNotes(xaiNotes)) expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('refuses a page it does not recognize', () => {
    expect(() => parseOpenAiChangelog('<html>not it</html>')).toThrow()
    expect(() => parseDeepseekNews('<html>not it</html>')).toThrow()
  })

  it('matches release-notes.json: rebuild it with bun run release-notes', () => {
    const rebuilt = releaseNotesFile(
      {
        openai: openaiChangelog,
        anthropic: anthropicNotes,
        google: geminiNotes,
        xai: xaiNotes,
        deepseek: deepseekNews,
      },
      ARCHIVE_UNTIL.slice(0, 10),
    )
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(releaseNotesJson)
  })
})

const copy = (provider: string, era: string, at: string): EventCapture => ({
  id: `${era}:${at}`,
  era,
  provider,
  captured_at: `${at}T12:00:00.000Z`,
  source_url: `https://web.archive.org/web/${at.replace(/-/g, '')}120000id_/x`,
})

const row = (c: EventCapture, slug: string, input: number, tier = ''): EventPriceRow => ({
  capture_id: c.id,
  entity_key: `model:${c.provider}:${slug}${tier ? `:${tier}` : ''}`,
  payload: JSON.stringify({ input_per_mtok: input }),
})

const note = (date: string, names: string[], price = false): ReleaseNote => ({
  provider: 'openai',
  date,
  url: 'https://developers.openai.com/api/docs/changelog.md',
  title: 't',
  names,
  price,
  limits: false,
})

describe('events from the archived price lists', () => {
  const a = copy('openai', 'e', '2024-05-06')
  const b = copy('openai', 'e', '2024-05-14')
  const c = copy('openai', 'e', '2024-05-21')

  it('dates a launch by its release note and keeps no window', () => {
    const { events } = derivePriceEvents(
      [a, b],
      [row(a, 'gpt-4', 30), row(b, 'gpt-4', 30), row(b, 'gpt-4o', 5)],
      [note('2024-05-13', ['gpt-4o'])],
      { openai: '2023-10-06' },
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'launch',
      model: 'gpt-4o',
      date: '2024-05-13',
      dated_by: 'release_note',
      window_days: 0,
    })
  })

  it('never counts the first copy of a list as launches', () => {
    expect(derivePriceEvents([a], [row(a, 'gpt-4', 30)], [], {}).events).toEqual([])
  })

  it('keeps the window where no notes cover the lab, and dates it at the copy before', () => {
    const { events } = derivePriceEvents(
      [a, b],
      [row(a, 'gpt-4', 30), row(b, 'gpt-4', 30), row(b, 'gpt-4o', 5)],
      [],
      {},
    )
    expect(events[0]).toMatchObject({ date: '2024-05-06', dated_by: 'window', window_days: 8 })
  })

  it('skips a launch no note names once notes cover the lab', () => {
    const { events, skipped } = derivePriceEvents(
      [a, b],
      [row(a, 'gpt-4', 30), row(b, 'gpt-4', 30), row(b, 'babbage-002', 0.4)],
      [],
      { openai: '2023-10-06' },
    )
    expect(events).toEqual([])
    expect(skipped[0]!.reason).toMatch(/no release note/)
  })

  it('skips a model an earlier note named: listed late, not launched', () => {
    const { skipped } = derivePriceEvents(
      [a, b],
      [row(a, 'gpt-4', 30), row(b, 'gpt-4', 30), row(b, 'gpt-4o-audio-preview', 2.5)],
      [note('2024-01-10', ['gpt-4o-audio-preview'])],
      {},
    )
    expect(skipped[0]!.reason).toMatch(/listed late/)
  })

  it('reads a price cut between copies and drops a move that reverses', () => {
    const { events, skipped } = derivePriceEvents(
      [a, b, c],
      [row(a, 'gpt-4o', 5), row(b, 'gpt-4o', 2.5), row(c, 'gpt-4o', 2.5)],
      [note('2024-05-10', ['gpt-4o'], true)],
      { openai: '2023-10-06' },
    )
    expect(events[0]).toMatchObject({
      kind: 'price_cut',
      before: 5,
      after: 2.5,
      date: '2024-05-10',
    })
    const flicker = derivePriceEvents(
      [a, b, c],
      [row(a, 'gpt-4o', 5), row(b, 'gpt-4o', 1.5), row(c, 'gpt-4o', 5)],
      [],
      {},
    )
    expect(flicker.events).toEqual([])
    expect(flicker.skipped.map((s) => s.reason).join()).toMatch(/misread/)
    expect(skipped).toEqual([])
  })

  it('needs a note for an event across an era boundary', () => {
    const d = copy('openai', 'other', '2024-05-21')
    const { events, skipped } = derivePriceEvents(
      [b, d],
      [row(b, 'gpt-4', 30), row(d, 'gpt-4', 30), row(d, 'gpt-4o-mini', 0.15)],
      [],
      {},
    )
    expect(events).toEqual([])
    expect(skipped[0]!.reason).toMatch(/copy after/)
  })
})

describe('loosely dated events in the event study', () => {
  it('keeps a window wider than two days out of the short horizons', () => {
    expect(maxWindowDays(1)).toBe(2)
    expect(maxWindowDays(5)).toBe(2)
    expect(maxWindowDays(20)).toBe(14)
    expect(maxWindowDays(60)).toBe(42)
  })

  it('keeps the narrowest window when events share a day', () => {
    expect(
      eventDays([
        { date: '2024-05-06', value: 1, window_days: 8 },
        { date: '2024-05-06', value: 1 },
      ]),
    ).toEqual([{ date: '2024-05-06', value: 2 }])
  })

  it('scores a seven-day window at 20 sessions and not at 1', () => {
    const rows: { symbol: string; date: string; close: number }[] = []
    let date = '2024-01-01'
    for (let i = 0; i < 400; date = addDays(date, 1)) {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
      if (dow === 0 || dow === 6) continue
      rows.push({ symbol: 'SPY', date, close: 100 }, { symbol: 'TICK', date, close: 100 + (i % 7) })
      i++
    }
    const panel = buildPanel(rows)
    const events = Array.from({ length: 12 }, (_, k) => ({
      date: panel.dates[20 + k * 25]!,
      value: 1,
      window_days: 7,
    }))
    const cells = eventStudy(events, panel, ['TICK'], 'SPY', false)
    const n = (h: number) => {
      const cell = cells.find((x) => x.horizon === h)!
      return cell.in.n + cell.out.n
    }
    expect(n(1)).toBe(0)
    expect(n(20)).toBe(12)
  })
})
