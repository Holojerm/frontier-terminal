import { describe, expect, test } from 'vitest'

import { ARCHIVE_FROM } from '#layers/core/server/utils/archive-floor'
import { statusRows } from '../server/pipeline/archive/rows'
import {
  OPENAI_INCIDENTIO_FROM,
  STATUS_ARCHIVE_ERAS,
  STATUS_LIVE_FROM,
  statusEraById,
} from '../server/pipeline/archive/status-eras'
import { updateStamp } from '../server/pipeline/parsers/status/statuspage-atom'
import {
  incidentioRssArchived,
  ulidInstant,
  xaiArchived,
} from '../server/pipeline/parsers/status/wayback-status'
import { incidentArchiveSeries, type StatusCopy } from '../server/utils/terminal-incident-archive'
import { readArchiveSources } from '#layers/core/server/utils/terminal-sources'
import sourcesYaml from '~~/sources.yaml?raw'

// The archived status feeds' pure half: the era windows, the readers' rules
// (zones, incident.io's copied-in ids, xAI's older items) and the monthly
// counts with their coverage. The golden tests over real copies are in
// pipeline/wayback-status.golden.test.ts.

const PROV = {
  source_url: 'https://web.archive.org/web/1id_/x',
  fetched_at: '2026-11-21T00:00:00Z',
}

describe('status eras', () => {
  test('every era is a window from 2023 to its lab’s first live read, none overlapping', () => {
    for (const era of STATUS_ARCHIVE_ERAS) {
      expect(era.from < era.until, era.id).toBe(true)
      expect(era.from >= ARCHIVE_FROM, era.id).toBe(true)
      expect(era.until <= STATUS_LIVE_FROM[era.provider], era.id).toBe(true)
      for (const other of STATUS_ARCHIVE_ERAS) {
        if (other === era || other.provider !== era.provider) continue
        expect(era.until <= other.from || other.until <= era.from, `${era.id}/${other.id}`).toBe(
          true,
        )
      }
    }
  })

  test('no era reads a path a status site’s robots.txt disallows', () => {
    for (const era of STATUS_ARCHIVE_ERAS) expect(new URL(era.url).pathname).not.toMatch(/^\/api\//)
  })

  test('sources.yaml records the archive source as not cleared', () => {
    const status = readArchiveSources(sourcesYaml).find((s) => s.id === 'wayback-status')
    expect(status?.rights).toBe('not-cleared')
  })
})

describe('Statuspage update stamps in a page’s own zone', () => {
  const anchor = Date.parse('2024-05-03T02:00:00Z')
  test('PDT is seven hours behind UTC, CST (China) eight ahead', () => {
    expect(updateStamp('May 2, 18:06 PDT', anchor, { PDT: -420 })).toBe('2024-05-03T01:06:00.000Z')
    expect(updateStamp('May 2, 18:06 CST', anchor, { CST: 480 })).toBe('2024-05-02T10:06:00.000Z')
  })
  test('a zone the page wasn’t said to use throws, and UTC alone stays the default', () => {
    expect(() => updateStamp('May 2, 18:06 PDT', anchor)).toThrow(/unparseable/)
    expect(updateStamp('May 2, 18:06 UTC', anchor)).toBe('2024-05-02T18:06:00.000Z')
  })
})

describe('incident.io’s feed.rss', () => {
  test('a ULID’s instant, to the second', () => {
    // created_at 2025-04-07T14:59:35Z on the JSON API copy of 2025-04-07.
    expect(ulidInstant('01JR8C74Z22BN0HF3CSKG7BNW5')).toBe('2025-04-07T14:59:35Z')
    expect(() => ulidInstant('0bwgp7n2t976')).toThrow(/not a ULID/)
  })

  const item = (id: string, status: string, pubDate: string) =>
    `<item><title><![CDATA[Errors]]></title><link>https://status.openai.com//incidents/${id}</link>` +
    `<pubDate>${pubDate}</pubDate><description><![CDATA[<b>Status: ${status}</b><br/>` +
    `<b>Affected components</b><ul><li>Chat (Degraded performance)</li></ul>]]></description></item>`

  test('start from the id, end from pubDate once resolved, ids from the copy-in left out', () => {
    const read = incidentioRssArchived('openai', OPENAI_INCIDENTIO_FROM)(
      `<rss><channel>${item('01JR8C74Z22BN0HF3CSKG7BNW5', 'Resolved', 'Mon, 07 Apr 2025 18:34:18 GMT')}` +
        item('01JR8C74Z22BN0HF3CSKG7BNW6', 'Investigating', 'Mon, 07 Apr 2025 18:34:18 GMT') +
        // Minted 2025-02-25T10:40:47Z, when incident.io copied the Statuspage history in.
        `${item('01JMYB3TA5WK0AW2NZBTPBZZZ3', 'Resolved', 'Wed, 19 Feb 2025 00:26:00 GMT')}</channel></rss>`,
      PROV,
    )
    expect(read.rows.map((r) => [r.started_at, r.resolved_at, r.status])).toEqual([
      ['2025-04-07T14:59:35Z', '2025-04-07T18:34:18Z', 'resolved'],
      ['2025-04-07T14:59:35Z', null, 'investigating'],
    ])
    expect(read.rows[0]!.components).toEqual(['Chat'])
    expect(read.rows[0]!.incident_url).toBe(
      'https://status.openai.com/incidents/01JR8C74Z22BN0HF3CSKG7BNW5',
    )
    expect(read.note).toMatch(/^1 incidents copied in/)
    expect(read.covers_from).toBe('2025-04-07T14:59:35.000Z')
  })
})

describe('xAI’s older feed items', () => {
  test('one category: the status comes from the description, as the live feed would print it', () => {
    const feed =
      '<rss><channel><item><title>[API (US East)] Grok-3 unavailable</title>' +
      '<link>https://status.x.ai/api-east/INC7509f0f4</link><guid isPermaLink="false">INC7509f0f4</guid>' +
      '<description><![CDATA[<h3>Status: RESOLVED</h3><p>Severity: available</p><p>Resolved: Tue, 27 May 2025 09:01:00 GMT</p>]]></description>' +
      '<pubDate>Mon, 26 May 2025 15:00:00 GMT</pubDate><category>available</category></item></channel></rss>'
    const [row] = xaiArchived(feed, PROV).rows
    expect(row).toMatchObject({
      incident_id: 'INC7509f0f4',
      impact: 'available',
      status: 'resolved',
      started_at: '2025-05-26T15:00:00Z',
      resolved_at: '2025-05-27T09:01:00Z',
      components: ['API (US East)'],
    })
  })
})

describe('archived status rows', () => {
  const era = statusEraById('anthropic-history-atom-2023')!
  const capture = { timestamp: '20240504224537', original: era.url, digest: 'x' }
  test('a feed cut short is a skip, not fewer incidents', () => {
    const out = statusRows(era, capture, '<feed><entry>', 13, PROV.fetched_at)
    expect(out.capture.status).toBe('skipped')
    expect(out.capture.detail).toMatch(/truncated/)
    expect(out.incidents).toEqual([])
  })
})

describe('the monthly archived counts', () => {
  const copy = (provider: string, covers_from: string, captured_at: string): StatusCopy => ({
    provider,
    status: 'parsed',
    covers_from,
    captured_at,
  })
  const at = (started_at: string) => ({ provider: 'openai', started_at, components: [] })

  test('a month counts only as far as some copy reaches, and a hole is stated', () => {
    const { months, labs } = incidentArchiveSeries(
      [at('2024-03-05T00:00:00Z'), at('2024-03-20T00:00:00Z'), at('2024-05-02T00:00:00Z')],
      [
        // March fully, then nothing until mid-April, then to the end of May.
        copy('openai', '2024-02-25T00:00:00Z', '2024-04-01T00:00:00Z'),
        copy('openai', '2024-04-16T00:00:00Z', '2024-06-01T00:00:00Z'),
      ],
    )
    const openai = labs.find((l) => l.provider === 'openai')!
    const i = (m: string) => months.indexOf(m)
    expect(months[0]).toBe('2024-02')
    expect(openai.counts[i('2024-03')]).toBe(2)
    expect(openai.covered[i('2024-03')]).toBe(1)
    expect(openai.covered[i('2024-04')]).toBe(0.5)
    expect(openai.counts[i('2024-05')]).toBe(1)
    expect(openai.counts[i('2024-07')]).toBeNull()
    expect(openai.holes).toContainEqual({ from: '2024-04-01', until: '2024-04-16' })
    expect(openai.holes[0]).toEqual({ from: '2023-01-01', until: '2024-02-25' })
  })

  test('a lab’s months from its live start on are never counted', () => {
    const { months, labs } = incidentArchiveSeries(
      [{ provider: 'xai', started_at: '2026-10-10T00:00:00Z', components: [] }],
      [copy('xai', '2026-09-01T00:00:00Z', '2026-11-20T00:00:00Z')],
    )
    const xai = labs.find((l) => l.provider === 'xai')!
    expect(xai.counts[months.indexOf('2026-10')]).toBe(1)
    expect(months.at(-1)).toBe('2026-10')
    const google = labs.find((l) => l.provider === 'google')!
    expect(google.counts.every((c) => c === null)).toBe(true)
  })
})
