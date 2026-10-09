// Thesis 1, transcribed from docs/theses/anthropic.md — that page is the
// journal of record; this is its machine-readable half. A threshold changed
// here is a thesis revision: change the page's Revisions table in the same commit.

import type { ThesisDef } from '#shared/utils/thesis-types'

export const ANTHROPIC_THESIS: ThesisDef = {
  id: 'anthropic',
  company: 'anthropic',
  stance: 'bullish',
  statement:
    'Anthropic becomes the premium lab for developers and enterprises, and earns it in price, demand and hiring.',
  comparison_set: ['openai', 'google', 'xai'],
  horizon: "Until Anthropic's public S-1, or 2027-06-30 if none",
  position: 'none',
  opened: '2026-10-08',
  doc_path: 'docs/theses/anthropic.md',
  claims: [
    {
      id: 'anthropic-spend-premium',
      n: 1,
      text: 'Anthropic earns more per token than its rivals',
      signal_label: 'OpenRouter spend share ÷ token share, among the four labs',
      kill_condition: "Below 1.3×, or below OpenAI's ratio, for 4 straight weeks",
      spec: {
        kind: 'measured',
        signal: 'openrouter-spend-premium',
        rule: { rule: 'sustained-floor', floor: 1.3, comparator: 'openai', weeks: 4 },
      },
    },
    {
      id: 'anthropic-demand-growth',
      n: 2,
      text: 'Developer demand is growing, not only price',
      signal_label: "Anthropic's share of the four labs' OpenRouter tokens, trailing 7 days",
      kill_condition: 'More than 5 points below its trailing 13-week average',
      spec: {
        kind: 'measured',
        signal: 'openrouter-lab-token-share',
        rule: { rule: 'below-trailing-average', margin: 0.05, weeks: 13, min_weeks: 4 },
      },
    },
    {
      id: 'anthropic-rival-price-war',
      n: 3,
      text: 'Rivals do not force a price war on the premium tier',
      signal_label:
        'Each rival flagship price cut, rated a generational step-down or a competitive cut',
      kill_condition:
        'Two competitive cuts of 30% or more on rival flagships within 90 days, and Anthropic matches one',
      spec: {
        kind: 'judged',
        review: 'flagship-price-cuts',
        judged_from: '2026-10-09',
        rule: { rule: 'competitive-cuts', min_cut: 0.3, count: 2, days: 90 },
        rubric:
          'competitive: the cut lands on the model the vendor still recommends as its flagship, and nothing in the records shows a newer model from that vendor replacing it, so it is a price move against rivals. ' +
          'generational: the records show a newer model from the same vendor arriving with or before the cut, so the old model is being stepped down. ' +
          'When the records cannot tell the two apart, rate generational: a price war needs evidence.',
      },
    },
    {
      id: 'anthropic-hiring-scale',
      n: 4,
      text: 'Hiring scales where revenue and compute come from',
      signal_label: 'Open roles in Sales, Applied AI, Infrastructure and Compute',
      kill_condition: 'Those roles fall 25% or more from their 90-day high',
      spec: {
        kind: 'measured',
        signal: 'open-roles-in-departments',
        departments: ['Sales', 'Applied AI', 'Software Engineering - Infrastructure', 'Compute'],
        rule: { rule: 'drawdown-from-high', drop: 0.25, days: 90, min_days: 30 },
      },
    },
    {
      id: 'anthropic-safety-asset',
      n: 5,
      text: 'Safety is an asset, not a liability',
      signal_label:
        "Anthropic incidents and misalignment disclosures, rated against a severity rubric, beside rivals'",
      kill_condition:
        'The judge rates an event material and Jeremy confirms: a multi-hour flagship API outage, or a disclosure Anthropic calls high severity',
      spec: {
        kind: 'judged',
        review: 'incidents-and-disclosures',
        judged_from: '2026-10-09',
        rule: { rule: 'confirmed-material', impacts: ['major', 'critical', 'high'], min_hours: 2 },
        rubric:
          'material: the incident title or components show it hit the vendor API or a flagship model, not only a consumer app, console, dashboard or billing; or the disclosure record itself labels the event high severity. ' +
          'not-material: everything else. The Worker has already checked the impact (major, critical or high) and the duration (two hours or more).',
        confirmations: [],
      },
    },
  ],
}
