// First link in Nitro's error-handler chain, placed ahead of Nuxt's own by the
// `nitro:config` hook in nuxt.config.ts. It renders nothing: it only stops a
// "not found" from being logged as a server failure, then lets Nuxt's handler
// draw the error page as before.
//
// Why it exists: the dynamic pages throw `createError({ statusCode: 404, fatal:
// true })` for a slug that isn't there (/alerts/[id], /prices/[key], …). Nitro's
// defaultHandler console.errors every error marked `fatal` or `unhandled`,
// whatever its status, and Nuxt's handler calls it without `silent`. Workers
// Issues turns each console.error into an issue, and the fleet dashboard mails
// every issue as Critical, so one crawler asking for a stale permalink became a
// "[Critical] Workers issue … No such alert" email (2026-11-08 and 11-09).
// server/plugins/error-logger.ts already skips 4xx for the same reason; this
// closes the path that went around it.
//
// Clearing `fatal` on the server changes nothing a visitor sees: Nuxt rebuilds
// the error page from the status and message alone. On the client the flag is
// still set when the page throws, so client-side navigation keeps its full-page
// error. Anything 5xx keeps its flag and its log line.

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
