import { describe, expect, it } from 'vitest'

import powerSites from '#layers/compute/server/curated/power-sites.json?raw'
import suppliers from '../server/curated/suppliers.json?raw'
import { DOWNLOAD_SERIES } from '../server/theses/download-series'
import { BENCHMARKS, MARKET_SYMBOLS } from '../server/signals/market'
import { LAB_TICKERS, SIGNALS, sourceLabel } from '../server/signals/registry'
import { LABS } from '../shared/utils/terminal-lab-summary'

const symbols = new Set<string>(MARKET_SYMBOLS)
const tickersIn = (json: string) => [...json.matchAll(/"ticker":\s*"([A-Z.]+)"/g)].map((m) => m[1]!)

describe('signal registry', () => {
  it('gives every series a stable, unique id', () => {
    const ids = SIGNALS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('attaches every series to a lab, listed company or site, and to tickers we pull', () => {
    for (const s of SIGNALS) {
      if (s.entity.kind === 'lab') expect(LABS, s.id).toContain(s.entity.id)
      if (s.entity.kind === 'listed') expect(symbols.has(s.entity.id), s.id).toBe(true)
      expect(s.tickers.length, s.id).toBeGreaterThan(0)
      for (const t of s.tickers) expect(symbols.has(t), `${s.id} ${t}`).toBe(true)
      for (const b of BENCHMARKS) expect(s.tickers, s.id).not.toContain(b)
    }
    for (const list of Object.values(LAB_TICKERS)) {
      for (const t of list ?? []) expect(symbols.has(t), t).toBe(true)
    }
  })

  it('pulls every ticker the curated supplier and power tables name', () => {
    for (const t of [...tickersIn(suppliers), ...tickersIn(powerSites)]) {
      expect(symbols.has(t), t).toBe(true)
    }
  })

  it('pairs each test with its frequency, and dates each history', () => {
    for (const s of SIGNALS) {
      expect(s.test === 'event', s.id).toBe(s.frequency === 'event')
      expect(s.history_from, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.available_after_days, s.id).toBeGreaterThanOrEqual(0)
      expect(sourceLabel(s.source).length, s.id).toBeGreaterThan(0)
      if (s.transform === 'normalized') {
        expect(s.source.kind, s.id).toBe('download_series')
      }
    }
  })

  it('registers the download series and recipes the other sessions own by id', () => {
    const recipes = SIGNALS.flatMap((s) => (s.source.kind === 'recipe' ? [s.source.recipe] : []))
    expect(recipes).toContain('pypi-anthropic')
    expect(recipes).toContain('ramp-ai-index')
    const ids = new Set(DOWNLOAD_SERIES.map((d) => d.id))
    for (const s of SIGNALS) {
      if (s.source.kind === 'download_series') expect(ids.has(s.source.id), s.id).toBe(true)
    }
  })
})
