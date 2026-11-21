import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { StoredEntityRow } from '#layers/core/server/utils/contracts'
import { insertRows } from '#layers/core/server/utils/pipeline-store'
import { terminalStamps } from '#layers/core/server/utils/terminal-cache'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { isThirdPartyOnly, queryIncidents } from '../server/utils/terminal-incidents'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The home page's Capacity strain table showed "Degraded Gemini 4 Carbon" as
// xAI's open incident. SpaceXAI's status feed carries Cursor's "Third-party
// Model Providers" component, which posts other labs' outages; the two rows
// below are copied from production's /api/incidents (2026-11-20).

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

const incident = (id: string, title: string, components: string[], resolved_at: string | null) =>
  StoredEntityRow.parse({
    entity_key: `incident:xai:${id}`,
    entity_type: 'incident',
    provider: 'xai',
    snapshot_id: 'snap',
    content_hash: (id.endsWith('1') ? 'b' : 'a').repeat(64),
    payload: JSON.stringify({
      provider: 'xai',
      incident_id: id,
      title,
      impact: 'disruption',
      status: resolved_at ? 'resolved' : 'investigating',
      started_at: '2026-11-19T09:00:00Z',
      resolved_at,
      components,
      incident_url: `https://status.x.ai/third-party-models/${id}`,
    }),
    source_url: 'https://status.x.ai/feed.xml',
    fetched_at: '2026-11-20T09:00:00Z',
    source_id: 'xai-status',
    first_seen_at: '2026-11-20T09:00:00Z',
  })

describe('third-party model incidents on xAI’s feed', () => {
  beforeEach(async () => {
    await db.delete(schema.entities)
  })

  it('names the component that is someone else’s model', () => {
    expect(isThirdPartyOnly(['Third-party Model Providers'])).toBe(true)
    expect(isThirdPartyOnly(['Grok Build and Cursor: CLI', 'Third-party Model Providers'])).toBe(
      false,
    )
    expect(isThirdPartyOnly(['API (us-east-1)'])).toBe(false)
    expect(isThirdPartyOnly([])).toBe(false)
  })

  it('counts for no lab: not in the strain counts, not open, not in the list', async () => {
    await insertRows(db, 'entities', [
      incident(
        'ps_c953d2fd3da8691b',
        'Degraded Gemini 4 Carbon',
        ['Third-party Model Providers'],
        null,
      ),
      incident(
        'ps_0000000000000001',
        'Elevated errors for OpenAI model requests',
        ['Grok Build and Cursor: CLI', 'Third-party Model Providers'],
        null,
      ),
    ])
    const ctx = queryContext(
      sourcesYaml,
      (await terminalStamps(db)).poll,
      () => new Date('2026-11-20T10:00:00Z'),
    )
    const data = await queryIncidents(db, ctx)
    const xai = data.providers.find((p) => p.provider === 'xai')!
    expect(xai.open.map((i) => i.title)).toEqual(['Elevated errors for OpenAI model requests'])
    expect(xai.last_window).toBe(1)
    expect(data.incidents.map((i) => i.title)).not.toContain('Degraded Gemini 4 Carbon')
  })
})
