import { describe, expect, it } from 'vitest'

import page from '~~/fixtures/recipes/ramp-ai-index.html?raw'
import {
  RAMP_AI_INDEX,
  extractAiIndex,
  readIndexProps,
  vendorKey,
} from '../server/theses/recipes/ramp-ai-index'

// The Ramp AI Index recipe against the page fetched 2026-11-04T04:52Z
// (fixtures/recipes/, trimmed to the one push chunk holding the series).
// The golden values are Ramp's own, as the page printed them that morning.

const obs = extractAiIndex(page, { date: '2026-11-04' })
const at = (key: string, date: string) => obs.find((o) => o.key === key && o.date === date)

describe('Ramp AI Index', () => {
  it('reads the overall and per-vendor monthly rates', () => {
    expect(at('overall', '2026-09-01')!.value).toBe(55.86)
    expect(at('anthropic', '2026-09-01')!.value).toBe(43.77)
    expect(at('openai', '2026-09-01')!.value).toBe(40.63)
    expect(at('xai', '2026-09-01')!.value).toBe(4.14)
    expect(at('mistral-ai', '2026-09-01')!.value).toBe(0.19)
    expect(at('overall', '2023-07-01')!.value).toBe(24.53)
  })

  it('keeps the restated month as this release prints it, not as first published', () => {
    // Published as 14.3% on 2025-11-19; this release restates it.
    expect(at('anthropic', '2025-10-01')!.value).toBe(16.65)
  })

  it('stores each release whole under a key no later release overwrites', () => {
    const current = obs.filter((o) => !o.key.includes('@'))
    const release = obs.filter((o) => o.key.endsWith('@2026-11-04'))
    expect(release).toHaveLength(current.length)
    expect(at('anthropic@2026-11-04', '2025-10-01')!.value).toBe(16.65)
    expect(at('anthropic', '2026-09-01')!.payload).toMatchObject({
      vendor: 'Anthropic',
      mom_change_pp: 0.24,
      data_version: 'YxbS8uBVVLXOqNZieHbPiJ',
    })
  })

  it('reads the same series out of a page split across several push chunks', () => {
    const [, literal] = page.match(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/)!
    const text = JSON.parse(literal!) as string
    const cut = Math.floor(text.length / 2)
    const split = [text.slice(0, cut), text.slice(cut)]
      .map((t) => `<script>self.__next_f.push([1,${JSON.stringify(t)}])</script>`)
      .join('')
    expect(extractAiIndex(split, { date: '2026-11-04' })).toEqual(obs)
  })

  it('fingerprints the series, not the bytes around it', () => {
    const noisy = page.replace('<head>', '<head><meta name="sentry-trace" content="abc"/>')
    expect(RAMP_AI_INDEX.fingerprint!(noisy)).toBe(RAMP_AI_INDEX.fingerprint!(page))
    // The fixture's JSON sits inside a JS string literal, so its quotes are escaped.
    const restated = page.replace('\\"adoption_rate_pct\\":43.77', '\\"adoption_rate_pct\\":43.8')
    expect(restated).not.toBe(page)
    expect(RAMP_AI_INDEX.fingerprint!(restated)).not.toBe(RAMP_AI_INDEX.fingerprint!(page))
  })

  it('fails on a page without the series rather than storing nothing', () => {
    expect(() => readIndexProps('<html><body>redesigned</body></html>')).toThrow(/adoptionOverall/)
    const broken = page.replace(
      '\\"adoptionVendor\\":[',
      '\\"adoptionVendor\\":[{\\"vendor\\":\\"X\\"},',
    )
    expect(broken).not.toBe(page)
    expect(() => readIndexProps(broken)).toThrow(/shape/)
  })

  it('keys a vendor Ramp adds later without a code change', () => {
    expect(vendorKey('Google Gemini')).toBe('google-gemini')
    expect(vendorKey('Mistral AI')).toBe('mistral-ai')
  })
})
