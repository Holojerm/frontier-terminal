import { describe, expect, it } from 'vitest'

import { redactPayload } from '../../server/pipeline/redact'

const GH = 'https://boards-api.greenhouse.io/v1/boards/xai/jobs'

const job = {
  id: 1,
  title: 'Data Center Technician',
  metadata: [{ name: 'Team Lead', value: { name: 'A Person', email: 'a.person@x.ai' } }],
}

describe('redactPayload', () => {
  it('drops every Greenhouse job’s metadata, from jobs and departments payloads', () => {
    const jobs = JSON.parse(redactPayload(GH, JSON.stringify({ jobs: [job], meta: { total: 1 } })))
    expect(jobs).toEqual({ jobs: [{ id: 1, title: 'Data Center Technician' }], meta: { total: 1 } })
    const deps = redactPayload(
      'https://boards-api.greenhouse.io/v1/boards/xai/departments',
      JSON.stringify({ departments: [{ id: 9, name: 'Data Center', jobs: [job] }] }),
    )
    expect(deps).not.toContain('@x.ai')
    expect(JSON.parse(deps).departments[0].jobs[0].title).toBe('Data Center Technician')
  })

  it('leaves other sources, and JSON it cannot parse, byte for byte', () => {
    const text = JSON.stringify({ jobs: [job] })
    expect(redactPayload('https://api.ashbyhq.com/posting-api/job-board/openai', text)).toBe(text)
    expect(redactPayload(GH, '{not json')).toBe('{not json')
  })
})
