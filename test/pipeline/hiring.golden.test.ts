import { describe, expect, test } from 'vitest'

import {
  AshbyJobsOutput,
  GreenhouseJobsOutput,
  contentHash,
  jobKey,
} from '../../server/pipeline/contracts'
import { parseAnthropicGreenhouse } from '../../server/pipeline/parsers/hiring/anthropic-greenhouse'
import { parseOpenaiAshby } from '../../server/pipeline/parsers/hiring/openai-ashby'
import { parseXaiGreenhouse } from '../../server/pipeline/parsers/hiring/xai-greenhouse'
import { fixtureText } from './fixtures'

// Hiring lane golden tests. Expected values below are read straight from the
// committed fixtures + fixtures/manifest.json (provenance), never from live
// sources.

const ashbyText = fixtureText('fixtures/hiring/openai-ashby.json')
const anthropicText = fixtureText('fixtures/hiring/anthropic-greenhouse.json')
const anthropicDepartments = fixtureText('fixtures/hiring/anthropic-greenhouse-departments.json')
const xaiText = fixtureText('fixtures/hiring/xai-greenhouse.json')
const xaiDepartments = fixtureText('fixtures/hiring/xai-greenhouse-departments.json')

describe('hiring lane', () => {
  test('ashby: parses fixtures/hiring/openai-ashby.json — 65 rows, department+team populated on every row', () => {
    const out = parseOpenaiAshby(ashbyText)
    expect(AshbyJobsOutput.safeParse(out).success).toBe(true)

    expect(out.rows.length).toBe(65)
    for (const row of out.rows) {
      expect(row.provider).toBe('openai')
      // Ashby's structure carries department AND team inline on every job.
      expect(row.department).not.toBeNull()
      expect(row.team).not.toBeNull()
      // Provenance from fixtures/manifest.json entry for openai-ashby.
      expect(row.source_url).toBe('https://api.ashbyhq.com/posting-api/job-board/openai')
      expect(row.fetched_at).toBe('2026-08-25T11:10:42Z')
    }
    // The trim kept 2 jobs per department across all 33 departments.
    expect(new Set(out.rows.map((r) => r.department)).size).toBe(33)

    const row = out.rows.find((r) => r.job_id === '7322d344-9325-4a92-8445-0a2c4e9272f8')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Research Engineer, Retrieval & Search, Applied Engineering')
    expect(row?.department).toBe('Applied AI')
    expect(row?.team).toBe('Applied AI Engineering')
    expect(row?.location).toBe('San Francisco')
    expect(row?.employment_type).toBe('FullTime')
    expect(row?.published_at).toBe('2024-03-20T21:33:20.763+00:00')
    // Not carried by the Ashby payload — null, never invented.
    expect(row?.updated_at).toBeNull()
    expect(row?.company_name).toBeNull()

    // Rows sorted by job_id — stable output order for the determinism gate.
    expect(out.rows[0]?.job_id).toBe('00207abc-49b7-465c-a219-f7c1140f8047')
  })

  test('greenhouse anthropic: parses fixtures/hiring/anthropic-greenhouse.json — 59 rows, department from the /departments join', () => {
    const out = parseAnthropicGreenhouse(anthropicText, anthropicDepartments)
    expect(GreenhouseJobsOutput.safeParse(out).success).toBe(true)

    expect(out.rows.length).toBe(59)
    for (const row of out.rows) {
      expect(row.provider).toBe('anthropic')
      // The jobs endpoint has no department field — every value below can
      // only have come from the /departments join.
      expect(row.department).not.toBeNull()
      expect(row.company_name).toBe('Anthropic')
      expect(row.source_url).toBe('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs')
      expect(row.fetched_at).toBe('2026-08-25T11:10:43Z')
    }
    // 59 jobs map onto 20 distinct departments in the join fixture.
    expect(new Set(out.rows.map((r) => r.department)).size).toBe(20)

    const row = out.rows.find((r) => r.job_id === '4461450008')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Account Executive, AI Native')
    expect(row?.department).toBe('Sales')
    expect(row?.location).toBe('New York City, NY; San Francisco, CA | New York City, NY')
    expect(row?.published_at).toBe('2024-12-20T13:53:38-05:00')
    expect(row?.updated_at).toBe('2026-08-21T21:32:54-04:00')

    expect(out.rows[0]?.job_id).toBe('4017331008')
  })

  test("greenhouse xai: every row carries company_name 'SpaceXAI' (caveat must travel with the data)", () => {
    const out = parseXaiGreenhouse(xaiText, xaiDepartments)
    expect(GreenhouseJobsOutput.safeParse(out).success).toBe(true)

    expect(out.rows.length).toBe(42)
    for (const row of out.rows) {
      expect(row.provider).toBe('xai')
      // The entity-blend caveat: never stripped, never rewritten to "xAI".
      expect(row.company_name).toBe('SpaceXAI')
      // Department can only have come from the /departments join — the jobs
      // endpoint carries no such field.
      expect(row.department).not.toBeNull()
      expect(row.source_url).toBe('https://boards-api.greenhouse.io/v1/boards/xai/jobs')
      expect(row.fetched_at).toBe('2026-08-25T23:08:17Z')
    }
    // 42 jobs map onto 16 departments in the join fixture — and the set is
    // the caveat's evidence: xAI functions only, no aerospace or launch.
    const departments = new Set(out.rows.map((r) => r.department))
    expect(departments.size).toBe(16)
    expect(departments).toContain('Data Center')
    expect(departments).toContain('Human Data')
    for (const d of departments) {
      expect(d).not.toMatch(/starship|falcon|dragon|launch|propulsion|avionics/i)
    }

    const row = out.rows.find((r) => r.job_id === '4611087007')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Controls Engineer')
    expect(row?.department).toBe('Data Center')
    expect(row?.location).toBe('Memphis, TN')
    expect(row?.updated_at).toBe('2026-08-21T18:24:01-04:00')

    expect(out.rows[0]?.job_id).toBe('4533894007')
  })

  test('greenhouse: a job absent from the /departments join fails loudly instead of emitting a null department', () => {
    const board = JSON.parse(xaiText) as { jobs: { id: number }[] }
    const firstId = board.jobs[0]!.id
    const departments = JSON.parse(xaiDepartments) as {
      departments: { jobs: { id: number }[] }[]
    }
    for (const d of departments.departments) d.jobs = d.jobs.filter((j) => j.id !== firstId)
    expect(() => parseXaiGreenhouse(xaiText, JSON.stringify(departments))).toThrow(
      `xai-greenhouse: job ${firstId} missing from departments join`,
    )
  })

  test('stable keys: jobKey(provider, job_id) is unique per row and identical across two runs', () => {
    const runs = [
      { parse: () => parseOpenaiAshby(ashbyText), provider: 'openai' as const, count: 65 },
      {
        parse: () => parseAnthropicGreenhouse(anthropicText, anthropicDepartments),
        provider: 'anthropic' as const,
        count: 59,
      },
      {
        parse: () => parseXaiGreenhouse(xaiText, xaiDepartments),
        provider: 'xai' as const,
        count: 42,
      },
    ]
    for (const { parse, provider, count } of runs) {
      const a = parse()
      const b = parse()
      const keysA = a.rows.map((r) => jobKey(provider, r.job_id))
      const keysB = b.rows.map((r) => jobKey(provider, r.job_id))
      expect(keysA).toEqual(keysB)
      // Keys are unique — safe diff identity for the normalize/diff stage.
      expect(new Set(keysA).size).toBe(count)
      // Full-output determinism, same check the determinism gate runs.
      expect(contentHash(a)).toBe(contentHash(b))
    }
    // Spot-check the key shape on concrete ids.
    expect(jobKey('openai', '00207abc-49b7-465c-a219-f7c1140f8047')).toBe(
      'job:openai:00207abc-49b7-465c-a219-f7c1140f8047',
    )
    expect(jobKey('xai', '4611087007')).toBe('job:xai:4611087007')
  })
})
