import { describe, expect, test } from 'vitest'

import {
  GoogleCloudIncidentsOutput,
  StatuspageIncidentsOutput,
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
import { parseOpenaiStatus } from '../../server/pipeline/parsers/status/openai-status'
import { statuspageIncidentUrl } from '../../server/pipeline/parsers/status/statuspage'
import { fixtureText, provenanceOf } from './fixtures'

// Status lane golden tests. Expected values are read straight from the
// committed fixtures + fixtures/manifest.json (provenance), never from live
// sources. Counts below are the feeds as fetched on 2026-09-08.

const openaiText = fixtureText('fixtures/status/openai-status.json')
const anthropicText = fixtureText('fixtures/status/anthropic-status.json')
const googleText = fixtureText('fixtures/status/google-cloud-status.json')

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

  test('anthropic: 50 incidents (the page cap), components sorted, started_at read from the feed', () => {
    const out = parseAnthropicStatus(anthropicText)
    expect(StatuspageIncidentsOutput.safeParse(out).success).toBe(true)
    expect(out.rows).toHaveLength(50)

    const prov = provenanceOf('anthropic-status')
    for (const row of out.rows) {
      expect(row.provider).toBe('anthropic')
      expect(row.source_url).toBe('https://status.claude.com/api/v2/incidents.json')
      expect(row.fetched_at).toBe(prov.fetched_at)
      expect(row.status).toBe('resolved')
      expect(row.resolved_at).not.toBeNull()
      expect(row.components).toEqual([...row.components].sort())
    }
    const impacts = new Map<string, number>()
    for (const r of out.rows) impacts.set(r.impact, (impacts.get(r.impact) ?? 0) + 1)
    expect(Object.fromEntries(impacts)).toEqual({ minor: 30, major: 14, critical: 3, none: 3 })

    const row = out.rows.find((r) => r.incident_id === '461yvfrzpwtt')
    expect(row).toMatchObject({
      title: 'Elevated errors for multiple models',
      impact: 'major',
      started_at: '2026-09-03T13:26:04.191Z',
      resolved_at: '2026-09-03T16:23:12.052Z',
      incident_url: 'https://status.claude.com/incidents/461yvfrzpwtt',
    })
    expect(row?.components).toEqual([
      'Claude API (api.anthropic.com)',
      'Claude Code',
      'Claude Cowork',
      'claude.ai',
    ])
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
        count: 50,
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

    const changes = diff(before, after, DETECTED_AT)
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
