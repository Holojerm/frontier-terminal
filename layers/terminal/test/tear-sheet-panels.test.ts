import { describe, expect, it } from 'vitest'

import { buildTearSheet, type TearSheetInputs } from '../app/utils/tear-sheet'
import { callsInput } from '../app/utils/tear-sheet-listed'
import { releasesInput, SHEET_RELEASES } from '../app/utils/tear-sheet-panels'

const AT = '2026-11-23T18:00:00.000Z'
const PRICES = 'https://docs.claude.com/pricing'
const RANKINGS = 'https://openrouter.ai/rankings'

const release = (i: number, provider: LabId = 'anthropic') =>
  ({
    change_id: `c${i}`,
    entity_key: `anthropic:model-${i}`,
    source_id: 'anthropic-pricing',
    provider,
    model_slug: `model-${i}`,
    tier: i === 0 ? 'Standard' : null,
    context_window: null,
    first_seen_at: `2026-11-${String(20 - i).padStart(2, '0')}T09:00:00.000Z`,
    input_per_mtok: 3,
    cached_input_per_mtok: null,
    output_per_mtok: 15,
    notes: null,
    also_listed_by: [],
    source_url: PRICES,
    fetched_at: AT,
  }) as ReleaseView

const releases = {
  as_of: AT,
  computed_at: AT,
  rows: [...Array.from({ length: 7 }, (_, i) => release(i)), release(9, 'openai')],
  excluded_baseline: 0,
  log_from: '2026-05-01T00:00:00.000Z',
} as ReleasesData

const spendProvider = {
  provider: 'anthropic',
  display: 'Anthropic',
  tokens: 1e12,
  priced_tokens: 9e11,
  coverage: 0.9,
  spend_low: 2.5e6,
  spend_high: 1.2e7,
  share_low: 0.31,
  share_high: 0.42,
  token_share: 0.2,
  priced_token_share: 0.22,
  models: [
    {
      model_permaslug: 'anthropic/model-0',
      price_source_url: PRICES,
      price_fetched_at: AT,
    },
  ],
} as SpendProviderView

const probeDay = (day: string, complete: boolean) =>
  ({
    day,
    complete,
    placement: 'enam',
    model: 'anthropic/model-0',
    probes: 24,
    ok: 21,
    rate_limited: 2,
    failed: 1,
    strained_share: 0.125,
    peak_tps: 40,
    offpeak_tps: 50,
    peak_to_offpeak: 0.8,
    peak_ttft_ms: null,
    offpeak_ttft_ms: null,
    source_url: 'https://openrouter.ai/api/v1/chat/completions',
    fetched_at: `${day}T23:00:00.000Z`,
  }) as ProbeDayView

const probeLab = (over: Partial<ProbeLabView>) =>
  ({
    lab: 'anthropic',
    display: 'Anthropic',
    status: 'probed',
    model: 'anthropic/model-0',
    model_note: null,
    hours: '13:00–21:00 UTC against 04:00–10:00',
    gap: null,
    latest: null,
    window: null,
    days: [probeDay('2026-11-23', true)],
    other_series: [],
    ...over,
  }) as ProbeLabView

const board = (over: Partial<ListedHiringBoard>) =>
  ({
    id: 'listed-coreweave-greenhouse',
    ticker: 'CRWV',
    company: 'CoreWeave',
    platform: 'greenhouse',
    scope: 'all',
    host: true,
    caveat: null,
    latest: {
      total: 316,
      datacenter: 44,
      infrastructure: 80,
      read_at: '2026-11-23T06:00:00.000Z',
      source_url: 'https://boards-api.greenhouse.io/v1/boards/coreweave/departments',
      fetched_at: '2026-11-23T06:00:00.000Z',
    },
    weeks: [
      {
        week: '2026-11-23',
        read_at: '2026-11-23T06:00:00.000Z',
        total: 316,
        datacenter: 44,
        infrastructure: 80,
        total_change: 12,
        datacenter_change: -3,
      },
    ],
    datacenter_roles: [],
    failing: null,
    ...over,
  }) as ListedHiringBoard

const statement = (over: Partial<CallStatement>) =>
  ({
    id: 's1',
    ticker: 'MSFT',
    company: 'Microsoft',
    call_date: '2026-10-29',
    call_period: 'Q1 FY2027',
    metric: 'capex',
    segment: null,
    basis: null,
    unit: 'USD',
    bound: 'range',
    period: 'Q1 FY2027',
    period_end: '2026-09-30',
    low: 30e9,
    high: 32e9,
    quote: 'We expect capital expenditures to rise.',
    speaker: null,
    sources: [
      {
        source: 'transcript',
        url: 'https://example.com/msft-call',
        page_url: null,
        produced_by: null,
        page: null,
        at_ms: null,
      },
    ],
    first_seen_at: '2026-10-29T22:00:00.000Z',
    state: 'met',
    reason: null,
    actual: {
      value: 31.4e9,
      concept: 'PaymentsToAcquirePropertyPlantAndEquipment',
      form: '10-Q',
      filed: '2026-10-29',
      accession_no: '0000950170-26-000001',
      filing_url: 'https://www.sec.gov/Archives/edgar/data/789019/000095017026000001/',
      first_seen_at: '2026-10-30T01:00:00.000Z',
    },
    error_share: 0,
    ...over,
  }) as CallStatement

const coverage = (over: Partial<CallCoverage>) =>
  ({
    ticker: 'MSFT',
    company: 'Microsoft',
    posts: 'transcript',
    ir_url: 'https://example.com/ir',
    documents: { exhibit: 1, transcript: 1, remarks: 0, audio: 0 },
    statements: 3,
    scored: 2,
    gap: null,
    ...over,
  }) as CallCoverage

const calls = callsInput({
  as_of: AT,
  computed_at: AT,
  rule: 'Call rule.',
  ticker: null,
  lab: 'anthropic',
  statements: [
    statement({ id: 'open', state: 'open', actual: null, error_share: null }),
    statement({}),
    statement({ id: 'older', call_date: '2026-07-30', state: 'above', error_share: 0.04 }),
  ],
  omitted: 0,
  tally: {
    statements: 3,
    scored: 2,
    met: 1,
    above: 1,
    below: 0,
    open: 1,
    unscored: 0,
    median_abs_error: 0.02,
  },
  companies: [
    coverage({}),
    coverage({
      ticker: 'AEP',
      company: 'AEP',
      statements: 0,
      scored: 0,
      gap: 'Posts a webcast only.',
    }),
  ],
})

const inputs: TearSheetInputs = {
  releases: releasesInput(releases, 'anthropic'),
  spend: {
    status: 'ok',
    window: { from: '2026-11-16', to: '2026-11-22' },
    providers: [spendProvider],
    excluded: [{ provider: 'deepseek', display: 'DeepSeek', reason: 'No priced SKU matched.' }],
    rankings: { provenance: { source_url: RANKINGS, fetched_at: AT } },
    caveat: 'Spend caveat.',
  },
  probes: {
    labs: [probeLab({})],
    placement: { hint: 'enam', label: 'eastern North America', since: '2026-11-01' },
    caveat: 'Probe caveat.',
  },
  disclosures: {
    providers: [
      {
        provider: 'anthropic',
        display: 'Anthropic',
        feed: 'ok',
        reason: null,
        caveat: 'Disclosure caveat.',
        reports: 7,
        notices: 2,
        median_days_to_disclosure: 41.5,
        timed_reports: 6,
        sources: [
          {
            source_id: 'anthropic-disclosures',
            label: 'Anthropic disclosure index',
            source_url: 'https://alignment.anthropic.com/',
            fetched_at: AT,
          },
        ],
      },
    ],
  },
  listedHiring: {
    boards: [
      board({}),
      board({
        id: 'listed-google',
        ticker: 'GOOGL',
        company: 'Google',
        scope: 'datacenter',
        latest: { ...board({}).latest!, total: null, read_at: '2026-11-20T06:00:00.000Z' },
        weeks: [],
        failing: { read_at: '2026-11-22T06:00:00.000Z', detail: '503' },
      }),
      board({ id: 'listed-new', ticker: 'NBIS', company: 'Nebius', latest: null, weeks: [] }),
    ],
    cut: [{ ticker: 'DELL', company: 'Dell', reason: 'Not read: needs a reader of its own.' }],
    rule: 'Hiring rule.',
  },
  calls,
}

describe('tear sheet panels', () => {
  const sheet = buildTearSheet('anthropic', inputs)
  const refOf = (url: string) => sheet.sources.find((s) => s.url === url)!.n

  it('lists the lab’s newest SKUs, capped, citing the price page once', () => {
    expect(sheet.releases.rows).toHaveLength(SHEET_RELEASES)
    expect(sheet.releases.rows[0]).toEqual({
      key: 'c0',
      date: '2026-11-20',
      model: 'model-0',
      tier: 'Standard',
      input: '$3.00',
      output: '$15.00',
      ref: refOf(PRICES),
    })
    expect(sheet.releases.more).toBe(2)
    expect(sheet.releases.gap).toBeNull()
  })

  it('prints implied spend as a range, footnoted to the rankings and the price page', () => {
    expect(sheet.spend).toEqual({
      label: 'Implied share of priced labs’ spend',
      value: '31.0%–42.0%',
      delta: null,
      lines: [
        '$2.50M–$12.0M at list prices, 2026-11-16 to 2026-11-22: all tokens at the input price to all at the output price.',
        '90.0% of its tokens matched a priced SKU.',
      ],
      gap: null,
      ref: refOf(RANKINGS),
      refs: [refOf(PRICES)],
    })
  })

  it('reads strain from the newest complete probe day', () => {
    expect(sheet.probes).toMatchObject({
      label: 'Probes rate limited or failed, 2026-11-23',
      value: '12.5%',
      delta: '−20% peak speed vs off-peak',
      lines: [
        '24 hourly probes of model-0: 2 rate limited, 1 failed.',
        '40.0 tokens/s in working hours, 50.0 at night (13:00–21:00 UTC against 04:00–10:00).',
      ],
      gap: null,
    })
  })

  it('prints the disclosure summary with its median lag', () => {
    expect(sheet.disclosures).toMatchObject({
      value: '7',
      delta: null,
      lines: ['And 2 notices.', 'Median 41.5 days from discovery to publication, over 6 reports.'],
      ref: refOf('https://alignment.anthropic.com/'),
    })
  })

  it('lists each tied board with its week change, a failing read and a board not read yet', () => {
    expect(
      sheet.boards.rows.map((r) => [r.ticker, r.open, r.datacenter, r.change, r.read]),
    ).toEqual([
      ['CRWV', '316', '44', '+12 open, −3 data-center', '2026-11-23'],
      ['GOOGL', null, '44', 'First week on record', '2026-11-20, failing since 2026-11-22'],
      ['NBIS', null, '', '', ''],
    ])
    expect(sheet.boards.rows[2]!.gap?.title).toBe('Not read yet')
    expect(sheet.boards.notes).toEqual([
      'Google: we read only its data-center roles, so there is no total.',
      'Dell (DELL): Not read: needs a reader of its own.',
    ])
  })

  it('scores each tied company’s calls and prints its newest scored figure with both sources', () => {
    expect(sheet.calls.summary).toBe(
      '2 of 3 guided figures scored against a later filing: 1 met, 1 above, 0 below. Median miss on dollar figures 2%.',
    )
    const [msft, aep] = sheet.calls.rows
    expect(msft).toMatchObject({
      scored: '2 of 3',
      results: '1 met, 1 above, 0 below',
      newest: 'Capex, Q1 FY2027: guided $30B to $32B, filed $31.4B. Met.',
      refs: [
        refOf('https://example.com/msft-call'),
        refOf('https://www.sec.gov/Archives/edgar/data/789019/000095017026000001/'),
      ],
      gap: null,
    })
    expect(aep!.gap).toEqual({
      title: 'No guidance read',
      reason: 'We haven’t stored a guided figure from AEP’s calls yet.',
    })
  })

  it('drops the quotes and the unscored statements before the payload', () => {
    expect(calls.statements.map((s) => s.id)).toEqual(['s1', 'older'])
    expect(calls.statements.every((s) => s.quote === '')).toBe(true)
  })

  it('carries each panel’s caveat in the footer', () => {
    expect(sheet.caveats.map((c) => c.text)).toEqual([
      'Spend caveat.',
      'Probe caveat.',
      'Disclosure caveat.',
      'Hiring rule.',
      'Call rule.',
    ])
  })

  it('numbers every source once', () => {
    expect(new Set(sheet.sources.map((s) => s.url)).size).toBe(sheet.sources.length)
  })
})

describe('tear sheet panel gaps', () => {
  it('states a gap for every panel when no payload loaded', () => {
    const sheet = buildTearSheet('anthropic', {})
    expect(sheet.releases.gap?.title).toBe('No new SKU since tracking began')
    expect(sheet.spend.gap?.title).toBe('No spend data yet')
    expect(sheet.probes.gap?.title).toBe('No probe data yet')
    expect(sheet.disclosures.gap?.title).toBe('No disclosure data yet')
    expect(sheet.boards.gap?.title).toBe('No board read')
    expect(sheet.calls.gap?.title).toBe('No call read')
    expect(sheet.caveats).toEqual([])
  })

  it('names an excluded lab and a lab with no tokens instead of a zero share', () => {
    expect(buildTearSheet('deepseek', inputs).spend.gap).toEqual({
      title: 'Not priceable',
      reason: 'No priced SKU matched.',
    })
    expect(buildTearSheet('mistral', inputs).spend.gap?.title).toBe('No tokens in the window')
  })

  it('waits for a complete probe day, and names a lab we can’t probe', () => {
    const today = structuredClone(inputs)
    today.probes!.labs = [probeLab({ days: [] })]
    expect(buildTearSheet('anthropic', today).probes.gap?.title).toBe('First full day pending')
    today.probes!.labs = [probeLab({ status: 'not_probed', gap: 'No first-party endpoint.' })]
    expect(buildTearSheet('anthropic', today).probes.gap).toEqual({
      title: 'Not probed',
      reason: 'No first-party endpoint.',
    })
  })

  it('prints the audit’s reason for a lab with no disclosure index', () => {
    const cut = structuredClone(inputs)
    cut.disclosures!.providers = [
      {
        ...cut.disclosures!.providers[0]!,
        provider: 'xai',
        display: 'xAI',
        feed: 'no_public_feed',
        reason: 'No public disclosure index.',
      },
    ]
    expect(buildTearSheet('xai', cut).disclosures.gap?.reason).toBe('No public disclosure index.')
  })
})
