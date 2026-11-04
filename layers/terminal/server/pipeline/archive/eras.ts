// The eras of each lab's pricing page, as the Internet Archive holds them:
// which URL the lab priced its API on, over which window, and which parser
// reads that shape. Windows are half-open [from, until) and never overlap
// within a lab, so the state of a lab's price list at an instant is the
// newest parsed capture of the one era covering it. Every era ends by
// ARCHIVE_UNTIL: from then on the live pipeline is the record.
//
// How each window was found: the CDX listing of each candidate URL
// (docs/source-audit.md › Internet Archive), cut where the lab moved its
// prices to the next URL. A gap between eras is a stretch where no capture
// of any page carries a readable price list; GAPS says why.

import type { PriceRow, Provenance } from '../contracts'
import { VendorMdPricingOutput } from '../contracts'
import { parseAnthropicPricingMd } from '../parsers/pricing/anthropic-pricing'
import {
  parseAnthropicModelsOverviewHtml,
  parseAnthropicPricingHtml,
} from '../parsers/pricing/wayback-anthropic'
import { parseAlibabaPricingHtmlArchived } from '../parsers/pricing/wayback-alibaba'
import { parseDeepseekPricingHtml } from '../parsers/pricing/wayback-deepseek'
import {
  parseGoogleDocsPricingHtml,
  parseGooglePricingCards,
} from '../parsers/pricing/wayback-google'
import {
  parseMistralDocsPricingHtml,
  parseMistralTechnologyHtml,
} from '../parsers/pricing/wayback-mistral'
import {
  parseOpenAiDocsPricingHtml,
  parseOpenAiDocsPricingIslands,
  parseOpenAiPricingHtml2023,
  parseOpenAiPricingHtml2025,
  parseOpenAiPricingMd2026,
  parseOpenAiPricingHtml2024,
} from '../parsers/pricing/wayback-openai'
import {
  parseXaiApiPage,
  parseXaiDocsModelsHtml,
  parseXaiModelsMdArchived,
} from '../parsers/pricing/wayback-xai'

/** The day the live pipeline began watching the labs' pages (docs/source-audit.md). */
export const ARCHIVE_UNTIL = '2026-08-25T00:00:00.000Z'

/** The earliest instant the backfill looks at. */
export const ARCHIVE_FROM = '2023-01-01T00:00:00.000Z'

export type ArchiveProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'mistral'
  | 'deepseek'
  | 'alibaba'

export interface ArchiveEra {
  id: string
  provider: ArchiveProvider
  /** The page as the lab published it; the CDX key. */
  url: string
  from: string
  until: string
  /** What the page looked like, for the audit and the reach panel. */
  shape: string
  /** `passed`: rows the page printed that the parser deliberately did not read, named on the capture. */
  parse: (text: string, prov: Provenance) => { rows: PriceRow[]; passed?: string[] }
}

const md =
  (parse: (text: string, prov: Provenance) => { rows: PriceRow[] }) =>
  (text: string, prov: Provenance) =>
    VendorMdPricingOutput.parse(parse(text, prov))

export const ARCHIVE_ERAS: readonly ArchiveEra[] = [
  {
    id: 'openai-pricing-2023',
    provider: 'openai',
    url: 'https://openai.com/pricing',
    from: ARCHIVE_FROM,
    until: '2024-05-02T00:00:00.000Z',
    shape: 'openai.com/pricing: HTML tables per model family, $ per 1K then per 1M tokens',
    parse: parseOpenAiPricingHtml2023,
  },
  {
    id: 'openai-api-pricing-2024',
    provider: 'openai',
    url: 'https://openai.com/api/pricing',
    from: '2024-05-02T00:00:00.000Z',
    until: '2025-01-28T00:00:00.000Z',
    shape: 'openai.com/api/pricing: a div grid per model family, standard and Batch API prices',
    parse: parseOpenAiPricingHtml2024,
  },
  {
    id: 'openai-api-pricing-2025',
    provider: 'openai',
    url: 'https://openai.com/api/pricing',
    from: '2025-01-28T00:00:00.000Z',
    until: '2025-02-14T00:00:00.000Z',
    shape:
      'openai.com/api/pricing: the 2024 feature groups with each row opening on its own column header',
    parse: parseOpenAiPricingHtml2025,
  },
  {
    id: 'openai-docs-pricing-2026',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing',
    from: '2026-02-01T00:00:00.000Z',
    until: '2026-03-08T00:00:00.000Z',
    shape: 'developers.openai.com/api/docs/pricing: one Text tokens table per service tier',
    parse: parseOpenAiDocsPricingHtml,
  },
  {
    id: 'openai-docs-pricing-2026b',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing',
    from: '2026-03-08T00:00:00.000Z',
    until: '2026-07-29T00:00:00.000Z',
    shape:
      'developers.openai.com/api/docs/pricing: per-tier tabs showing the latest models, the full list in each tab’s server-rendered island props',
    parse: parseOpenAiDocsPricingIslands,
  },
  {
    id: 'openai-pricing-md-2026',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing.md',
    from: '2026-07-29T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape:
      'developers.openai.com/api/docs/pricing.md: one table per service tier, one cache-writes column',
    parse: parseOpenAiPricingMd2026,
  },
  {
    id: 'anthropic-models-2024a',
    provider: 'anthropic',
    url: 'https://docs.anthropic.com/claude/docs/models-overview',
    from: '2024-03-01T00:00:00.000Z',
    until: '2024-05-21T00:00:00.000Z',
    shape: 'docs models overview: a model comparison table with a cost row',
    parse: parseAnthropicModelsOverviewHtml,
  },
  {
    id: 'anthropic-models-2024b',
    provider: 'anthropic',
    url: 'https://docs.anthropic.com/en/docs/models-overview',
    from: '2024-05-21T00:00:00.000Z',
    until: '2024-06-20T00:00:00.000Z',
    shape: 'docs models overview: a model comparison table with a cost row',
    parse: parseAnthropicModelsOverviewHtml,
  },
  {
    id: 'anthropic-models-2024c',
    provider: 'anthropic',
    url: 'https://docs.anthropic.com/en/docs/about-claude/models',
    from: '2024-06-20T00:00:00.000Z',
    until: '2025-02-24T00:00:00.000Z',
    shape: 'docs models overview: model comparison tables with a cost row',
    parse: parseAnthropicModelsOverviewHtml,
  },
  {
    id: 'anthropic-models-2025',
    provider: 'anthropic',
    url: 'https://docs.anthropic.com/en/docs/about-claude/models/all-models',
    from: '2025-02-24T00:00:00.000Z',
    until: '2025-05-12T00:00:00.000Z',
    shape: 'docs all-models page: model comparison tables with a cost row',
    parse: parseAnthropicModelsOverviewHtml,
  },
  {
    id: 'anthropic-pricing-docs-2025',
    provider: 'anthropic',
    url: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
    from: '2025-05-12T00:00:00.000Z',
    until: '2025-09-19T00:00:00.000Z',
    shape: 'docs pricing page: the Model pricing and Batch processing tables, as HTML',
    parse: parseAnthropicPricingHtml,
  },
  {
    id: 'anthropic-pricing-claude-docs-2025',
    provider: 'anthropic',
    url: 'https://docs.claude.com/en/docs/about-claude/pricing',
    from: '2025-09-19T00:00:00.000Z',
    until: '2025-11-19T00:00:00.000Z',
    shape: 'docs pricing page: the Model pricing and Batch processing tables, as HTML',
    parse: parseAnthropicPricingHtml,
  },
  {
    id: 'anthropic-pricing-platform-2025',
    provider: 'anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    from: '2025-11-19T00:00:00.000Z',
    until: '2026-06-11T00:00:00.000Z',
    shape: 'docs pricing page: the Model pricing and Batch processing tables, as HTML',
    parse: parseAnthropicPricingHtml,
  },
  {
    id: 'anthropic-pricing-md-2026',
    provider: 'anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    from: '2026-06-11T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape: 'platform.claude.com pricing.md: the markdown the live parser reads',
    parse: md(parseAnthropicPricingMd),
  },
  {
    id: 'google-pricing-2024',
    provider: 'google',
    url: 'https://ai.google.dev/pricing',
    from: '2023-12-01T00:00:00.000Z',
    until: '2025-02-11T00:00:00.000Z',
    shape:
      'ai.google.dev/pricing: one card per model, pay-as-you-go prices in running text by prompt length',
    parse: parseGooglePricingCards,
  },
  {
    id: 'google-docs-pricing-2025',
    provider: 'google',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    from: '2025-02-11T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape:
      'ai.google.dev/gemini-api/docs/pricing: an h2 per model, a three-column table per service tier, read by the live parser',
    parse: parseGoogleDocsPricingHtml,
  },
  {
    id: 'xai-api-2025',
    provider: 'xai',
    url: 'https://x.ai/api',
    from: '2024-11-04T00:00:00.000Z',
    until: '2025-07-11T00:00:00.000Z',
    shape: 'x.ai/api: one card per model, text input, image input and output per million tokens',
    parse: parseXaiApiPage,
  },
  {
    id: 'xai-docs-models-2025',
    provider: 'xai',
    url: 'https://docs.x.ai/docs/models',
    from: '2025-07-11T00:00:00.000Z',
    until: '2026-02-05T00:00:00.000Z',
    shape: 'docs.x.ai/docs/models: a Model Pricing table, input and output per million tokens',
    parse: parseXaiDocsModelsHtml,
  },
  {
    id: 'xai-models-md-2026',
    provider: 'xai',
    url: 'https://docs.x.ai/developers/models.md',
    from: '2026-03-12T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape: 'docs.x.ai/developers/models.md: a markdown price table, three successive layouts',
    parse: parseXaiModelsMdArchived,
  },
  {
    id: 'mistral-docs-pricing-2023',
    provider: 'mistral',
    url: 'https://docs.mistral.ai/platform/pricing',
    from: '2023-12-01T00:00:00.000Z',
    until: '2024-04-14T00:00:00.000Z',
    shape: 'docs.mistral.ai/platform/pricing: a table per API, EUR only, then USD and EUR columns',
    parse: parseMistralDocsPricingHtml,
  },
  {
    id: 'mistral-technology-2024',
    provider: 'mistral',
    url: 'https://mistral.ai/technology/',
    from: '2024-04-14T00:00:00.000Z',
    until: '2025-03-21T00:00:00.000Z',
    shape: 'mistral.ai/technology: pay-as-you-go tables per family, a USD table and its EUR twin',
    parse: parseMistralTechnologyHtml,
  },
  {
    id: 'deepseek-platform-pricing-2024',
    provider: 'deepseek',
    url: 'https://platform.deepseek.com/api-docs/pricing',
    from: '2024-05-01T00:00:00.000Z',
    until: '2024-11-04T00:00:00.000Z',
    shape: 'platform.deepseek.com/api-docs/pricing: a row per model, a USD table and a CNY table',
    parse: parseDeepseekPricingHtml,
  },
  {
    id: 'deepseek-api-docs-pricing-2024',
    provider: 'deepseek',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    from: '2024-11-04T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape:
      'api-docs.deepseek.com/quick_start/pricing: a row per model, then a column per model with time-of-day bands',
    parse: parseDeepseekPricingHtml,
  },
  {
    id: 'alibaba-model-pricing-2026',
    provider: 'alibaba',
    url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    from: '2026-01-16T00:00:00.000Z',
    until: ARCHIVE_UNTIL,
    shape:
      'Model Studio model-pricing: per Qwen line, an International tab, later a Singapore tab with a deployment-scope column',
    parse: parseAlibabaPricingHtmlArchived,
  },
]

/** Stretches with no readable archived price list, and why. Printed on /data and in the audit. */
export const ARCHIVE_GAPS: readonly {
  provider: string
  from: string
  until: string
  reason: string
}[] = [
  {
    provider: 'openai',
    from: '2025-02-01',
    until: '2026-02-01',
    reason:
      'From February 2025 the Archive’s copies of openai.com/api/pricing hold only the page shell, then a short list of flagship models by marketing name (“GPT-4.1”, “OpenAI o3”). That list isn’t the price list, so we don’t read it. The copies of platform.openai.com/docs/pricing and its model pages are script shells with no prices.',
  },
  {
    provider: 'anthropic',
    from: '2023-01-01',
    until: '2024-03-01',
    reason:
      'Anthropic published Claude 2 prices as a PDF rate card. The Archive’s copies of anthropic.com/product and the docs’ model pages from 2023 show no prices as text.',
  },
  {
    provider: 'google',
    from: '2023-01-01',
    until: '2024-06-15',
    reason:
      'Until January 2024 the Archive’s copies of ai.google.dev/pricing show no prices. Until April 2024 Gemini was priced per 1,000 characters, and we don’t convert units. The Gemini 1.5 prices shown in April and May 2024 weren’t billed yet (“Billing starts May 30, 2024”).',
  },
  {
    provider: 'xai',
    from: '2023-01-01',
    until: '2025-03-20',
    reason:
      'Until March 2025 x.ai/api showed no per-token prices, and the Archive’s copies of docs.x.ai from that time show none either.',
  },
  {
    provider: 'xai',
    from: '2025-04-17',
    until: '2025-07-28',
    reason:
      'From April 2025 x.ai/api lists only its featured models and hides the rest behind a button the Archive didn’t save. Read as a price list, the hidden models would look dropped. docs.x.ai’s copies show no prices until late July 2025.',
  },
  {
    provider: 'xai',
    from: '2025-12-21',
    until: '2026-03-12',
    reason:
      'From late December 2025 the Archive’s copies of docs.x.ai hold the price table before its scripts filled it in, and x.ai/api still lists featured models only. The markdown version starts 2026-03-12.',
  },
  {
    provider: 'mistral',
    from: '2023-01-01',
    until: '2024-02-26',
    reason:
      'Until late February 2024 docs.mistral.ai priced the API in euros only. We store prices as printed and don’t convert currencies.',
  },
  {
    provider: 'mistral',
    from: '2025-02-04',
    until: '2026-08-25',
    reason:
      'From March 2025 mistral.ai/pricing lists prices by product name (“Mistral Medium 3”) with no API model name, and we don’t guess which model a name means. The Archive’s first copy of the docs price list is from 2026-08-13, as HTML we don’t read.',
  },
  {
    provider: 'deepseek',
    from: '2023-01-01',
    until: '2024-05-25',
    reason: 'The Archive’s first copy of DeepSeek’s pricing page is from May 2024.',
  },
  {
    provider: 'alibaba',
    from: '2023-01-01',
    until: '2026-01-16',
    reason:
      'Before 2026 Alibaba printed its prices inside the Model Studio model list, by region, with tiered prices explained under each table. We don’t read that page yet. The Archive’s first copy of the model-pricing page is from 2026-01-16.',
  },
]

/** Labs whose archived pricing pages are not read yet, and why. Printed on /data and in the audit. */
export const ARCHIVE_NOT_COVERED: readonly { provider: string; reason: string }[] = [
  {
    provider: 'meta',
    reason: 'Meta had no API price list of its own before the page we check now.',
  },
  {
    provider: 'moonshot',
    reason:
      'Moonshot AI’s pricing pages draw their tables with scripts. Every Archive copy of platform.moonshot.ai (from June 2025) and platform.kimi.ai (from March 2026) holds the page shell or its headings only. platform.moonshot.cn prices in yuan, and we don’t convert currencies.',
  },
]

export function eraById(id: string): ArchiveEra | null {
  return ARCHIVE_ERAS.find((e) => e.id === id) ?? null
}
