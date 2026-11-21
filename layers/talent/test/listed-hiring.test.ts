import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  parseAshbyBoard,
  parseGreenhouseDepartments,
  parseHibobBoard,
  readGoogleFeed,
} from '../server/listed-hiring/parsers'
import { queryListedHiring } from '../server/listed-hiring/query'
import { EMPTIED_BOARD_FLOOR, readListedBoard, runListedHiring } from '../server/listed-hiring/read'
import { SIGNALS } from '../../terminal/server/signals/registry'
import { createLoader } from '../../terminal/server/signals/sources'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { readListedHiringSources } from '#layers/core/server/utils/terminal-sources'
import {
  LISTED_BOARDS,
  LISTED_CUTS,
  classifyRole,
  weekOf,
  weeklyCounts,
  type ListedBoard,
} from '../shared/utils/listed-hiring'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// Hiring at the listed companies: the classifier, the four board readers
// against their captured bytes, the daily read's point-in-time store, and
// the series the signals harness reads.

const db = drizzle(env.DB, { schema })

const fixture = (name: string) => fixtureText(`fixtures/listed-hiring/${name}`)
const board = (id: string) => LISTED_BOARDS.find((b) => b.id === id)!

const streamOf = (text: string, size = 997): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

describe('classifyRole', () => {
  it.each([
    ['Data Center Technician - Ellendale, ND', 'Data Center - COR', 'datacenter'],
    ['Senior Construction Manager', 'Data Center - G&A', 'datacenter'],
    ['US- North West- EHS Manager', 'Environmental Health and Safety', 'datacenter'],
    ['Superintendent - Electrical, Principal', 'Construction', 'datacenter'],
    ['Transmission & Interconnection, Principal', 'Energy Origination', 'datacenter'],
    ['Site Selection & Colocation Manager – Data Centers', 'Infrastructure', 'datacenter'],
    ['Electrical Design Engineer (MV/HV)', 'DC Design', 'datacenter'],
    ['L1 IT Technician', 'DC Mantsala IT Support Group', 'datacenter'],
    ['Community Development Manager, Google Data Centers', 'DATA CENTER OPERATIONS', 'datacenter'],
    ['Operations Engineer, Fleet Reliability', 'Technology', 'infrastructure'],
    [
      'Senior Software Engineer - GPU Kernel Authoring & Optimization',
      'Technology',
      'infrastructure',
    ],
    ['Senior Site Reliability Engineer (SRE)', 'SRE', 'infrastructure'],
    [
      'Senior Specialist Field Engineer - Networking',
      'Global Field Organization',
      'infrastructure',
    ],
    ['Backend Engineer', 'Infrastructure', 'infrastructure'],
    // Corporate work stays other on a data-center team.
    ['Recruiter, Data Center Operations', 'People', 'other'],
    ['Sr. Accountant, DC Construction - Project Accounting', 'Finance', 'other'],
    ['Senior Counsel, Data Center & Infrastructure', 'Corporate', 'other'],
    ['Account Executive - Data Center', 'Sales', 'other'],
    ['Sr. Principal Business Manager – Data Center & AI Infrastructure', 'Platform', 'other'],
    // A chip designer is not site work, an office help desk is not the fleet.
    ['Principal Electrical Design Engineer', 'Hardware Engineering', 'other'],
    ['Active Electrical Cable Module FW Engineer – Tech Lead', 'Optical Firmware', 'other'],
    ['Help Desk Technician (Tier 1)', 'IT Infrastructure', 'other'],
    ['SFO Office Site Security Manager', 'CEO & CSO Office', 'other'],
    ['Accounting Enablement Manager', null, 'other'],
  ] as const)('%s (%s) is %s', (title, department, expected) => {
    expect(classifyRole(title, department)).toBe(expected)
  })
})

describe('board readers', () => {
  it('reads Greenhouse departments with each job inline, one role per id', () => {
    const roles = parseGreenhouseDepartments(fixture('coreweave-greenhouse.json'))
    expect(roles).toHaveLength(316)
    expect(new Set(roles.map((r) => r.job_id)).size).toBe(316)
    const counts = (c: string) => roles.filter((r) => r.role_class === c).length
    expect([counts('datacenter'), counts('infrastructure'), counts('other')]).toEqual([44, 49, 223])
    const tech = roles.find((r) => r.title === 'Data Center Technician - Afton, TX')!
    expect(tech).toMatchObject({ department: 'Data Center - COR', role_class: 'datacenter' })
  })

  it('keeps a job’s deepest department on a nested board', () => {
    const json = JSON.stringify({
      departments: [
        {
          name: 'Infrastructure',
          child_ids: [2],
          jobs: [{ id: 7, title: 'Data Center Technician' }],
        },
        { name: 'DC Ops', child_ids: [], jobs: [{ id: 7, title: 'Data Center Technician' }] },
        { name: 'No Department', child_ids: [], jobs: [{ id: 8, title: 'Accountant' }] },
      ],
    })
    expect(parseGreenhouseDepartments(json).map((r) => [r.job_id, r.department])).toEqual([
      ['7', 'DC Ops'],
      ['8', null],
    ])
    const nebius = parseGreenhouseDepartments(fixture('nebius-greenhouse.json'))
    expect(nebius).toHaveLength(367)
  })

  it('reads Ashby’s listed postings and HiBob’s job ads', () => {
    const cerebras = parseAshbyBoard(fixture('cerebras-ashby.json'))
    expect(cerebras).toHaveLength(132)
    expect(cerebras.filter((r) => r.role_class === 'datacenter')).toHaveLength(18)
    const credo = parseHibobBoard(fixture('credo-hibob.json'))
    expect(credo).toHaveLength(21)
    expect(credo[0]!.department).toMatch(/^\d+ /)
  })

  it('throws on a payload it does not recognise, and on a board of untitled roles', () => {
    expect(() => parseGreenhouseDepartments('{"jobs":[]}')).toThrow(/departments/)
    expect(() => parseAshbyBoard('{"postings":[]}')).toThrow(/jobs/)
    expect(() => parseHibobBoard('{}')).toThrow(/jobAdDetails/)
    expect(() => parseAshbyBoard(JSON.stringify({ jobs: [{ id: 'a', title: '' }] }))).toThrow(
      /no title/,
    )
  })

  it('streams Google’s feed for its own data-center roles only', async () => {
    const xml = fixture('google-careers.xml')
    const roles = await readGoogleFeed(streamOf(xml))
    expect(roles.length).toBeGreaterThanOrEqual(24)
    expect(roles.every((r) => r.role_class === 'datacenter')).toBe(true)
    // The chunking does not change what is read.
    expect(await readGoogleFeed(streamOf(xml, 13))).toEqual(roles)
    await expect(readGoogleFeed(streamOf('<html></html>'))).rejects.toThrow(/<jobs>/)
  })
})

describe('weekly counts', () => {
  it('keeps each UTC week’s last read and its change on the week before', () => {
    expect(weekOf('2026-11-22T23:00:00Z')).toBe('2026-11-16')
    expect(weekOf('2026-11-23T00:00:00Z')).toBe('2026-11-23')
    const weeks = weeklyCounts([
      { read_at: '2026-11-17T04:00:00Z', total: 300, datacenter: 40, infrastructure: 50 },
      { read_at: '2026-11-21T04:00:00Z', total: 310, datacenter: 44, infrastructure: 50 },
      { read_at: '2026-11-24T04:00:00Z', total: 305, datacenter: 47, infrastructure: 49 },
    ])
    expect(weeks).toEqual([
      expect.objectContaining({
        week: '2026-11-16',
        total: 310,
        total_change: null,
        datacenter_change: null,
      }),
      expect.objectContaining({
        week: '2026-11-23',
        total: 305,
        total_change: -5,
        datacenter_change: 3,
      }),
    ])
  })
})

const HUT = board('listed-hut8-greenhouse')
const greenhouse = (jobs: { id: number; title: string }[], department = 'Construction') =>
  JSON.stringify({ departments: [{ name: department, child_ids: [], jobs }] })

function deps(body: string | (() => Response), at: string, puts: string[] = []) {
  return {
    put: async (key: string) => {
      puts.push(key)
    },
    stream: async () => null,
    fetch: (async () =>
      typeof body === 'string' ? new Response(body) : body()) as unknown as typeof fetch,
    userAgent: 'test',
    now: new Date(at),
  }
}

beforeEach(async () => {
  await db.delete(schema.listedJobs)
  await db.delete(schema.listedHiringReads)
  await db.delete(schema.snapshots)
  await db.delete(schema.opsEvents)
})

describe('the daily read', () => {
  it('opens, closes and reopens roles, with each read’s counts as they stood', async () => {
    const a = { id: 1, title: 'Data Center Technician I' }
    const b = { id: 2, title: 'Recruiter' }
    const c = { id: 3, title: 'Superintendent - Mechanical' }
    const puts: string[] = []
    await readListedBoard(db, HUT, deps(greenhouse([a, b]), '2026-11-21T04:00:00Z', puts))
    await readListedBoard(db, HUT, deps(greenhouse([a, c]), '2026-11-22T04:00:00Z', puts))
    const third = await readListedBoard(
      db,
      HUT,
      deps(greenhouse([a, b, c]), '2026-11-23T04:00:00Z', puts),
    )
    expect(third).toMatchObject({ status: 'read', total: 3, datacenter: 2, added: 1, closed: 0 })

    const reads = await db
      .select()
      .from(schema.listedHiringReads)
      .orderBy(schema.listedHiringReads.read_at)
    expect(reads.map((r) => [r.total, r.datacenter, r.added, r.closed])).toEqual([
      [2, 1, 2, 0],
      [2, 2, 1, 1],
      [3, 2, 1, 0],
    ])
    const jobs = await db.select().from(schema.listedJobs).orderBy(schema.listedJobs.job_id)
    expect(jobs.map((j) => [j.job_id, j.first_seen_at, j.closed_at, j.role_class])).toEqual([
      ['1', '2026-11-21T04:00:00.000Z', null, 'datacenter'],
      ['2', '2026-11-21T04:00:00.000Z', null, 'other'],
      ['3', '2026-11-22T04:00:00.000Z', null, 'datacenter'],
    ])
    // Three distinct bodies, three raw copies, each keyed by its hash.
    expect(new Set(puts).size).toBe(3)
    expect(puts[0]).toMatch(/^listed-hiring\/listed-hut8-greenhouse\/[0-9a-f]{64}\.json$/)
  })

  it('records a failed read and leaves every role as it was', async () => {
    await readListedBoard(
      db,
      HUT,
      deps(greenhouse([{ id: 1, title: 'EHS Manager' }]), '2026-11-21T04:00:00Z'),
    )
    const failed = await runListedHiring(
      db,
      deps(() => new Response('nope', { status: 503 }), '2026-11-22T04:00:00Z'),
      [HUT],
    )
    expect(failed[0]).toMatchObject({ status: 'failed', detail: 'HTTP 503' })
    const jobs = await db.select().from(schema.listedJobs)
    expect(jobs.map((j) => j.closed_at)).toEqual([null])
    const ops = await db.select().from(schema.opsEvents)
    expect(ops.map((o) => o.kind)).toEqual(['listed_hiring_read_failed'])
    expect(ops[0]!.detail).toContain('listed-hut8-greenhouse: HTTP 503')
  })

  it('fails a board that empties at once rather than closing every role', async () => {
    const many = Array.from({ length: EMPTIED_BOARD_FLOOR }, (_, i) => ({
      id: i + 1,
      title: 'Data Center Technician',
    }))
    await readListedBoard(db, HUT, deps(greenhouse(many), '2026-11-21T04:00:00Z'))
    const empty = await readListedBoard(db, HUT, deps(greenhouse([]), '2026-11-22T04:00:00Z'))
    expect(empty.status).toBe('failed')
    const open = await db.select().from(schema.listedJobs)
    expect(open.every((j) => j.closed_at === null)).toBe(true)
  })

  it('reads Google’s board from the careers lane’s archived feed, with no request', async () => {
    await db.insert(schema.snapshots).values({
      id: 'snap-g',
      source_id: 'google-careers',
      content_hash: 'feedhash',
      raw_key: 'raw/google-careers/2026-11-21T06:17:00.000Z.xml',
      http_status: 200,
      bytes: 1,
      source_url: 'https://www.google.com/about/careers/applications/jobs/feed.xml',
      fetched_at: '2026-11-21T06:17:00.000Z',
    })
    const google: ListedBoard = board('listed-google-careers')
    const result = await readListedBoard(db, google, {
      ...deps(() => {
        throw new Error('no request expected')
      }, '2026-11-22T04:00:00Z'),
      stream: async (key) =>
        key.endsWith('.xml') ? streamOf(fixture('google-careers.xml')) : null,
    })
    expect(result).toMatchObject({ status: 'read', total: null })
    expect(result.datacenter).toBeGreaterThanOrEqual(24)
    const [read] = await db.select().from(schema.listedHiringReads)
    expect(read).toMatchObject({
      raw_key: 'raw/google-careers/2026-11-21T06:17:00.000Z.xml',
      fetched_at: '2026-11-21T06:17:00.000Z',
      infrastructure: null,
    })
  })
})

describe('/api/hiring/listed and the signal series', () => {
  it('serves each board’s newest read, weeks and data-center roles, and the cuts', async () => {
    const cw = board('listed-coreweave-greenhouse')
    await readListedBoard(
      db,
      cw,
      deps(fixture('coreweave-greenhouse.json'), '2026-11-21T04:00:00Z'),
    )
    const data = await queryListedHiring(db, new Date('2026-11-21T05:00:00Z'))
    const row = data.boards.find((b) => b.ticker === 'CRWV')!
    expect(row.latest).toMatchObject({
      total: 316,
      datacenter: 44,
      infrastructure: 49,
      source_url: cw.url,
    })
    expect(row.weeks).toHaveLength(1)
    expect(row.datacenter_roles.length).toBeGreaterThan(0)
    expect(row.datacenter_roles.every((r) => r.role_class === 'datacenter')).toBe(true)
    expect(data.boards.find((b) => b.ticker === 'NBIS')!.latest).toBeNull()
    expect(data.cut.map((c) => c.ticker)).toContain('NVDA')
    expect(data.as_of).toBe('2026-11-21T04:00:00.000Z')
  })

  it('loads a board’s reads as daily points for the harness', async () => {
    await readListedBoard(
      db,
      HUT,
      deps(greenhouse([{ id: 1, title: 'Data Center Technician' }]), '2026-11-21T04:00:00Z'),
    )
    await readListedBoard(
      db,
      HUT,
      deps(
        greenhouse(
          [
            { id: 1, title: 'Data Center Technician' },
            { id: 2, title: 'Analyst' },
          ],
          'Operations',
        ),
        '2026-11-28T04:00:00Z',
      ),
    )
    const load = createLoader({
      db,
      ctx: queryContext(fixtureText('sources.yaml'), null, new Date('2026-11-29T00:00:00Z')),
    })
    const total = SIGNALS.find((s) => s.id === 'listed-hiring-hut-open-roles')!
    const dc = SIGNALS.find((s) => s.id === 'listed-hiring-hut-datacenter-roles')!
    expect(await load(total.source)).toEqual({
      kind: 'points',
      points: [
        { date: '2026-11-21', value: 1 },
        { date: '2026-11-28', value: 2 },
      ],
    })
    expect(dc.tickers).toEqual(['HUT', 'ANT'])
    expect(await load(dc.source)).toMatchObject({ points: [{ value: 1 }, { value: 1 }] })
  })
})

describe('the registry of boards', () => {
  it('matches sources.yaml: every board read is an include there, every cut is not', () => {
    const entries = readListedHiringSources(fixtureText('sources.yaml'))
    for (const b of LISTED_BOARDS) {
      const e = entries.find((x) => x.id === b.id)
      expect(e, b.id).toBeDefined()
      expect(e!.verdict, b.id).toMatch(/^include/)
      expect(e!.url, b.id).toBe(b.url)
      expect(e!.ticker, b.id).toBe(b.ticker)
      expect(e!.rights, b.id).toBe('ours')
    }
    const notRead = entries.filter((e) => !e.verdict.startsWith('include'))
    expect(notRead.map((e) => e.ticker).sort()).toEqual(LISTED_CUTS.map((c) => c.ticker).sort())
    for (const e of notRead) expect(e.reason, e.id).toBeTruthy()
  })

  it('registers each board’s total and each host’s data-center roles, on the company', () => {
    const ids = SIGNALS.filter((s) => s.source.kind === 'listed_hiring').map((s) => s.id)
    expect(ids).toContain('listed-hiring-crwv-datacenter-roles')
    expect(ids).toContain('listed-hiring-alab-open-roles')
    expect(ids).not.toContain('listed-hiring-alab-datacenter-roles')
    expect(ids).not.toContain('listed-hiring-googl-open-roles')
    const crwv = SIGNALS.find((s) => s.id === 'listed-hiring-crwv-datacenter-roles')!
    expect(crwv).toMatchObject({
      entity: { kind: 'listed', id: 'CRWV' },
      tickers: ['CRWV', 'NVDA'],
    })
  })
})
