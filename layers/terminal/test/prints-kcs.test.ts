import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { PRINT_TABLES } from '../server/export-tables/prints'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/pipeline/fetch'
import { KCS, KCS_BOARD_DOC, readKcs } from '../server/prints/ingest'
import {
  hasFigures,
  kcsAttachments,
  kcsBoardUrl,
  kcsPublishedAt,
  kcsRelease,
  kcsReleaseUrl,
  kcsTextsUrl,
  kcsViewerUrl,
  parseKcsBoard,
  parseKcsChipExports,
  parseKcsReleasePage,
  parseKcsViewer,
  type KcsRelease,
} from '../server/prints/kcs'
import { printsStamp } from '../server/prints/store'
import { createLoader } from '../server/signals/sources'
import { SIGNALS } from '../server/signals/registry'
import { readPrintSources } from '#layers/core/server/utils/terminal-sources'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { printRows, queryPrints } from '../server/utils/terminal-prints'
import { PRINT_HELD_SOURCES } from '../shared/utils/prints'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// Korea Customs Service's releases on the committed bytes: the board, four
// release pages (three under KOGL Type 1, one with no mark), the viewer's
// answers and eight extracted texts from 2017 to 2026. Then the reader end
// to end against a fake fetcher, and the rights split: a release with no
// licence mark reaches the signals harness and nothing else.

const db = drizzle(env.DB, { schema })
const f = (name: string) => fixtureText(`fixtures/prints/${name}`)

const BOARD = f('kcs-board.html')
const texts = (sn: string) => f(`kcs-texts-${sn}.txt`)
const figures = (text: string, release: KcsRelease) => {
  const r = parseKcsChipExports(text, release)
  if (r.kind !== 'figures') throw new Error(`no figures: ${r.reason}`)
  return r.observations
}

describe('parseKcsBoard', () => {
  it('reads the count and each row with its hash and posting date', () => {
    const { total, rows } = parseKcsBoard(BOARD)
    expect(total).toBe(471)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual({
      ntt_sn: '10183383',
      ntt_url: '543e432d867f6dd472a69c7a3cfff59c',
      title: '2026년 10월 월간 수출입 현황 [확정치]',
      posted: '2026-11-16',
    })
  })

  it('throws on a page that is not the board', () => {
    expect(() => parseKcsBoard('<html>유효하지 않은 요청입니다.</html>')).toThrow()
  })
})

describe('kcsRelease', () => {
  it('reads the window and month from every title shape on the board', () => {
    const cases: [string, string, KcsRelease | null][] = [
      [
        '2026년 11월 1일 ~ 11월 10일 수출입 현황 [잠정치]',
        '2026-11-11',
        { period: '2026-11', window: 'd10' },
      ],
      ['’16년 8월 1일 ∼ 8월 20일 수출입 현황', '2016-08-22', { period: '2016-08', window: 'd20' }],
      ['9.1-10 수출입 현황', '2018-09-11', { period: '2018-09', window: 'd10' }],
      [
        '2026년 10월 월간 수출입 현황 [확정치]',
        '2026-11-16',
        { period: '2026-10', window: 'month' },
      ],
      [
        '’25년 12월 및 연간 수출입 현황 [잠정치]',
        '2026-01-02',
        { period: '2025-12', window: 'month' },
      ],
      // No year: the year it was posted, or the one before for a later month.
      ['12월 수출입 현황(확정치)', '2018-01-15', { period: '2017-12', window: 'month' }],
      ['2026년 8월 기업규모별 수출입 현황', '2026-09-29', null],
      ['’19년 수출입 현황', '2020-01-01', null],
    ]
    for (const [title, posted, want] of cases)
      expect(kcsRelease(title, posted), title).toEqual(want)
  })
})

describe('the release page and viewer', () => {
  it('reads the KOGL Type 1 block, and its absence', () => {
    const marked = parseKcsReleasePage(f('kcs-release-10182926.html'))
    expect(marked.kogl_type1).toBe(true)
    expect(kcsAttachments(marked)).toEqual([
      {
        name: '261111 2026년 11월 1일 - 11월 10일 수출입 현황.pdf',
        file_key: '315cfcb06b903fc9721e383c914b8874',
      },
    ])
    expect(parseKcsReleasePage(f('kcs-release-10177443.html')).kogl_type1).toBe(false)
  })

  it('reads the viewer’s document id, and refuses an error answer', () => {
    expect(parseKcsViewer(f('kcs-viewer-10182926.json'))).toBe('72059388394710016')
    expect(() => parseKcsViewer('viewCallback({"status":"FAIL"})')).toThrow()
  })
})

describe('parseKcsChipExports', () => {
  it('reads a 10-day annex table in US$ million, with the embargo time in UTC', () => {
    const [o] = figures(texts('10182926'), { period: '2026-11', window: 'd10' })
    expect(o).toMatchObject({
      series: 'kr_chip_exports',
      entity: 'kr-semiconductors',
      period: '2026-11',
      window: 'd10',
      value: 16_632e6,
      currency: 'USD',
      yoy_pct: 331.2,
      observed_as: 'print',
      // 보도시점 2026. 11. 11.(수) 09:00 KST
      published_at: '2026-11-11T00:00:00.000Z',
    })
  })

  it('reads a confirmed month’s table, the same month a year earlier, and checks the 억 달러 headline', () => {
    const obs = figures(texts('10183383'), { period: '2026-10', window: 'month' })
    expect(obs.map((o) => [o.period, o.value, o.yoy_pct, o.observed_as])).toEqual([
      ['2026-10', 56_702e6, 257.5, 'print'],
      ['2025-10', 15_862e6, null, 'year_ago'],
    ])
  })

  it('reads a decrease written △, and a figure in 억 and 천만 달러', () => {
    const [aug19] = figures(texts('45133'), { period: '2019-08', window: 'month' })
    expect(aug19).toMatchObject({ value: 8_196e6, yoy_pct: -30.7, published_at: null })
    const [nov17] = figures(texts('41571'), { period: '2017-11', window: 'month' })
    // "98억 3천만 달러" in the sentence, 9,828 in the table.
    expect(nov17).toMatchObject({ value: 9_828e6, yoy_pct: 68.5 })
  })

  it('finds the month and a year earlier wherever the table puts them, by the stated change', () => {
    // September 2016: the month, then a year earlier (5,734 against 5,895 is −2.7%).
    expect(
      figures(texts('38728'), { period: '2016-09', window: 'month' }).map((o) => [
        o.period,
        o.value,
      ]),
    ).toEqual([
      ['2016-09', 5_734e6],
      ['2015-09', 5_895e6],
    ])
    // January 2017: a year earlier, November, December, then January.
    expect(
      figures(texts('40045'), { period: '2017-01', window: 'month' }).map((o) => [
        o.period,
        o.value,
      ]),
    ).toEqual([
      ['2017-01', 6_497e6],
      ['2016-01', 4_591e6],
    ])
  })

  it('takes a provisional month stated only in 억 달러 at that precision', () => {
    expect(figures(texts('10163364'), { period: '2026-04', window: 'month' })).toMatchObject([
      { value: 320e8, yoy_pct: null },
    ])
  })

  it('reads none from a release with no chip figure, the change only, or another month', () => {
    expect(
      parseKcsChipExports(texts('10181824'), { period: '2026-10', window: 'month' }).kind,
    ).toBe('none')
    expect(parseKcsChipExports(texts('10051925'), { period: '2020-03', window: 'd20' }).kind).toBe(
      'none',
    )
    expect(parseKcsChipExports(texts('10182926'), { period: '2019-11', window: 'd10' })).toEqual({
      kind: 'none',
      reason: 'the attachment is not the 2019-11 release',
    })
  })

  it('throws when the table and the stated figure disagree, or the unit isn’t dollars', () => {
    const text = texts('10183383')
    const release = { period: '2026-10', window: 'month' } as const
    expect(() =>
      parseKcsChipExports(text.replace('증가한 \n567\n억', '증가한 \n667\n억'), release),
    ).toThrow(/table/)
    expect(() =>
      parseKcsChipExports(text.replace('15,862 56,702', '15,862 66,702'), release),
    ).toThrow(/columns/)
    const d10 = texts('10182926')
    expect(() =>
      parseKcsChipExports(d10.replace(/\(단위 : 백만 달러, 전년동기대비 %\)/, '(단위 : 톤)'), {
        period: '2026-11',
        window: 'd10',
      }),
    ).toThrow(/unit/)
  })

  it('tries the PDF first, then the HWP, and tells a text that lost its digits', () => {
    const page = parseKcsReleasePage(
      `<ul class="list_file">` +
        `<a onClick="viewer('/streamdocs/v4/documents/view/tnnf/aa')" title="r.hwp 바로보기">` +
        `<a onClick="viewer('/streamdocs/v4/documents/view/tnnf/bb')" title="r.pdf 바로보기">`,
    )
    expect(kcsAttachments(page).map((a) => a.file_key)).toEqual(['bb', 'aa'])
    expect(hasFigures(texts('10183383'))).toBe(true)
    // A PDF that draws its digits as shapes reads as words alone.
    expect(hasFigures(texts('10183383').replace(/\d/g, ''))).toBe(false)
  })

  it('reads a time only where the release states one', () => {
    expect(kcsPublishedAt('보도자료\n보도시점 배포즉시 배포 2026. 11. 16.(월) 09:00')).toBe(
      '2026-11-16T00:00:00.000Z',
    )
    expect(
      kcsPublishedAt('보도일시 배포 즉시 보도하여 주시기 바랍니다.\n배포일시 2020. 3. 23.(월)'),
    ).toBeNull()
  })
})

// ── the reader, end to end ───────────────────────────────────────────────

const RELEASES = ['10183383', '10182926', '10181824', '10177443'] as const
const HASH: Record<string, string> = Object.fromEntries(
  parseKcsBoard(BOARD).rows.map((r) => [r.ntt_sn, r.ntt_url]),
)
const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const routes = new Map<string, string>([[kcsBoardUrl(1), BOARD]])
// The page after the last: the count and no rows.
routes.set(kcsBoardUrl(2), BOARD.replace(/<table>[\s\S]*<\/table>/, ''))
for (const sn of RELEASES) {
  const page = f(`kcs-release-${sn}.html`)
  const viewer = f(`kcs-viewer-${sn}.json`)
  routes.set(kcsReleaseUrl(sn, HASH[sn]!), page)
  routes.set(kcsViewerUrl(kcsAttachments(parseKcsReleasePage(page))[0]!.file_key), viewer)
  routes.set(kcsTextsUrl(parseKcsViewer(viewer)), texts(sn))
}
const requested: string[] = []
const fetcher: SourceFetcher = async (source) => {
  requested.push(source.url)
  const body = routes.get(source.url)
  return body === undefined ? { ok: false, status: 404, detail: 'HTTP 404' } : ok(body)
}

beforeEach(async () => {
  requested.length = 0
  for (const table of [schema.hardwarePrints, schema.printDocuments, schema.opsEvents]) {
    await db.delete(table)
  }
})

describe('readKcs', () => {
  it('lists the whole board, then reads each release once, splitting the rows by licence mark', async () => {
    const raw = new Map<string, string>()
    const deps = {
      raw: { put: async (key: string, body: string) => void raw.set(key, body) },
      fetcher,
      now: new Date('2026-11-21T08:41:00Z'),
    }
    const first = await readKcs(db, deps)
    expect(first).toMatchObject({ board: 'listed', read: 4, marked: 2, unmarked: 1, pending: 0 })
    expect(await db.select().from(schema.opsEvents)).toEqual([])

    const rows = await db.select().from(schema.hardwarePrints)
    expect(
      rows
        .map((r) => [r.source_id, r.period, r.window, r.value, r.observed_as, r.basis])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      [KCS.unmarked, '2026-09', 'd20', 34_128e6, 'print', 'backfill'],
      [KCS.marked, '2025-10', 'month', 15_862e6, 'year_ago', 'backfill'],
      [KCS.marked, '2026-10', 'month', 56_702e6, 'print', 'backfill'],
      [KCS.marked, '2026-11', 'd10', 16_632e6, 'print', 'backfill'],
    ])
    expect(
      rows.every((r) => r.source_url.startsWith('https://www.customs.go.kr/kcs/na/ntt/')),
    ).toBe(true)
    expect(raw.get('prints/kcs/10182926.txt')).toBe(texts('10182926'))
    expect(raw.get('prints/kcs/10177443.html')).toContain('no licence block')

    const docs = await db.select().from(schema.printDocuments)
    const status = Object.fromEntries(docs.map((d) => [d.doc_id, d.status]))
    expect(status).toMatchObject({
      [KCS_BOARD_DOC]: 'listed',
      'kcs:10183383': 'read',
      'kcs:10181824': 'other',
      // Figures by company size: set aside at listing, never fetched.
      'kcs:10178163': 'other',
    })
    expect(requested.some((u) => u.includes('nttSn=10178163'))).toBe(false)

    // A second run reads the board's first page and nothing else.
    requested.length = 0
    expect(await readKcs(db, deps)).toMatchObject({ pages: 1, read: 0, added: 0 })
    expect(requested).toEqual([kcsBoardUrl(1)])
  })

  it('waits for the whole board before reading a release, so the backfill runs oldest first', async () => {
    // A board with more pages than one run reads: 20 rows a page (the five, four times over).
    const rows = /<table>([\s\S]*)<\/table>/.exec(BOARD)![1]!
    const full = BOARD.replace('<span> 471</span>', '<span> 4710</span>').replace(
      rows,
      rows.repeat(4),
    )
    const deps = {
      raw: { put: async () => {} },
      fetcher: (async (source) =>
        source.url.includes('selectNttList') ? ok(full) : fetcher(source)) as SourceFetcher,
      now: new Date('2026-11-21T08:41:00Z'),
    }
    expect(await readKcs(db, deps)).toMatchObject({ board: 'listing', pages: 4, read: 0 })
    const [state] = await db
      .select()
      .from(schema.printDocuments)
      .where(eq(schema.printDocuments.doc_id, KCS_BOARD_DOC))
    expect(state).toMatchObject({ status: 'listing', detail: '5' })
  })
})

describe('the rights split', () => {
  it('keeps a release with no licence mark out of every route, export and MCP read, and in the harness', async () => {
    const deps = { raw: { put: async () => {} }, fetcher, now: new Date('2026-11-21T08:41:00Z') }
    await readKcs(db, deps)
    const held = (r: { source_id: string }) => PRINT_HELD_SOURCES.includes(r.source_id)
    expect((await db.select().from(schema.hardwarePrints)).some(held)).toBe(true)

    // /api/prints, the /hardware panel and get_hardware_prints all read queryPrints.
    expect((await printRows(db)).some(held)).toBe(false)
    const data = await queryPrints(db, queryContext(fixtureText('sources.yaml'), null))
    const korea = data.series.find((s) => s.entity.id === 'kr-semiconductors')!
    expect(korea.points.map((p) => [p.period, p.window])).toEqual([
      ['2026-11', 'd10'],
      ['2026-10', 'month'],
      ['2025-10', 'month'],
    ])
    expect(JSON.stringify(data)).not.toContain('10177443')
    expect(await printsStamp(db)).toMatch(/^3:/)

    // The hardware_prints export, its count and a point-in-time cut.
    const table = PRINT_TABLES.hardware_prints
    const exported = await table.page(db, null, 1000)
    expect(exported).toHaveLength(3)
    expect(exported.some((r) => held(r as { source_id: string }))).toBe(false)
    expect(await table.count(db)).toBe(3)
    const asOf = await table.at(db, '2027-01-01T00:00:00Z')
    expect((await asOf.page(db, null, 1000)).some((r) => held(r as { source_id: string }))).toBe(
      false,
    )

    // The harness reads the held release: the 20-day series has its September.
    const load = createLoader({ db, ctx: queryContext(fixtureText('sources.yaml'), null) })
    const d20 = SIGNALS.find((s) => s.id === 'kr-chip-exports-d20')!
    expect(await load(d20.source)).toEqual({
      kind: 'points',
      points: [{ date: '2026-09-01', value: 259.4, available: '2026-09-21' }],
    })
  })

  it('names the held source not-cleared in sources.yaml, and the marked one KOGL Type 1', () => {
    const print = readPrintSources(fixtureText('sources.yaml'))
    const byId = Object.fromEntries(print.map((s) => [s.id, s]))
    for (const id of PRINT_HELD_SOURCES) expect(byId[id]?.rights, id).toBe('not-cleared')
    expect(print.filter((s) => s.rights === 'not-cleared').map((s) => s.id)).toEqual([
      ...PRINT_HELD_SOURCES,
    ])
    expect(byId[KCS.marked]).toMatchObject({ rights: 'upstream', verdict: 'include' })
    expect(byId[KCS.marked]!.license).toMatch(/^KOGL Type 1/)
  })
})
