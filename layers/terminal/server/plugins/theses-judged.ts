// Re-evaluates the judged thesis claims after each judge run lands its verdicts
// (layers/terminal/server/pipeline/judge/submit.ts calls `judge:applied`). A hook,
// not an import, so the judge runner never depends on the theses that read it.

import { evaluateJudgedTheses } from '../theses/evaluate'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('judge:applied', evaluateJudgedTheses)
})
