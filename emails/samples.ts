// Sample data for every email — what `bun run email:dev` and `bun run
// email:preview` fill the templates with, and what test/emails.test.ts renders
// to prove every template compiles, fills in and escapes. One entry per file in
// emails/templates/; the test fails when the two lists disagree.
//
// Plain data, no imports: it runs in Bun (the dev server) and in workerd (the
// test suite), which share nothing else.

export type EmailSample = Record<string, unknown>

const brand = { appName: 'My App', appUrl: 'https://my-app.example' }
const rows = (kind: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: `Oct 4, 20:0${i} UTC`,
    path: `/api/${kind}/${i}`,
    pathUrl: `${brand.appUrl}/api/${kind}/${i}`,
    detail: i === 0 ? 'D1_ERROR: no such table: widgets' : null,
  }))

export const SAMPLES: Record<string, EmailSample> = {
  'ops-digest': {
    ...brand,
    summary: '9 new events since Oct 4, 20:00 UTC',
    generated: 'Oct 4, 21:30 UTC',
    logsUrl:
      'https://dash.cloudflare.com/?to=/:account/workers/services/view/my-app/production/observability',
    kinds: [
      {
        kind: 'server_error',
        label: 'Server error',
        count: 7,
        bad: true,
        rows: rows('server_error', 5),
        more: 2,
      },
      {
        kind: 'source_fetch_failed',
        label: 'Source fetch failed',
        count: 1,
        warn: true,
        rows: [{ time: 'Oct 4, 20:05 UTC', path: null, pathUrl: null, detail: 'bad signature' }],
        more: 0,
      },
      {
        kind: 'cron_recovered',
        label: 'Cron recovered',
        count: 1,
        good: true,
        rows: [
          {
            time: 'Oct 4, 20:09 UTC',
            path: '/_nitro/tasks/ops/alert',
            pathUrl: null,
            detail: null,
          },
        ],
        more: 0,
      },
    ],
  },
  'thesis-digest': {
    ...brand,
    summary: 'Anthropic: 3 holding, 1 weakening, 1 unresolved · 1 claim moved',
    generated: 'Oct 12, 13:00 UTC',
    thesesUrl: `${brand.appUrl}/api/theses`,
    quiet: false,
    theses: [
      {
        name: 'Anthropic (bullish)',
        statement:
          'Anthropic becomes the premium lab for developers and enterprises, and earns it in price, demand and hiring.',
        claims: [
          {
            n: 3,
            text: 'Rivals do not force a price war on the premium tier',
            status: 'weakening',
            warn: true,
            moved: 'holding',
            reason:
              '1 of 2 competitive rival cuts in 90 days (OpenAI gpt-6-sol −40%); Anthropic has not matched.',
            week: null,
          },
          {
            n: 5,
            text: 'Safety is an asset, not a liability',
            status: 'unresolved',
            idle: true,
            moved: null,
            reason: 'Awaiting the first judge run that covers this claim.',
            week: null,
          },
          {
            n: 1,
            text: 'Anthropic earns more per token than its rivals',
            status: 'holding',
            good: true,
            moved: null,
            reason: "1.87× against a floor of 1.30× and OpenAI's 0.84×.",
            week: '1.81× → 1.87×',
          },
        ],
        verdicts: [
          {
            n: 3,
            against: true,
            provider: 'OpenAI',
            verdict: 'competitive',
            event: 'gpt-6-sol −40%',
            url: 'https://developers.openai.com/api/docs/pricing.md',
            rationale: 'gpt-6-sol is still the flagship and no newer model appears in the records.',
          },
        ],
        gaps: [],
        awaiting: [],
      },
    ],
  },
}
