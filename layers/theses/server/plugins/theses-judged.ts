// Re-evaluates the judged thesis claims once a judge run lands its verdicts
// (layers/core/server/pipeline/judge/submit.ts calls `judge:applied`). A hook
// keeps the judge runner from depending on the theses that read it.

import { evaluateJudgedTheses } from '../theses/evaluate'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('judge:applied', evaluateJudgedTheses)
})
