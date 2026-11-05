// The identifiers a fund keys its security master on, one row per company the
// terminal names: each lab, each SEC filer we read, and each comparison
// company in a thesis. entity_id is the value of every `provider` and
// `company` column in the exports, so this table is the join from our rows
// to CIK, LEI, ticker, MIC and FIGI.
//
// Every value was read off a fetched response committed under
// fixtures/identifiers/ (fixtures/manifest.json has each fetch), and carries
// the URL and time it was read. layers/terminal/test/terminal-identifiers.test.ts
// fails when a value stops matching its fixture. An identifier we couldn't
// verify is null, with the reason in its note. Which security carries a lab
// (a parent, a disclosed investor) is entity_securities (terminal-entities.ts),
// not this table.

import { ENTITY_SECURITIES, type EntitySecurity } from './terminal-entities'

export const ENTITY_IDENTIFIER_COLUMNS = [
  'entity_id',
  'entity_name',
  'entity_kind',
  'legal_name',
  'country',
  'listing_status',
  'cik',
  'cik_source_url',
  'cik_fetched_at',
  'lei',
  'lei_status',
  'lei_note',
  'lei_source_url',
  'lei_fetched_at',
  'ticker',
  'exchange',
  'mic',
  'figi',
  'share_class_figi',
  'figi_source_url',
  'figi_fetched_at',
  'note',
  'source_url',
  'fetched_at',
] as const

type Column = (typeof ENTITY_IDENTIFIER_COLUMNS)[number]

export type ListingStatus = 'listed' | 'registered' | 'subsidiary' | 'private'

export interface EntityIdentifier extends Record<Column, string | null> {
  entity_id: string
  entity_name: string
  /** lab: one of the nine. filer: a company whose SEC filings we read. company: a thesis comparison company. */
  entity_kind: 'lab' | 'filer' | 'company'
  /**
   * listed: its own shares trade. registered: an S-1 is on file, not yet
   * trading. subsidiary: owned by a listed parent (entity_securities names
   * it). private: no listed shares.
   */
  listing_status: ListingStatus
}

/** SEC's ticker file: CIK, name, ticker and exchange for every listed filer. */
export const SEC_TICKERS = {
  url: 'https://www.sec.gov/files/company_tickers_exchange.json',
  fetched_at: '2026-11-05T04:42:32Z',
} as const

/** The LEIs below, read from GLEIF in one request. */
export const GLEIF_LEIS = [
  '984500C7AD3A48B9FP18',
  '984500B6DEB8CEBC4Z70',
  '7ZW8QJWVPR4P1J1KQY45',
  'BQ4BKCS1HXDV9HN80Z93',
  '894500Q9JNDV9YXSOL64',
  '5493001NTNQJDH60PM02',
  '5493006MHB84DD0ZWV18',
  '549300B9WLO96RQCXP87',
  'INR2EJN1ERAN0W5ZP974',
  'ZXTILKJKG63JELOEG630',
  '549300S4KLFTLO7GSQ80',
  '1Z4GXXU7ZHVWFCD8TV52',
  '984500511DP2B6186053',
  '5493007DY18BGNLDWU14',
  'OC1LZNN2LF5WTJ5RIL89',
  '549300E2FZC83FJ3H565',
  '549300GGZHJ5Q1B18P93',
  '549300EPISPY3RE3DL21',
  '254900Z9HH7932FVW892',
] as const

export const GLEIF_RECORDS = {
  url: `https://api.gleif.org/api/v1/lei-records?filter%5Blei%5D=${GLEIF_LEIS.join(',')}&page%5Bsize%5D=50`,
  fetched_at: '2026-11-05T04:51:30Z',
} as const

const gleifSearch = (query: string, fetched_at: string) => ({
  url: `https://api.gleif.org/api/v1/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(query)}&page%5Bsize%5D=15`,
  fetched_at,
})

/** OpenFIGI's mapping API. The first two requests ask for each ticker's US composite listing. */
const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping'
const FIGI_FIRST = '2026-11-05T04:51:36Z'
const FIGI_SECOND = '2026-11-05T04:51:39Z'

const lab = (page: string, fetched_at: string) => ({ url: page, fetched_at })
const XAI_TERMS = lab('https://x.ai/legal/terms-of-service', '2026-11-05T04:43:49Z')
const DEEPSEEK_TERMS = lab(
  'https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html',
  '2026-11-05T04:43:50Z',
)
const TOGETHER_TERMS = lab('https://www.together.ai/terms-of-service', '2026-11-05T04:43:52Z')

interface Listing {
  ticker: string
  exchange: string | null
  mic: string
  figi: string
  share_class_figi: string
  figi_fetched_at: string
}

/** A company with an LEI, and with a CIK and listing when it has them. */
function identified(
  base: Pick<EntityIdentifier, 'entity_id' | 'entity_name' | 'entity_kind' | 'listing_status'> & {
    legal_name: string
    country: string
    cik: string | null
    lei: string
    lei_note: string
    listing: Listing | null
    note: string | null
  },
): EntityIdentifier {
  const { listing, ...rest } = base
  return {
    ...rest,
    cik_source_url: rest.cik ? SEC_TICKERS.url : null,
    cik_fetched_at: rest.cik ? SEC_TICKERS.fetched_at : null,
    lei_status: 'ISSUED',
    lei_source_url: GLEIF_RECORDS.url,
    lei_fetched_at: GLEIF_RECORDS.fetched_at,
    ticker: listing?.ticker ?? null,
    exchange: listing?.exchange ?? null,
    mic: listing?.mic ?? null,
    figi: listing?.figi ?? null,
    share_class_figi: listing?.share_class_figi ?? null,
    figi_source_url: listing ? OPENFIGI_URL : null,
    figi_fetched_at: listing?.figi_fetched_at ?? null,
    source_url: GLEIF_RECORDS.url,
    fetched_at: GLEIF_RECORDS.fetched_at,
  }
}

/** A company GLEIF has no LEI for: its name as its own page states it. */
function unidentified(
  base: Pick<EntityIdentifier, 'entity_id' | 'entity_name' | 'entity_kind' | 'listing_status'> & {
    legal_name: string | null
    country: string | null
    lei_note: string
    lei_search: { url: string; fetched_at: string } | null
    note: string | null
    source: { url: string; fetched_at: string } | null
  },
): EntityIdentifier {
  const { lei_search, source, ...rest } = base
  return {
    ...rest,
    cik: null,
    cik_source_url: null,
    cik_fetched_at: null,
    lei: null,
    lei_status: null,
    lei_source_url: lei_search?.url ?? null,
    lei_fetched_at: lei_search?.fetched_at ?? null,
    ticker: null,
    exchange: null,
    mic: null,
    figi: null,
    share_class_figi: null,
    figi_source_url: null,
    figi_fetched_at: null,
    source_url: source?.url ?? null,
    fetched_at: source?.fetched_at ?? null,
  }
}

const NAMED_LISTED =
  'GLEIF’s legal name and jurisdiction match the issuer EDGAR lists under this CIK.'

export const ENTITY_IDENTIFIERS: readonly EntityIdentifier[] = [
  identified({
    entity_id: 'openai',
    entity_name: 'OpenAI',
    entity_kind: 'lab',
    legal_name: 'OPENAI OPCO, LLC',
    country: 'US',
    listing_status: 'private',
    cik: null,
    lei: '984500C7AD3A48B9FP18',
    lei_note:
      'OpenAI’s terms of use (openai.com/policies/terms-of-use) name OpenAI OpCo, LLC, a Delaware company, as the party you contract with. GLEIF lists it in Delaware. GLEIF also lists OAI International, Inc. and OpenAI Ireland Limited, which we don’t map.',
    listing: null,
    note: 'No EDGAR filer, so no CIK. Microsoft discloses a stake (entity_securities).',
  }),
  identified({
    entity_id: 'anthropic',
    entity_name: 'Anthropic',
    entity_kind: 'lab',
    legal_name: 'ANTHROPIC, PBC',
    country: 'US',
    listing_status: 'registered',
    cik: '0002130357',
    lei: '984500B6DEB8CEBC4Z70',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'ANT',
      exchange: null,
      mic: 'XNGS',
      figi: 'BBG0118LR3N0',
      share_class_figi: 'BBG0118LR3P8',
      figi_fetched_at: FIGI_SECOND,
    },
    note: 'Not yet trading. ANT is the symbol the S-1 proposes on the Nasdaq Global Select Market, and OpenFIGI already lists it there. EDGAR lists ANT with no exchange.',
  }),
  identified({
    entity_id: 'google',
    entity_name: 'Google',
    entity_kind: 'lab',
    legal_name: 'GOOGLE LLC',
    country: 'US',
    listing_status: 'subsidiary',
    cik: null,
    lei: '7ZW8QJWVPR4P1J1KQY45',
    lei_note:
      'Alphabet’s 10-K lists Google LLC (Delaware) as a subsidiary. GLEIF lists it in Delaware.',
    listing: null,
    note: 'Alphabet (alphabet) files for the group and is the listed security (entity_securities). EDGAR still names CIK 0001288776 GOOGLE INC., which we don’t map.',
  }),
  unidentified({
    entity_id: 'xai',
    entity_name: 'xAI',
    entity_kind: 'lab',
    legal_name: 'SpaceX Super Intelligence LLC',
    country: 'US',
    listing_status: 'subsidiary',
    lei_note:
      'GLEIF has no record for SpaceX Super Intelligence LLC, or for X.AI Holdings Corp., the company SpaceX merged with.',
    lei_search: gleifSearch('SpaceX Super Intelligence', '2026-11-05T04:51:31Z'),
    note: 'xAI’s terms of service name SpaceX Super Intelligence LLC, a Nevada company. SpaceX (spacex) is the listed parent.',
    source: XAI_TERMS,
  }),
  identified({
    entity_id: 'meta',
    entity_name: 'Meta',
    entity_kind: 'lab',
    legal_name: 'META PLATFORMS, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001326801',
    lei: 'BQ4BKCS1HXDV9HN80Z93',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'META',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000MM2P62',
      share_class_figi: 'BBG001SQCQC5',
      figi_fetched_at: FIGI_FIRST,
    },
    note: 'The lab is part of the issuer.',
  }),
  identified({
    entity_id: 'mistral',
    entity_name: 'Mistral',
    entity_kind: 'lab',
    legal_name: 'MISTRAL AI',
    country: 'FR',
    listing_status: 'private',
    cik: null,
    lei: '894500Q9JNDV9YXSOL64',
    lei_note:
      'Mistral’s commercial terms (legal.mistral.ai/terms/commercial-terms-of-service) give its Paris registration number as 952 418 325. GLEIF lists the same number.',
    listing: null,
    note: 'No EDGAR filer, so no CIK.',
  }),
  unidentified({
    entity_id: 'deepseek',
    entity_name: 'DeepSeek',
    entity_kind: 'lab',
    legal_name: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
    country: 'CN',
    listing_status: 'private',
    lei_note:
      'GLEIF has no record for Hangzhou DeepSeek. Its one DeepSeek company is DEEPSEEK S.R.L. in Romania, which we don’t map.',
    lei_search: gleifSearch('Hangzhou DeepSeek', '2026-11-05T04:51:32Z'),
    note: 'DeepSeek’s terms of use name the operator and put disputes under the laws of the People’s Republic of China. No EDGAR filer.',
    source: DEEPSEEK_TERMS,
  }),
  identified({
    entity_id: 'alibaba',
    entity_name: 'Alibaba',
    entity_kind: 'lab',
    legal_name: 'Alibaba Group Holding Limited',
    country: 'KY',
    listing_status: 'listed',
    cik: '0001577552',
    lei: '5493001NTNQJDH60PM02',
    lei_note: 'GLEIF’s legal name matches the issuer EDGAR lists under this CIK.',
    listing: {
      ticker: 'BABA',
      exchange: 'NYSE',
      mic: 'XNYS',
      figi: 'BBG006G2JVL2',
      share_class_figi: 'BBG006G2JWB1',
      figi_fetched_at: FIGI_FIRST,
    },
    note: 'BABA is American depositary shares. Qwen is built by Alibaba Cloud inside this issuer, and no page we read names the one subsidiary that sells it.',
  }),
  unidentified({
    entity_id: 'moonshot',
    entity_name: 'Moonshot AI',
    entity_kind: 'lab',
    legal_name: null,
    country: null,
    listing_status: 'private',
    lei_note:
      'GLEIF lists Moonshot AI Ltd (Cayman Islands) and Moonshot AI HK Limited. Moonshot’s platform agreement says only “Moonshot AI”, so we can’t tell which one it is.',
    lei_search: gleifSearch('Moonshot AI', '2026-11-05T04:51:34Z'),
    note: 'No EDGAR filer.',
    source: null,
  }),
  identified({
    entity_id: 'alphabet',
    entity_name: 'Alphabet',
    entity_kind: 'filer',
    legal_name: 'ALPHABET INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001652044',
    lei: '5493006MHB84DD0ZWV18',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'GOOGL',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG009S39JX6',
      share_class_figi: 'BBG009S39JY5',
      figi_fetched_at: FIGI_FIRST,
    },
    note: 'Google’s parent. Class A. GOOG (class C) is in entity_securities.',
  }),
  identified({
    entity_id: 'spacex',
    entity_name: 'SpaceX',
    entity_kind: 'filer',
    legal_name: 'SPACE EXPLORATION TECHNOLOGIES CORP.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001181412',
    lei: '549300B9WLO96RQCXP87',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'SPCX',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000NQF3Z5',
      share_class_figi: 'BBG001SQPN65',
      figi_fetched_at: FIGI_FIRST,
    },
    note: 'xAI’s parent.',
  }),
  identified({
    entity_id: 'microsoft',
    entity_name: 'Microsoft',
    entity_kind: 'filer',
    legal_name: 'MICROSOFT CORPORATION',
    country: 'US',
    listing_status: 'listed',
    cik: '0000789019',
    lei: 'INR2EJN1ERAN0W5ZP974',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'MSFT',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000BPH459',
      share_class_figi: 'BBG001S5TD05',
      figi_fetched_at: FIGI_FIRST,
    },
    note: null,
  }),
  identified({
    entity_id: 'amazon',
    entity_name: 'Amazon',
    entity_kind: 'filer',
    legal_name: 'AMAZON.COM, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001018724',
    lei: 'ZXTILKJKG63JELOEG630',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'AMZN',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000BVPV84',
      share_class_figi: 'BBG001S5PQL7',
      figi_fetched_at: FIGI_FIRST,
    },
    note: null,
  }),
  identified({
    entity_id: 'nvidia',
    entity_name: 'NVIDIA',
    entity_kind: 'filer',
    legal_name: 'NVIDIA CORPORATION',
    country: 'US',
    listing_status: 'listed',
    cik: '0001045810',
    lei: '549300S4KLFTLO7GSQ80',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'NVDA',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000BBJQV0',
      share_class_figi: 'BBG001S5TZJ6',
      figi_fetched_at: FIGI_FIRST,
    },
    note: null,
  }),
  identified({
    entity_id: 'oracle',
    entity_name: 'Oracle',
    entity_kind: 'filer',
    legal_name: 'ORACLE CORPORATION',
    country: 'US',
    listing_status: 'listed',
    cik: '0001341439',
    lei: '1Z4GXXU7ZHVWFCD8TV52',
    lei_note:
      'GLEIF’s legal name matches the issuer EDGAR lists under this CIK. EDGAR gives no state of incorporation to check against.',
    listing: {
      ticker: 'ORCL',
      exchange: 'NYSE',
      mic: 'XNYS',
      figi: 'BBG000BQLTW7',
      share_class_figi: 'BBG001S5SJG6',
      figi_fetched_at: FIGI_FIRST,
    },
    note: null,
  }),
  identified({
    entity_id: 'coreweave',
    entity_name: 'CoreWeave',
    entity_kind: 'filer',
    legal_name: 'COREWEAVE, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001769628',
    lei: '984500511DP2B6186053',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'CRWV',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG011ZTRJ21',
      share_class_figi: 'BBG011ZTRJ49',
      figi_fetched_at: FIGI_FIRST,
    },
    note: null,
  }),
  identified({
    entity_id: 'cloudflare',
    entity_name: 'Cloudflare',
    entity_kind: 'company',
    legal_name: 'CLOUDFLARE, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001477333',
    lei: '5493007DY18BGNLDWU14',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'NET',
      exchange: 'NYSE',
      mic: 'XNYS',
      figi: 'BBG001WMKHH5',
      share_class_figi: 'BBG001WMKHJ3',
      figi_fetched_at: FIGI_SECOND,
    },
    note: null,
  }),
  identified({
    entity_id: 'akamai',
    entity_name: 'Akamai',
    entity_kind: 'company',
    legal_name: 'AKAMAI TECHNOLOGIES, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001086222',
    lei: 'OC1LZNN2LF5WTJ5RIL89',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'AKAM',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG000BJQWD2',
      share_class_figi: 'BBG001S7YHX0',
      figi_fetched_at: FIGI_SECOND,
    },
    note: null,
  }),
  identified({
    entity_id: 'fastly',
    entity_name: 'Fastly',
    entity_kind: 'company',
    legal_name: 'FASTLY, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001517413',
    lei: '549300E2FZC83FJ3H565',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'FSLY',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG004NLQHL0',
      share_class_figi: 'BBG004NLQHM9',
      figi_fetched_at: FIGI_SECOND,
    },
    note: 'EDGAR lists Nasdaq. OpenFIGI also still lists a NYSE line (UN) for FSLY.',
  }),
  identified({
    entity_id: 'nebius',
    entity_name: 'Nebius',
    entity_kind: 'company',
    legal_name: 'Nebius Group N.V.',
    country: 'NL',
    listing_status: 'listed',
    cik: '0001513845',
    lei: '549300GGZHJ5Q1B18P93',
    lei_note: 'GLEIF’s legal name matches the issuer EDGAR lists under this CIK.',
    listing: {
      ticker: 'NBIS',
      exchange: 'Nasdaq',
      mic: 'XNGS',
      figi: 'BBG001NVJ6W4',
      share_class_figi: 'BBG001TBY593',
      figi_fetched_at: FIGI_SECOND,
    },
    note: null,
  }),
  identified({
    entity_id: 'digitalocean',
    entity_name: 'DigitalOcean',
    entity_kind: 'company',
    legal_name: 'DIGITALOCEAN HOLDINGS, INC.',
    country: 'US',
    listing_status: 'listed',
    cik: '0001582961',
    lei: '549300EPISPY3RE3DL21',
    lei_note: NAMED_LISTED,
    listing: {
      ticker: 'DOCN',
      exchange: 'NYSE',
      mic: 'XNYS',
      figi: 'BBG00ZGF6SS3',
      share_class_figi: 'BBG00ZGF6TM7',
      figi_fetched_at: FIGI_SECOND,
    },
    note: null,
  }),
  identified({
    entity_id: 'lambda',
    entity_name: 'Lambda',
    entity_kind: 'company',
    legal_name: 'LAMBDA, INC.',
    country: 'US',
    listing_status: 'private',
    cik: null,
    lei: '254900Z9HH7932FVW892',
    lei_note:
      'Lambda’s terms of service (lambda.ai/legal/terms-of-service) name Lambda, Inc., a Delaware company. GLEIF lists it in Delaware.',
    listing: null,
    note: 'No EDGAR filing we read.',
  }),
  unidentified({
    entity_id: 'together',
    entity_name: 'Together AI',
    entity_kind: 'company',
    legal_name: 'Together Computer, Inc.',
    country: 'US',
    listing_status: 'private',
    lei_note: 'GLEIF has no record for Together Computer, Inc.',
    lei_search: gleifSearch('Together Computer', '2026-11-05T04:51:35Z'),
    note: 'Together AI’s terms say the site is owned and operated by Together Computer, Inc., a Delaware corporation. No EDGAR filing we read.',
    source: TOGETHER_TERMS,
  }),
  unidentified({
    entity_id: 'crusoe',
    entity_name: 'Crusoe',
    entity_kind: 'company',
    legal_name: null,
    country: null,
    listing_status: 'private',
    lei_note:
      'We read no page that names Crusoe’s legal entity, so there’s no name to match an LEI to.',
    lei_search: null,
    note: null,
    source: null,
  }),
  unidentified({
    entity_id: 'verda',
    entity_name: 'Verda',
    entity_kind: 'company',
    legal_name: null,
    country: null,
    listing_status: 'private',
    lei_note:
      'We read no page that names Verda’s legal entity, so there’s no name to match an LEI to.',
    lei_search: null,
    note: null,
    source: null,
  }),
]

export const JOINING_NOTE =
  'Every provider and company column holds an entity_id from entity_identifiers. That table has each company’s CIK, LEI, ticker, MIC, and FIGI, each with the URL and time we read it. A lab without listed shares of its own (OpenAI, Google, xAI) reaches a security through entity_securities, which names the parent or disclosed investor and the filing that says so. Tables with a cik or ticker column join on that too. A provider of other is a company we don’t identify.'

export interface IdentifiersPayload {
  joining: string
  identifiers: readonly EntityIdentifier[]
  securities: readonly EntitySecurity[]
}

/** GET /api/identifiers and the get_identifiers tool: both registries, narrowed to one entity_id if asked. */
export function identifiersPayload(entity?: string): IdentifiersPayload {
  return {
    joining: JOINING_NOTE,
    identifiers: ENTITY_IDENTIFIERS.filter((r) => !entity || r.entity_id === entity),
    securities: ENTITY_SECURITIES.filter((r) => !entity || r.entity === entity),
  }
}
