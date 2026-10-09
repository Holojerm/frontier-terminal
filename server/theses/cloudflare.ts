// Thesis 2, transcribed from docs/theses/cloudflare.md — that page is the
// journal of record; this is its machine-readable half. Every signal reads a
// recipe (server/theses/recipes/); nothing here touches the lab pipeline.

import type { ThesisDef } from '#shared/utils/thesis-types'

export const CLOUDFLARE_THESIS: ThesisDef = {
  id: 'cloudflare',
  company: 'cloudflare',
  stance: 'bullish',
  statement:
    'Cloudflare compounds as the developer platform for the AI era: revenue keeps growing fast, developers keep adopting Workers, and it keeps shipping AI platform launches.',
  comparison_set: ['akamai', 'fastly'],
  horizon: '2027-12-31',
  position: 'long',
  opened: '2026-10-09',
  doc_path: 'docs/theses/cloudflare.md',
  claims: [
    {
      id: 'cloudflare-revenue-growth',
      n: 1,
      text: 'Revenue grows 25% or more a year',
      signal_label:
        'Quarterly revenue against the same quarter a year earlier (SEC filings), beside Akamai and Fastly',
      kill_condition: 'Below 25% for 2 straight quarters',
      spec: {
        kind: 'measured',
        signal: 'recipe-yoy-growth',
        recipe: 'sec-revenue-net',
        key: 'revenue',
        compare_recipes: ['sec-revenue-akam', 'sec-revenue-fsly'],
        format: 'percent',
        rule: { rule: 'below-floor-periods', floor: 0.25, periods: 2 },
      },
    },
    {
      id: 'cloudflare-developer-adoption',
      n: 2,
      text: 'Developer adoption compounds',
      signal_label: 'npm downloads of wrangler, the Workers CLI, over the trailing 28 days',
      kill_condition: 'The trailing 4 weeks fall 30% below their 26-week high',
      spec: {
        kind: 'measured',
        signal: 'recipe-trailing-sum',
        recipe: 'npm-wrangler',
        key: 'wrangler',
        days: 28,
        format: 'count',
        rule: { rule: 'drawdown-from-high', drop: 0.3, days: 182, min_days: 30 },
      },
    },
    {
      id: 'cloudflare-hiring-scale',
      n: 3,
      text: 'Hiring scales in engineering and sales',
      signal_label:
        'Open roles in Engineering, Infrastructure, Production Engineering, Field Sales, Sales, Mid Market, BDR and Solution Engineering',
      kill_condition: 'Those roles fall 25% or more from their 90-day high',
      spec: {
        kind: 'measured',
        signal: 'recipe-sum-of-keys',
        recipe: 'greenhouse-cloudflare',
        keys: [
          'Engineering',
          'Infrastructure',
          'Production Engineering',
          'Field Sales',
          'Sales',
          'Mid Market',
          'BDR',
          'Solution Engineering',
        ],
        format: 'count',
        rule: { rule: 'drawdown-from-high', drop: 0.25, days: 90, min_days: 30 },
      },
    },
    {
      id: 'cloudflare-ai-launches',
      n: 4,
      text: 'It keeps shipping AI platform launches',
      signal_label: 'Each Workers AI or Agents changelog entry, rated a major launch or minor',
      kill_condition: 'No major launch in 90 days',
      spec: {
        kind: 'judged',
        review: 'recipe-items',
        recipe: 'cloudflare-changelog-ai',
        verdicts: ['major', 'minor'],
        judged_from: '2026-10-09',
        rule: { rule: 'recent-verdict', verdict: 'major', days: 90 },
        rubric:
          'major: the entry announces a new product, a new capability that is generally available, a new model family, or a new major version of an SDK or API. ' +
          'minor: a fix, a small option, a single model added to an existing catalog, a limit or price change, a deprecation, or documentation. ' +
          'Rate from the entry title and summary only; when they cannot tell, rate minor.',
      },
    },
  ],
}
