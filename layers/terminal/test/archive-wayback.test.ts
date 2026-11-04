import { describe, expect, test } from 'vitest'

import {
  captureInstant,
  captureUrl,
  cdxUrl,
  finalTimestamp,
  parseCdx,
  sameOriginal,
  sampleCaptures,
  waybackClient,
  waybackStamp,
} from '../server/pipeline/archive/wayback'
import { ARCHIVE_ERAS, ARCHIVE_UNTIL } from '../server/pipeline/archive/eras'
import { archiveRows, captureId } from '../server/pipeline/archive/rows'
import { usdPerMillion } from '../server/pipeline/parsers/pricing/html-table'
import { archivedPriceHistory, type ArchivedPrice } from '../server/utils/terminal-history'
import { readArchiveSources } from '../server/utils/terminal-sources'
import sourcesYaml from '~~/sources.yaml?raw'

// The Wayback client and the archive's pure plumbing: the CDX query, capture
// sampling, the redirect rule, and the rows one capture becomes. The era
// parsers' golden tests are in pipeline/wayback.golden.test.ts.

describe('wayback plumbing', () => {
  test('timestamps round-trip between Wayback and ISO form', () => {
    expect(captureInstant('20240531225017')).toBe('2024-05-31T22:50:17.000Z')
    expect(waybackStamp('2024-05-31T22:50:17.000Z')).toBe('20240531225017')
    expect(() => captureInstant('2024')).toThrow('not a Wayback timestamp')
  })

  test('the CDX query asks for 200 captures in [from, until), one per digest change', () => {
    const url = new URL(
      cdxUrl('https://openai.com/pricing', '2023-01-01T00:00:00Z', '2024-05-02T00:00:00Z'),
    )
    expect(url.origin + url.pathname).toBe('https://web.archive.org/cdx/search/cdx')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      url: 'https://openai.com/pricing',
      output: 'json',
      filter: 'statuscode:200',
      collapse: 'digest',
      from: '20230101000000',
      to: '20240501235959',
    })
  })

  test('CDX JSON parses by its header, and an empty body is no captures', () => {
    const body = JSON.stringify([
      ['timestamp', 'original', 'digest'],
      ['20230227230602', 'https://openai.com/pricing', 'AJML'],
    ])
    expect(parseCdx(body)).toEqual([
      { timestamp: '20230227230602', original: 'https://openai.com/pricing', digest: 'AJML' },
    ])
    expect(parseCdx('')).toEqual([])
    expect(() => parseCdx('[["timestamp","digest"],["1","x"]]')).toThrow('no original column')
  })

  test('sampling keeps the first capture of each cadence window', () => {
    const c = (timestamp: string) => ({ timestamp, original: 'u', digest: timestamp })
    const all = [
      '20240101000000',
      '20240103000000',
      '20240108000000',
      '20240109000000',
      '20240120000000',
    ].map(c)
    expect(sampleCaptures([...all].reverse(), 7).map((x) => x.timestamp)).toEqual([
      '20240101000000',
      '20240108000000',
      '20240120000000',
    ])
  })

  test('a replay counts only when it is the capture and the page we asked for', () => {
    const asked = captureUrl('20240531225017', 'https://openai.com/api/pricing')
    expect(asked).toBe(
      'https://web.archive.org/web/20240531225017id_/https://openai.com/api/pricing',
    )
    expect(sameOriginal(`${asked}/`, 'https://openai.com/api/pricing')).toBe(true)
    expect(
      sameOriginal(
        'https://web.archive.org/web/20240531225017id_/http://www.openai.com:80/api/pricing',
        'https://openai.com/api/pricing',
      ),
    ).toBe(true)
    expect(
      sameOriginal(
        'https://web.archive.org/web/20240531225017id_/https://openai.com/',
        'https://openai.com/api/pricing',
      ),
    ).toBe(false)
    expect(finalTimestamp(asked)).toBe('20240531225017')
  })

  test('the client paces requests, names the site, backs off on 429 and stays on the Archive', async () => {
    const seen: { url: string; ua: string | null }[] = []
    const slept: number[] = []
    const replies = [
      new Response('slow down', { status: 429 }),
      new Response(null, {
        status: 302,
        headers: { location: 'http://web.archive.org/web/20240101000000id_/https://x.test/p' },
      }),
      new Response('ok', { status: 200 }),
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    ]
    const client = waybackClient({
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          ua: new Headers(init?.headers).get('user-agent'),
        })
        return replies.shift()!
      },
      sleep: async (ms) => void slept.push(ms),
      paceMs: 10_000,
      backoffMs: [1, 2],
    })
    const first = await client.get('https://web.archive.org/web/20240101id_/https://x.test/p')
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      text: 'ok',
      finalUrl: 'https://web.archive.org/web/20240101000000id_/https://x.test/p',
    })
    expect(seen.every((s) => s.ua?.includes('frontierterm.com'))).toBe(true)
    expect(slept).toContain(1) // the 429 back-off
    expect(slept.filter((ms) => ms > 1000).length).toBeGreaterThan(0) // the pace
    const off = await client.get('https://web.archive.org/web/1id_/https://x.test/q')
    expect(off).toEqual({
      ok: false,
      detail: 'redirected off the Archive to https://elsewhere.test/',
    })
  })

  test('a price printed per 1K tokens scales to per million without float drift', () => {
    expect(usdPerMillion('$0.0004 / 1K tokens', 1_000)).toBe(0.4)
    expect(usdPerMillion('$0.0015', 1_000)).toBe(1.5)
    expect(usdPerMillion('$0.03', 1_000)).toBe(30)
    expect(usdPerMillion('$2.50 / 1M tokens', 1_000_000)).toBe(2.5)
    expect(() => usdPerMillion('Free of charge', 1_000)).toThrow('does not print a USD amount')
  })
})

describe('archive eras', () => {
  test('within a lab, eras never overlap and all end by the live start', () => {
    for (const provider of new Set(ARCHIVE_ERAS.map((e) => e.provider))) {
      const eras = ARCHIVE_ERAS.filter((e) => e.provider === provider).sort((a, b) =>
        a.from < b.from ? -1 : 1,
      )
      for (let i = 0; i < eras.length; i++) {
        expect(eras[i]!.from < eras[i]!.until, eras[i]!.id).toBe(true)
        expect(eras[i]!.until <= ARCHIVE_UNTIL, eras[i]!.id).toBe(true)
        if (i > 0) expect(eras[i - 1]!.until <= eras[i]!.from, eras[i]!.id).toBe(true)
      }
    }
    expect(new Set(ARCHIVE_ERAS.map((e) => e.id)).size).toBe(ARCHIVE_ERAS.length)
  })

  test('sources.yaml records the Archive’s terms and keeps it off anything sold', () => {
    const [wayback] = readArchiveSources(sourcesYaml)
    expect(wayback).toMatchObject({
      id: 'wayback-pricing',
      rights: 'not-cleared',
      verdict: 'include',
    })
    expect(wayback!.terms).toContain('scholarship and research purposes only')
  })

  test('a capture the era parser rejects is a skip with the parser’s reason, and no rows', () => {
    const era = ARCHIVE_ERAS.find((e) => e.id === 'openai-pricing-2023')!
    const capture = {
      timestamp: '20230227230602',
      original: 'https://openai.com/pricing',
      digest: 'x',
    }
    const out = archiveRows(
      era,
      capture,
      '<h1>Pricing</h1><p>Just a moment…</p></html>',
      40,
      '2026-11-04T00:00:00.000Z',
    )
    expect(out.prices).toEqual([])
    expect(out.capture).toMatchObject({
      id: captureId(era, capture.timestamp),
      status: 'skipped',
      detail: 'openai.com/pricing: no token price rows',
      captured_at: '2023-02-27T23:06:02.000Z',
      source_url: 'https://web.archive.org/web/20230227230602id_/https://openai.com/pricing',
      fetched_at: '2026-11-04T00:00:00.000Z',
      raw_key: 'archive/wayback/openai-pricing-2023/20230227230602.html',
      rows: 0,
    })
  })

  test('a parsed capture writes one archived row per SKU, keyed like the live prices', () => {
    const era = ARCHIVE_ERAS.find((e) => e.id === 'openai-pricing-2023')!
    const capture = {
      timestamp: '20231214212617',
      original: 'https://openai.com/pricing',
      digest: 'x',
    }
    const html =
      '<h3>GPT-4</h3><table><tr><td>Model</td><td>Input</td><td>Output</td></tr>' +
      '<tr><td>gpt-4</td><td>$0.03 / 1K tokens</td><td>$0.06 / 1K tokens</td></tr></table></html>'
    const out = archiveRows(era, capture, html, html.length, '2026-11-04T00:00:00.000Z')
    expect(out.capture).toMatchObject({ status: 'parsed', rows: 1, detail: null })
    expect(out.prices).toHaveLength(1)
    expect(out.prices[0]).toMatchObject({
      entity_key: 'model:openai:gpt-4',
      provider: 'openai',
      basis: 'archived',
      captured_at: '2023-12-14T21:26:17.000Z',
      original_url: 'https://openai.com/pricing',
      source_url: 'https://web.archive.org/web/20231214212617id_/https://openai.com/pricing',
    })
    expect(JSON.parse(out.prices[0]!.payload)).toMatchObject({
      model_slug: 'gpt-4',
      input_per_mtok: 30,
      output_per_mtok: 60,
    })
  })
})

describe('archived price history', () => {
  const row = (captured_at: string, input: number, capture = captured_at): ArchivedPrice => ({
    capture_id: `openai-pricing-2023:${capture}`,
    entity_key: 'model:openai:gpt-4',
    content_hash: `h${input}`,
    payload: JSON.stringify({ model_slug: 'gpt-4', input_per_mtok: input, output_per_mtok: 60 }),
    captured_at,
    source_url: `https://web.archive.org/web/${capture}id_/https://openai.com/pricing`,
    fetched_at: '2026-11-04T00:00:00.000Z',
  })

  test('one point per new state, oldest first, each citing the capture', () => {
    const points = archivedPriceHistory([
      row('2023-08-01T00:00:00.000Z', 30),
      row('2023-03-01T00:00:00.000Z', 30),
      row('2023-12-01T00:00:00.000Z', 10),
      row('2024-01-01T00:00:00.000Z', 10),
    ])
    expect(points.map((p) => [p.at, p.kind, p.basis, p.input_per_mtok])).toEqual([
      ['2023-03-01T00:00:00.000Z', 'archived', 'archived', 30],
      ['2023-12-01T00:00:00.000Z', 'archived', 'archived', 10],
    ])
    expect(points[0]!.source_id).toBe('wayback:openai-pricing-2023')
    expect(points[1]!.diff).toEqual([{ field: 'input_per_mtok', before: '30', after: '10' }])
  })
})
