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
import {
  parseOpenAiDocsPricingHtml,
  parseOpenAiPricingHtml2023,
  parseOpenAiPricingMd2026,
  parseOpenAiPricingHtml2024,
} from '../parsers/pricing/wayback-openai'

/** The day the live pipeline began watching the labs' pages (docs/source-audit.md). */
export const ARCHIVE_UNTIL = '2026-08-25T00:00:00.000Z'

/** The earliest instant the backfill looks at. */
export const ARCHIVE_FROM = '2023-01-01T00:00:00.000Z'

export type ArchiveProvider = 'openai' | 'anthropic'

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
    id: 'openai-docs-pricing-2026',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing',
    from: '2026-02-01T00:00:00.000Z',
    until: '2026-03-08T00:00:00.000Z',
    shape: 'developers.openai.com/api/docs/pricing: one Text tokens table per service tier',
    parse: parseOpenAiDocsPricingHtml,
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
    from: '2025-01-28',
    until: '2026-02-01',
    reason:
      'In late January 2025 openai.com/api/pricing changed its layout, and we don’t read the new one yet. From March 2025 the Archive only has a Cloudflare check page there. Its copies of platform.openai.com/docs/pricing have no prices in them.',
  },
  {
    provider: 'openai',
    from: '2026-03-08',
    until: '2026-07-29',
    reason:
      'In March 2026 developers.openai.com/api/docs/pricing switched to tabbed tables per model family, and we don’t read those yet. The Archive’s first copy of the markdown version is from 2026-07-29.',
  },
  {
    provider: 'anthropic',
    from: '2023-01-01',
    until: '2024-03-01',
    reason:
      'Anthropic published Claude 2 prices as a PDF rate card. The Archive has no page with them as text.',
  },
]

/** Labs whose archived pricing pages are not read yet, and why. Printed on /data and in the audit. */
export const ARCHIVE_NOT_COVERED: readonly { provider: string; reason: string }[] = [
  {
    provider: 'google',
    reason:
      'Google’s old pricing page prices each model by input type and prompt length in running text. We don’t read those copies yet.',
  },
  {
    provider: 'xai',
    reason:
      'The Archive has copies (x.ai/api from November 2024, docs.x.ai from January 2025). We don’t read them yet.',
  },
  {
    provider: 'mistral',
    reason:
      'The Archive has copies (docs.mistral.ai from December 2023, mistral.ai/pricing from March 2025). We don’t read them yet.',
  },
  {
    provider: 'meta',
    reason: 'Meta had no API price list of its own before the page we check now.',
  },
  {
    provider: 'deepseek',
    reason:
      'DeepSeek became a tracked lab on 2026-11-04, after the backfill was built. We haven’t checked the Archive’s copies of its pricing page yet.',
  },
  {
    provider: 'alibaba',
    reason:
      'Alibaba became a tracked lab on 2026-11-04, after the backfill was built. We haven’t checked the Archive’s copies of its Model Studio pricing page yet.',
  },
  {
    provider: 'moonshot',
    reason:
      'Moonshot AI’s pricing page draws its tables with scripts, so neither the live page nor an archived copy holds prices we can read.',
  },
]

export function eraById(id: string): ArchiveEra | null {
  return ARCHIVE_ERAS.find((e) => e.id === id) ?? null
}
