import { describe, expect, test } from 'vitest'

import { VendorMdPricingOutput } from '../../server/pipeline/contracts'
import { parseAlibabaPricingHtml } from '../../server/pipeline/parsers/pricing/alibaba-pricing'
import { parseDeepseekPricingMd } from '../../server/pipeline/parsers/pricing/deepseek-pricing'
import { parseMoonshotModelsMd } from '../../server/pipeline/parsers/pricing/moonshot-models'
import { parseEdgarSubmissions } from '../../server/pipeline/parsers/sec/edgar-submissions'
import { parseCikWhitelistBlock } from '../../server/pipeline/parsers/sec/whitelist'
import { parseDeepseekStatus } from '../../server/pipeline/parsers/status/deepseek-status'
import { fixtureText, provenanceOf } from './fixtures'

// DeepSeek, Alibaba (Qwen) and Moonshot AI (Kimi), registered 2026-11-04
// (docs/source-audit.md). Every expected number below is read off the
// committed fixture by eye, never off the parser's own output.

describe('deepseek-pricing-md', () => {
  const out = parseDeepseekPricingMd(fixtureText('fixtures/pricing/deepseek-pricing.md'))

  test('two models, each at the peak list price and as an off-peak tier, in USD', () => {
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    expect(out.rows.map((r) => `${r.model_slug}:${r.tier ?? ''}`)).toEqual([
      'deepseek-flash:',
      'deepseek-flash:off_peak',
      'deepseek-v4-pro:',
      'deepseek-v4-pro:off_peak',
    ])
    expect(out.rows.every((r) => r.provider === 'deepseek' && r.currency === 'USD')).toBe(true)
  })

  test('cache miss is the input price, cache hit the cached-input price', () => {
    const by = Object.fromEntries(out.rows.map((r) => [`${r.model_slug}:${r.tier ?? ''}`, r]))
    expect(by['deepseek-v4-pro:']).toMatchObject({
      input_per_mtok: 1.32,
      cached_input_per_mtok: 0.044,
      output_per_mtok: 3.96,
      context_window: '1M',
      notes: 'DeepSeek-V4-Pro-0813; peak hours (the list price)',
    })
    expect(by['deepseek-v4-pro:off_peak']).toMatchObject({
      input_per_mtok: 0.66,
      cached_input_per_mtok: 0.022,
      output_per_mtok: 1.98,
    })
    expect(by['deepseek-flash:']).toMatchObject({
      input_per_mtok: 0.3,
      cached_input_per_mtok: 0.006,
      output_per_mtok: 1.2,
      notes: 'DeepSeek-V4.1-Flash-1017; peak hours (the list price)',
    })
    for (const r of out.rows) {
      expect(r.source_url).toBe('https://api-docs.deepseek.com/quick_start/pricing.md')
      expect(r.fetched_at).toBe(provenanceOf('deepseek-pricing-md').fetched_at)
    }
  })

  test('a renamed price row fails rather than reading as no price', () => {
    const text = fixtureText('fixtures/pricing/deepseek-pricing.md').replace(
      /1M OUTPUT TOKENS/g,
      '1M OUTPUT TOKENS (TEXT)',
    )
    expect(() => parseDeepseekPricingMd(text)).toThrow('expected one row')
  })
})

describe('alibaba-pricing-html', () => {
  const out = parseAlibabaPricingHtml(fixtureText('fixtures/pricing/alibaba-pricing.html'))
  const by = Object.fromEntries(out.rows.map((r) => [`${r.model_slug}:${r.tier ?? ''}`, r]))

  test('reads the three Qwen text lines in the Singapore tab, and no resold model', () => {
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    expect(out.rows.every((r) => r.provider === 'alibaba' && r.currency === 'USD')).toBe(true)
    expect(out.rows.every((r) => /^qwen/.test(r.model_slug))).toBe(true)
    for (const slug of ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen-max', 'qwen-flash']) {
      expect(by[`${slug}:`], slug).toBeDefined()
    }
    // The open-weight and specialised lines are other sections.
    expect(out.rows.some((r) => /omni|vl|coder|deepseek|kimi|glm/.test(r.model_slug))).toBe(false)
  })

  test('the international list price, not Beijing’s', () => {
    // Singapore: $2 / $6. The Beijing tab prints $1.65 / $4.951 for the same id.
    expect(by['qwen3.8-max:']).toMatchObject({ input_per_mtok: 2, output_per_mtok: 6 })
    expect(by['qwen3.8-flash:']).toMatchObject({ input_per_mtok: 0.15, output_per_mtok: 0.47 })
  })

  test('later request bands are their own tiers; a promotion is noted, never applied', () => {
    expect(by['qwen3.7-plus:']).toMatchObject({ input_per_mtok: 0.4, output_per_mtok: 1.6 })
    expect(by['qwen3.7-plus:']!.notes).toContain('Limited-time 20% off')
    expect(by['qwen3.7-plus:input_256k_1m']).toMatchObject({
      input_per_mtok: 1.2,
      output_per_mtok: 4.8,
    })
    expect(by['qwen3.7-flash:input_32k_256k']).toMatchObject({ input_per_mtok: 0.1 })
    expect(by['qwen3.7-flash:input_256k_1m']).toMatchObject({ input_per_mtok: 0.2 })
  })

  test('non-thinking output is the output price; thinking output is kept in notes', () => {
    expect(by['qwen-plus:']).toMatchObject({ input_per_mtok: 0.4, output_per_mtok: 1.2 })
    expect(by['qwen-plus:']!.notes).toContain('thinking-mode output $4')
    for (const r of out.rows) {
      expect(r.source_url).toBe('https://www.alibabacloud.com/help/en/model-studio/model-pricing')
      expect(r.fetched_at).toBe(provenanceOf('alibaba-pricing-html').fetched_at)
    }
  })

  test('a price in a shape the parser does not know fails the parse', () => {
    const text = fixtureText('fixtures/pricing/alibaba-pricing.html').replace(
      '<p>$0.15</p>',
      '<p>¥1.08</p>',
    )
    expect(() => parseAlibabaPricingHtml(text)).toThrow('does not print a USD price')
  })
})

describe('moonshot-models-md', () => {
  test('the three current ids, with no price and no context', () => {
    const out = parseMoonshotModelsMd(fixtureText('fixtures/pricing/moonshot-models.md'))
    expect(out.rows.map((r) => r.model_slug)).toEqual([
      'kimi-k3',
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
    ])
    for (const r of out.rows) {
      expect(r).toMatchObject({
        provider: 'moonshot',
        tier: null,
        context_window: null,
        input_per_mtok: null,
        cached_input_per_mtok: null,
        output_per_mtok: null,
      })
    }
  })
})

describe('deepseek-status', () => {
  const rss = fixtureText('fixtures/status/deepseek-status.xml')
  const atom = fixtureText('fixtures/status/deepseek-status-atom.xml')
  const out = parseDeepseekStatus(rss, atom)

  test('one row per incident, start from the RSS feed and end from the Atom feed, in UTC', () => {
    expect(out.rows).toHaveLength(28)
    const row = out.rows.find((r) => r.incident_id === '7202016104287')!
    expect(row).toMatchObject({
      provider: 'deepseek',
      title: 'DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）',
      impact: null,
      status: 'resolved',
      // pubDate 16:58:16 +0800; the Atom entry's updated 18:48:02+08:00.
      started_at: '2026-11-03T08:58:16Z',
      resolved_at: '2026-11-03T10:48:02Z',
      incident_url: 'https://status.deepseek.com/incidents/7202016104287',
      components: [
        'DeepSeek V4 Pro API服务(API Service)',
        'DeepSeek V4.1 Flash API服务(API Service)',
        '对话服务(Chatservice)',
      ],
    })
    expect(out.rows.every((r) => r.resolved_at !== null && r.resolved_at > r.started_at)).toBe(true)
  })

  test('an incident missing from the Atom feed fails rather than reading as open', () => {
    const cut = atom.replace(/<entry>[\s\S]*?7202016104287[\s\S]*?<\/entry>/, '')
    expect(() => parseDeepseekStatus(rss, cut)).toThrow('not in the Atom feed')
  })
})

describe('edgar-submissions-baba', () => {
  test('keeps the 20-F annual reports and drops the 6-Ks', () => {
    const whitelist = parseCikWhitelistBlock(fixtureText('sources.yaml'))
    const { rows, skipped } = parseEdgarSubmissions(
      fixtureText('fixtures/sec/edgar-submissions-baba.json'),
      whitelist,
      provenanceOf('edgar-submissions-baba'),
    )
    expect(rows.map((r) => [r.form, r.file_date])).toEqual([
      ['20-F', '2025-06-26'],
      ['20-F', '2026-05-20'],
    ])
    expect(rows.every((r) => r.whitelist_cik === '0001577552')).toBe(true)
    expect(skipped).toBe(148)
  })
})
