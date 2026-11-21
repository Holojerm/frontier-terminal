// First link in Nitro's error-handler chain, placed ahead of Nuxt's by the
// `nitro:config` hook in nuxt.config.ts. It renders nothing: it stops a "not
// found" from being logged as a server failure, then lets Nuxt's handler draw
// the error page.
//
// The dynamic pages throw `createError({ statusCode: 404, fatal: true })` for
// a missing slug (/alerts/[id], /prices/[key], …). Nitro's defaultHandler
// console.errors every error marked `fatal` or `unhandled`, whatever its
// status, and Nuxt's handler calls it without `silent`. Workers Issues turns
// each console.error into an issue, which the fleet dashboard mails as
// Critical, so one crawler asking for a stale permalink sent a Critical email.
// server/plugins/error-logger.ts already skips 4xx; this closes the path
// around it.
//
// Clearing `fatal` on the server changes nothing a visitor sees: Nuxt rebuilds
// the error page from the status and message alone. On the client the flag is
// still set, so client-side navigation keeps its full-page error. Anything 5xx
// keeps its flag and its log line.

import type { NitroErrorHandler } from 'nitropack/types'

export function quietClientError(error: { statusCode?: number; fatal?: boolean }): void {
  const status = error.statusCode ?? 500
  if (status < 500 && error.fatal) error.fatal = false
}

const handler: NitroErrorHandler = (error) => {
  quietClientError(error)
  // Not handled: leave event.handled unset so the chain moves on to Nuxt's.
}

export default handler
