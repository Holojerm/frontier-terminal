// Sample data for every email — what `bun run email:dev` and `bun run
// email:preview` fill the templates with, and what test/emails.test.ts renders
// to prove every template compiles, fills in and escapes. One entry per file in
// emails/templates/; the test fails when the two lists disagree.
//
// Plain data, no imports: it runs in Bun (the dev server) and in workerd (the
// test suite), which share nothing else.

export type EmailSample = Record<string, unknown>

const brand = { appName: 'My App', appUrl: 'https://my-app.example' }

export const SAMPLES: Record<string, EmailSample> = {
  'thesis-digest': {
    ...brand,
    summary: 'Anthropic: 3 holding, 1 weakening, 1 unresolved · 1 claim moved',
    generated: 'Oct 12, 13:00 UTC',
    thesesUrl: `${brand.appUrl}/api/theses`,
    quiet: false,
    owner: false,
    unsubscribeUrl: `${brand.appUrl}/subscribe/unsubscribe?u=sample`,
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
  'subscribe-confirm': {
    ...brand,
    confirmUrl: `${brand.appUrl}/subscribe/confirm?t=sample`,
  },
}
