// The eras of each lab's rate-limit page, as the Internet Archive holds them,
// for the history before the live limits-* recipes (theses/recipes/
// rate-limits.ts). Windows are half-open [from, until) and never overlap
// within a lab; every era ends by LIMITS_LIVE_FROM, from when the live
// recipes hold the record.
//
// Only Anthropic's copies read: its page moved from docs.anthropic.com to
// docs.claude.com to platform.claude.com with the rest of its docs, and every
// HTML copy prints the usage-tier table. OpenAI's rate-limit guide and model
// pages are script shells in every copy (about 3 KB), xAI's docs render their
// tables in the browser, and Meta's page has copies only from 2026-08: those
// are LIMITS_ARCHIVE_NOT_COVERED. How each window was found:
// docs/source-audit.md › "Addendum, 2026-11-21: Internet Archive (rate
// limits and usage tiers)".

import type { LabId } from '../../../../core/shared/types/common'
import { extractAnthropicLimits, mdTables } from '../../recipes/rate-limits'
import {
  parseAnthropicLimitsHtml,
  type ArchivedLimitsRead,
} from '../parsers/limits/wayback-anthropic-limits'

/** The first run of the live limits-* recipes. */
export const LIMITS_LIVE_FROM = '2026-11-04T00:00:00.000Z'

export interface LimitsEra {
  id: string
  provider: Extract<LabId, 'anthropic'>
  /** The live recipe the rows continue. */
  recipe_id: string
  url: string
  from: string
  until: string
  shape: string
  parse: (text: string) => ArchivedLimitsRead
  ext?: 'md' | 'html'
}

/**
 * The live recipe's Markdown reader, on a copy of the same .md page. The June
 * 2026 copy escapes its dollar signs and prints N/A where the live page
 * prints a dash; both read as the live page would.
 */
function anthropicMd(text: string): ArchivedLimitsRead {
  const md = text.replace(/\\\$/g, '$').replace(/\|\s*N\/A\s*(?=\|)/g, '| — ')
  // The live reader takes the spend table's second column as the monthly
  // cap. A copy whose second column is something else keeps its rates only.
  const spend = mdTables(md).find(
    (t) => t.section === 'Spend limits' && t.header[0] === 'Usage tier',
  )
  const capOk = !spend || /spend cap|spend limit|max usage/i.test(spend.header[1] ?? '')
  return {
    passed: capOk ? [] : [`the spend table's second column is "${spend!.header[1]}", not a cap`],
    rows: extractAnthropicLimits(md, '')
      .filter((o) => capOk || (o.payload as { model: string }).model !== 'spend cap')
      .map((o) => {
        const p = o.payload as { model: string; tier: string; metric: string }
        return {
          key: o.key,
          model: p.model,
          tier: p.tier,
          metric: p.metric,
          value: o.value,
          printed: { tier: p.tier, column: p.metric },
        }
      }),
  }
}

export const LIMITS_ARCHIVE_ERAS: readonly LimitsEra[] = [
  {
    id: 'anthropic-rate-limits-2024',
    provider: 'anthropic',
    recipe_id: 'limits-anthropic',
    url: 'https://docs.anthropic.com/claude/reference/rate-limits',
    from: '2024-03-01T00:00:00.000Z',
    until: '2024-05-21T00:00:00.000Z',
    shape:
      'docs.anthropic.com/claude/reference: the usage-tier table and one rate table per tier, each under a labeled radio button',
    parse: parseAnthropicLimitsHtml,
  },
  {
    id: 'anthropic-rate-limits-docs-2024',
    provider: 'anthropic',
    recipe_id: 'limits-anthropic',
    url: 'https://docs.anthropic.com/en/api/rate-limits',
    from: '2024-05-21T00:00:00.000Z',
    until: '2025-09-19T00:00:00.000Z',
    shape:
      'docs.anthropic.com/en/api: the usage-tier table, and a tab per tier whose first tab alone was rendered until 2025',
    parse: parseAnthropicLimitsHtml,
  },
  {
    id: 'anthropic-rate-limits-claude-docs-2025',
    provider: 'anthropic',
    recipe_id: 'limits-anthropic',
    url: 'https://docs.claude.com/en/api/rate-limits',
    from: '2025-09-19T00:00:00.000Z',
    until: '2025-11-19T00:00:00.000Z',
    shape: 'docs.claude.com: the same page after the docs moved',
    parse: parseAnthropicLimitsHtml,
  },
  {
    id: 'anthropic-rate-limits-platform-2025',
    provider: 'anthropic',
    recipe_id: 'limits-anthropic',
    url: 'https://platform.claude.com/docs/en/api/rate-limits',
    from: '2025-11-19T00:00:00.000Z',
    until: '2026-06-01T00:00:00.000Z',
    shape: 'platform.claude.com: the usage-tier table; the rate tables render in the browser',
    parse: parseAnthropicLimitsHtml,
  },
  {
    id: 'anthropic-rate-limits-md-2026',
    provider: 'anthropic',
    recipe_id: 'limits-anthropic',
    url: 'https://platform.claude.com/docs/en/api/rate-limits.md',
    from: '2026-06-01T00:00:00.000Z',
    until: LIMITS_LIVE_FROM,
    shape: 'platform.claude.com .md: the page the live recipe reads, every tier',
    parse: anthropicMd,
    ext: 'md',
  },
]

/** Live limits pages with no archived history we read, and why. */
export const LIMITS_ARCHIVE_NOT_COVERED: readonly { provider: LabId; reason: string }[] = [
  {
    provider: 'openai',
    reason:
      'Every copy of platform.openai.com/docs/guides/rate-limits and of the model pages before 2026-10 is a script shell of about 3 KB: the limits load in the browser. The .md model pages the live recipe reads have copies only from 2026-10.',
  },
  {
    provider: 'xai',
    reason:
      'docs.x.ai’s copies (models from 2025-01, consumption and rate limits from 2025-05, developers/rate-limits from 2026-02) carry no table: the page draws them in the browser.',
  },
  {
    provider: 'meta',
    reason:
      'dev.meta.ai’s rate-limit page has copies only from 2026-08, three months before our first read.',
  },
]
