// `const SCHEDULED_TASKS = { … }` out of nuxt.config.ts as data, for the
// freshness coverage test (layers/terminal/test/freshness.test.ts). crons:check
// reads the same literal its own way; both fail closed on anything but an
// object of string arrays.

import { sliceBalanced } from './brace-match'

export function readScheduledTasks(nuxtConfig: string): Record<string, string[]> {
  const declaration = /\bconst\s+SCHEDULED_TASKS\b[^=]*=\s*/.exec(nuxtConfig)
  if (!declaration) throw new Error('nuxt.config.ts has no `const SCHEDULED_TASKS = { … }`')
  const literal = sliceBalanced(nuxtConfig, declaration.index + declaration[0].length)
  if (!literal) throw new Error('SCHEDULED_TASKS is not a balanced object literal')
  const json = literal
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'/g, '"')
    .replace(/,(\s*[\]}])/g, '$1')
  const parsed: unknown = JSON.parse(json)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Object.values(parsed).every(
      (v) => Array.isArray(v) && v.every((name) => typeof name === 'string'),
    )
  ) {
    throw new Error('SCHEDULED_TASKS is not an object of string arrays')
  }
  return parsed as Record<string, string[]>
}
