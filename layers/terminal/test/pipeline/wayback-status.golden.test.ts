import { describe, expect, test } from 'vitest'

import { statusRows } from '../../server/pipeline/archive/rows'
import { statusEraById } from '../../../reliability/server/pipeline/archive/status-eras'
import { fixtureText, manifest } from '#layers/core/test/pipeline/fixtures'

// Golden tests for the archived status feeds (archive/status-eras.ts): one
// Internet Archive copy per era, committed whole except Google's (trimmed as
// fixtures/manifest.json says). The newest incident's start and end below
// were checked by hand against the copy's own update stamps: 15:06 PDT is
// 22:06 UTC, 14:28 CST (China) is 06:28 UTC.

const FETCHED = '2026-11-21T02:00:00.000Z'

// era, timestamp, fixture, incidents, covers_from, newest incident
const FIXTURES: readonly [
  string,
  string,
  string,
  number,
  string,
  { id: string; started_at: string; resolved_at: string | null; impact: string | null },
][] = [
  [
    'openai-history-atom-2023',
    '20240503023126',
    'openai-history-2024-05.atom',
    25,
    '2024-03-27T14:45:00.000Z',
    {
      id: '276x19pnppyp',
      started_at: '2024-05-02T22:06:00.000Z',
      resolved_at: '2024-05-03T01:06:00.000Z',
      impact: null,
    },
  ],
  [
    // 54 of its 61 items are the Statuspage history incident.io copied in on 2025-02-25.
    'openai-feed-rss-2025',
    '20250301100550',
    'openai-feed-2025-03.rss',
    7,
    '2025-02-26T10:04:44.000Z',
    {
      id: '01JN7J44A3ZKN67VETGV4321YF',
      started_at: '2025-03-01T00:36:27Z',
      resolved_at: '2025-03-01T05:31:20Z',
      impact: null,
    },
  ],
  [
    'anthropic-history-atom-2023',
    '20240504224537',
    'anthropic-history-2024-05.atom',
    25,
    '2024-03-26T14:30:00.000Z',
    {
      id: '0qyp857kns2b',
      started_at: '2024-04-30T22:22:00.000Z',
      resolved_at: '2024-05-01T00:54:00.000Z',
      impact: null,
    },
  ],
  [
    'anthropic-claude-history-atom-2025',
    '20260401224100',
    'anthropic-claude-history-2026-04.atom',
    25,
    '2026-03-18T12:30:00.000Z',
    {
      id: 'z22j49ktx41d',
      started_at: '2026-04-01T22:15:00.000Z',
      resolved_at: '2026-04-01T22:16:00.000Z',
      impact: null,
    },
  ],
  [
    'deepseek-history-atom-2024',
    '20250425025406',
    'deepseek-history-2025-04.atom',
    25,
    '2024-08-12T08:39:00.000Z',
    {
      id: 'dsndcmrm3qd3',
      started_at: '2025-03-21T06:28:00.000Z',
      resolved_at: '2025-03-21T06:38:00.000Z',
      impact: null,
    },
  ],
  [
    // The trim keeps the copy's oldest incident, so its reach is the raw copy's.
    'google-cloud-incidents-2023',
    '20251130051051',
    'google-cloud-incidents-2025-11.json',
    7,
    '2024-12-04T22:30:00.000Z',
    {
      id: 'ow5i3PPK96RduMcb1SsW',
      started_at: '2025-06-12T17:51:00+00:00',
      resolved_at: '2025-06-13T01:18:00+00:00',
      impact: 'high',
    },
  ],
  [
    // The older item shape: one <category>, the status in the description.
    'xai-feed-2025',
    '20250527165647',
    'xai-feed-2025-05.xml',
    31,
    '2025-01-15T20:30:00.000Z',
    {
      id: 'INC7509f0f4',
      started_at: '2025-05-26T15:00:00Z',
      resolved_at: '2025-05-27T09:01:00Z',
      impact: 'available',
    },
  ],
]

describe('archived status feeds, one copy per era', () => {
  test.each(FIXTURES)('%s %s', (eraId, timestamp, file, n, coversFrom, newest) => {
    const era = statusEraById(eraId)!
    const path = `fixtures/status/wayback/${file}`
    expect(manifest.fixtures.some((f) => f.path === path)).toBe(true)
    const text = fixtureText(path)
    const out = statusRows(
      era,
      { timestamp, original: era.url, digest: timestamp },
      text,
      text.length,
      FETCHED,
    )
    expect(out.capture.status, out.capture.detail ?? '').toBe('parsed')
    expect(out.incidents).toHaveLength(n)
    expect(out.capture.covers_from).toBe(coversFrom)
    expect(new Set(out.incidents.map((i) => i.id)).size).toBe(n)
    const top = [...out.incidents].sort(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
    )[0]!
    expect({
      id: top.incident_id,
      started_at: top.started_at,
      resolved_at: top.resolved_at,
      impact: top.impact,
    }).toEqual(newest)
    expect(top.source_url).toBe(`https://web.archive.org/web/${timestamp}id_/${era.url}`)
    expect(top.basis).toBe('archived')
  })
})
