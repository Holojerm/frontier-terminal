import { describe, expect, test } from 'vitest'

import {
  GoogleCloudIncidentsOutput,
  StatuspageIncidentsOutput,
  XaiStatusIncidentsOutput,
  contentHash,
  incidentKey,
} from '../../server/pipeline/contracts'
import { diff } from '../../server/pipeline/diff'
import { normalizeIncidents } from '../../server/pipeline/normalize'
import { parseAnthropicStatus } from '../../server/pipeline/parsers/status/anthropic-status'
import {
  isGeminiProduct,
  parseGoogleCloudStatus,
} from '../../server/pipeline/parsers/status/google-cloud-status'
import { parseMistralStatus } from '../../server/pipeline/parsers/status/mistral-status'
import { parseOpenaiStatus } from '../../server/pipeline/parsers/status/openai-status'
import { statuspageIncidentUrl, utcStamp } from '../../server/pipeline/parsers/status/statuspage'
import { parseXaiStatus, rfc822ToIso } from '../../server/pipeline/parsers/status/xai-status'
import {
  parseStatuspageAtom,
  updateStamp,
} from '../../server/pipeline/parsers/status/statuspage-atom'
import { fixtureText, provenanceOf } from './fixtures'

// Status lane golden tests. Expected values are read straight from the
// committed fixtures + fixtures/manifest.json (provenance), never from live
// sources. Counts below are the feeds as fetched on 2026-09-08 (Anthropic's
// Atom feed: 2026-11-04).

const openaiText = fixtureText('fixtures/status/openai-status.json')
const anthropicText = fixtureText('fixtures/status/anthropic-status.xml')
const googleText = fixtureText('fixtures/status/google-cloud-status.json')
const mistralText = fixtureText('fixtures/status/mistral-status.json')
const xaiText = fixtureText('fixtures/status/xai-status.xml')

const DETECTED_AT = '2026-09-08T22:00:00Z'

describe('status lane', () => {
  test('openai: 25 incidents, impacts verbatim, the one open incident has resolved_at null', () => {
    const out = parseOpenaiStatus(openaiText)
    expect(StatuspageIncidentsOutput.safeParse(out).success).toBe(true)
    expect(out.rows).toHaveLength(25)

    const prov = provenanceOf('openai-status')
    for (const row of out.rows) {
      expect(row.provider).toBe('openai')
      expect(row.source_url).toBe(prov.source_url)
      expect(row.fetched_at).toBe(prov.fetched_at)
      // This page carries no components — an empty list, never invented.
      expect(row.components).toEqual([])
      expect(row.incident_url).toBe(`https://status.openai.com/incidents/${row.incident_id}`)
    }
    expect(new Set(out.rows.map((r) => r.impact))).toEqual(new Set(['none', 'minor', 'major']))

    // The feed omits the resolved_at KEY on its open incident; it reads as null.
    const open = out.rows.filter((r) => r.resolved_at === null)
    expect(open.map((r) => [r.incident_id, r.status])).toEqual([
      ['01M20PYYYGRT9303VHAPA7YNT2', 'monitoring'],
    ])
    expect(open[0]?.title).toBe('Elevated errors for image generation')
    expect(open[0]?.started_at).toBe('2026-09-08T14:32:42Z') // no started_at on this page: created_at

    const resolved = out.rows.find((r) => r.incident_id === '01M20QBACYZMK2PRCJQCBSWTYJ')
    expect(resolved).toMatchObject({
      title: 'File uploads are delayed or failing',
      impact: 'minor',
      status: 'resolved',
      started_at: '2026-09-08T14:39:27Z',
      resolved_at: '2026-09-08T19:16:08Z',
    })
    // Sorted by incident id — stable output order for the determinism gate.
    expect(out.rows[0]?.incident_id).toBe('01KZ9DMQD2GJ8JJWDN7572RH78')
  })

  test('anthropic: 25 Atom entries, ids from the incident link, impact null, every field read from the feed', () => {
    const out = parseAnthropicStatus(anthropicText)
    expect(StatuspageIncidentsOutput.safeParse({ rows: out.rows }).success).toBe(true)
    expect(out.rows).toHaveLength(25)
    expect(out.maintenances).toBe(0)

    const prov = provenanceOf('anthropic-status')
    for (const row of out.rows) {
      expect(row.provider).toBe('anthropic')
      expect(row.source_url).toBe('https://status.claude.com/history.atom')
      expect(row.fetched_at).toBe(prov.fetched_at)
      // The Atom feed publishes no impact; it is never inferred from wording.
      expect(row.impact).toBeNull()
      expect(row.status).toBe('resolved')
      expect(row.resolved_at).not.toBeNull()
      // No entry carries a "This incident affected:" line today.
      expect(row.components).toEqual([])
      expect(row.incident_url).toBe(`https://status.claude.com/incidents/${row.incident_id}`)
    }

    // The same incident the JSON API read as 461yvfrzpwtt (started
    // 13:26:04.191Z, resolved 16:23:12.052Z): same id, same minutes.
    expect(out.rows.find((r) => r.incident_id === '461yvfrzpwtt')).toMatchObject({
      title: 'Elevated errors for multiple models',
      impact: null,
      status: 'resolved',
      started_at: '2026-09-03T13:26:00.000Z',
      resolved_at: '2026-09-03T16:23:00.000Z',
      incident_url: 'https://status.claude.com/incidents/461yvfrzpwtt',
    })
    expect(out.rows[0]?.incident_id).toBe('0ns5clsk8p2x')
  })

  test('statuspage atom: status skips "Update", a reopened incident is open, components only from their own line', () => {
    const entry = (code: string, paragraphs: string[]) =>
      `<entry><id>tag:status.example.com,2005:Incident/1</id>` +
      `<published>2027-01-01T02:00:00Z</published><updated>2027-01-01T02:00:00Z</updated>` +
      `<link rel="alternate" type="text/html" href="https://status.example.com/incidents/${code}"/>` +
      `<title>Errors &amp; latency</title><content type="html">` +
      paragraphs
        .map((p) => `&lt;p&gt;${p.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}&lt;/p&gt;`)
        .join(' ') +
      `</content></entry>`
    const update = (mon: string, day: number, time: string, word: string) =>
      `<small>${mon} <var data-var='date'>${day}</var>, <var data-var='time'>${time}</var> UTC</small><br> <strong>${word}</strong> - text`
    const feed = (...entries: string[]) => `<feed>${entries.join('')}</feed>`
    const parse = (text: string) =>
      parseStatuspageAtom('anthropic', text, {
        source_url: 'https://status.example.com/history.atom',
        fetched_at: '2027-01-01T03:00:00Z',
      })

    const out = parse(
      feed(
        // Open across New Year: the December stamps belong to 2026.
        entry('aaaa', [
          update('Jan', 1, '01:00', 'Update'),
          update('Dec', 31, '23:30', 'Identified'),
          update('Dec', 31, '23:00', 'Investigating'),
          'This incident affected: Claude API (api.anthropic.com), claude.ai and Claude Code.',
        ]),
        // Resolved, then reopened: open again, with no resolution time.
        entry('bbbb', [
          update('Jan', 1, '01:30', 'Investigating'),
          update('Jan', 1, '01:00', 'Resolved'),
          update('Jan', 1, '00:10', 'Investigating'),
        ]),
        entry('cccc', [
          update('Jan', 1, '00:30', 'Completed'),
          update('Jan', 1, '00:00', 'Scheduled'),
        ]),
      ),
    )
    expect(out.maintenances).toBe(1)
    expect(out.rows).toEqual([
      expect.objectContaining({
        incident_id: 'aaaa',
        title: 'Errors & latency',
        impact: null,
        status: 'identified',
        started_at: '2026-12-31T23:00:00.000Z',
        resolved_at: null,
        components: ['Claude API (api.anthropic.com)', 'Claude Code', 'claude.ai'],
      }),
      expect.objectContaining({
        incident_id: 'bbbb',
        status: 'investigating',
        started_at: '2027-01-01T00:10:00.000Z',
        resolved_at: null,
        components: [],
      }),
    ])

    expect(() => parse(feed(entry('dddd', [update('Jan', 1, '00:30', 'Degraded')])))).toThrow(
      'unknown status word "degraded"',
    )
    expect(() => parse(feed(entry('eeee', ['Something else entirely'])))).toThrow(
      'unrecognized paragraph',
    )
    expect(() => parse('<html>maintenance page</html>')).toThrow('no <entry> elements')
    expect(updateStamp('Mar 2, 09:05 UTC', Date.parse('2026-11-04T00:00:00Z'))).toBe(
      '2026-03-02T09:05:00.000Z',
    )
  })

  test('mistral: 50 incidents (the page cap), no components, local offsets read as UTC', () => {
    const out = parseMistralStatus(mistralText)
    expect(StatuspageIncidentsOutput.safeParse(out).success).toBe(true)
    expect(out.rows).toHaveLength(50)

    const prov = provenanceOf('mistral-status')
    for (const row of out.rows) {
      expect(row.provider).toBe('mistral')
      expect(row.source_url).toBe('https://status.mistral.ai/api/v2/incidents.json')
      expect(row.fetched_at).toBe(prov.fetched_at)
      expect(row.components).toEqual([])
      // The feed mixes -07:00 and -08:00; every stored stamp is UTC.
      expect(row.started_at).toMatch(/Z$/)
      expect(row.resolved_at).toMatch(/Z$/)
    }
    const impacts = new Map<string | null, number>()
    for (const r of out.rows) impacts.set(r.impact, (impacts.get(r.impact) ?? 0) + 1)
    expect(Object.fromEntries(impacts)).toEqual({ minor: 41, major: 6, critical: 3 })

    expect(
      out.rows.find((r) => r.incident_id === 'e5fd508c-3299-4b85-9d88-8e94fc245522'),
    ).toMatchObject({
      title: 'Mistral Small 4 Availability Degradation',
      impact: 'minor',
      status: 'resolved',
      started_at: '2026-10-23T09:21:52Z',
      resolved_at: '2026-10-23T12:11:30Z',
      incident_url: 'https://status.mistral.ai/incidents/e5fd508c-3299-4b85-9d88-8e94fc245522',
    })
    expect(out.rows[0]?.incident_id).toBe('04b18f96-1aa1-4a69-b578-75ace96ca212')
  })

  test('xai: 316 RSS items fold to 97 incidents, one row per guid with every component listed', () => {
    const out = parseXaiStatus(xaiText)
    expect(XaiStatusIncidentsOutput.safeParse(out).success).toBe(true)
    expect(out.rows).toHaveLength(97)

    const prov = provenanceOf('xai-status')
    for (const row of out.rows) {
      expect(row.provider).toBe('xai')
      expect(row.source_url).toBe('https://status.x.ai/feed.xml')
      expect(row.fetched_at).toBe(prov.fetched_at)
      expect(row.components.length).toBeGreaterThan(0)
      expect(row.status).toBe('resolved')
      expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(row.resolved_at).toMatch(/Z$/)
    }
    const impacts = new Map<string, number>()
    for (const r of out.rows) impacts.set(r.impact, (impacts.get(r.impact) ?? 0) + 1)
    expect(Object.fromEntries(impacts)).toEqual({ disruption: 90, outage: 5, info: 2 })

    // Nine component items, one incident; the link is the first component's by name.
    expect(out.rows.find((r) => r.incident_id === '8nlyd6t95xjm')).toMatchObject({
      title: 'Degraded performance and errors across Cursor services',
      impact: 'disruption',
      started_at: '2026-10-13T00:22:00Z',
      resolved_at: '2026-10-13T03:07:41Z',
      components: [
        'Automations',
        'Bugbot',
        'CLI',
        'Cloud Agents',
        'Cursor IDE (Desktop)',
        'Cursor IDE (iOS)',
        'Grok Bot',
        'Origin',
        'cursor.com',
      ],
      incident_url: 'https://status.x.ai/automations/8nlyd6t95xjm',
    })
    // Titles are stored as the feed prints them, entities decoded once.
    expect(out.rows.find((r) => r.incident_id === 'ps_b88ca87004b1d3b9')?.title).toBe(
      '3 "Slow clones from GH due to Github degradation"',
    )
    expect(out.rows[0]?.incident_id).toBe('0cn36t8pvhfj')
  })

  test('xai: component items that disagree, or a date in another format, fail the parse', () => {
    const first = xaiText.indexOf('<category>disruption</category>')
    expect(() =>
      parseXaiStatus(
        xaiText.slice(0, first) + '<category>outage</category>' + xaiText.slice(first + 31),
      ),
    ).toThrow('differs between its component items')
    expect(rfc822ToIso('Tue, 03 Nov 2026 21:40:43 GMT')).toBe('2026-11-03T21:40:43Z')
    expect(() => rfc822ToIso('2026-11-03T21:40:43Z')).toThrow('unparseable date')
  })

  test('statuspage stamps: a Z stamp passes byte for byte, an offset becomes the same instant in UTC', () => {
    expect(utcStamp('2026-09-03T13:26:04.191Z')).toBe('2026-09-03T13:26:04.191Z')
    expect(utcStamp('2026-09-08T14:39:27Z')).toBe('2026-09-08T14:39:27Z')
    expect(utcStamp('2026-10-23T02:21:52-07:00')).toBe('2026-10-23T09:21:52Z')
    expect(utcStamp('2026-11-03T02:21:52.5-08:00')).toBe('2026-11-03T10:21:52.500Z')
    expect(() => utcStamp('yesterday')).toThrow('unparseable timestamp')
  })

  test('google: keeps only the 1 of 6 incidents naming a Gemini / Vertex AI product, and counts the rest', () => {
    const out = parseGoogleCloudStatus(googleText)
    expect(GoogleCloudIncidentsOutput.safeParse({ rows: out.rows }).success).toBe(true)
    expect(out.rows).toHaveLength(1)
    expect(out.skipped).toBe(5)

    const prov = provenanceOf('google-cloud-status')
    const [row] = out.rows
    expect(row).toMatchObject({
      provider: 'google',
      incident_id: '41E5S3mkTGDfkZuJZH5k',
      title:
        'Vertex AI Gemini API customers experienced increased error rates when accessing the global endpoint.',
      impact: 'low', // Google's vocabulary, verbatim — never mapped onto minor/major
      status: 'AVAILABLE',
      started_at: '2026-02-27T12:37:00+00:00',
      resolved_at: '2026-02-27T14:35:00+00:00',
      incident_url: 'https://status.cloud.google.com/incidents/41E5S3mkTGDfkZuJZH5k',
      ...prov,
    })
    expect(row?.components).toEqual([
      'Agent Assist',
      'Dialogflow CX',
      'Google Cloud Support',
      'Vertex Gemini API',
    ])

    // The filter, stated: any "Gemini" (case-insensitive) or exactly "Vertex AI".
    expect(isGeminiProduct('Vertex Gemini API')).toBe(true)
    expect(isGeminiProduct('Gemini for Google Cloud')).toBe(true)
    expect(isGeminiProduct('Vertex AI')).toBe(true)
    expect(isGeminiProduct('Vertex AI Search')).toBe(false)
    expect(isGeminiProduct('Google Compute Engine')).toBe(false)
  })

  test('statuspage incident urls are composed from the feed page url, trailing slash or not', () => {
    expect(statuspageIncidentUrl('https://status.openai.com/', 'abc')).toBe(
      'https://status.openai.com/incidents/abc',
    )
    expect(statuspageIncidentUrl('https://status.claude.com', 'abc')).toBe(
      'https://status.claude.com/incidents/abc',
    )
  })

  test('stable keys: incidentKey(provider, id) is unique per row and identical across two runs', () => {
    const runs = [
      { parse: () => parseOpenaiStatus(openaiText), provider: 'openai' as const, count: 25 },
      {
        parse: () => parseAnthropicStatus(anthropicText),
        provider: 'anthropic' as const,
        count: 25,
      },
      { parse: () => parseGoogleCloudStatus(googleText), provider: 'google' as const, count: 1 },
    ]
    for (const { parse, provider, count } of runs) {
      const a = parse()
      const b = parse()
      const keys = a.rows.map((r) => incidentKey(provider, r.incident_id))
      expect(keys).toEqual(b.rows.map((r) => incidentKey(provider, r.incident_id)))
      expect(new Set(keys).size).toBe(count)
      expect(contentHash(a)).toBe(contentHash(b))
    }
    expect(incidentKey('anthropic', '461yvfrzpwtt')).toBe('incident:anthropic:461yvfrzpwtt')
  })

  test('an incident that resolves diffs as one modified change; the backlog is not re-added', () => {
    const before = normalizeIncidents(parseOpenaiStatus(openaiText).rows, 'snap:a')

    const feed = JSON.parse(openaiText) as {
      incidents: { id: string; status: string; resolved_at?: string }[]
    }
    const open = feed.incidents.find((i) => i.id === '01M20PYYYGRT9303VHAPA7YNT2')!
    open.status = 'resolved'
    open.resolved_at = '2026-09-08T22:30:00Z'
    const after = normalizeIncidents(
      parseOpenaiStatus(JSON.stringify(feed), provenanceOf('openai-status')).rows,
      'snap:b',
    )

    const changes = diff(before, after, DETECTED_AT).changes
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      entity_key: 'incident:openai:01M20PYYYGRT9303VHAPA7YNT2',
      entity_type: 'incident',
      provider: 'openai',
      change_type: 'modified',
    })
    expect(JSON.parse(changes[0]!.before_json!)).toMatchObject({
      status: 'monitoring',
      resolved_at: null,
    })
    expect(JSON.parse(changes[0]!.after_json!)).toMatchObject({
      status: 'resolved',
      resolved_at: '2026-09-08T22:30:00Z',
    })
    // updated_at is not part of the payload, so a re-stamped feed is no change.
    expect(Object.keys(JSON.parse(changes[0]!.after_json!))).not.toContain('updated_at')
  })
})
