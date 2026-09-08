// Things that must be true of every log line this app writes.
//
// A leaf on purpose — no imports — so anything can pull it in, including the
// Nitro error plugin that runs before most of the app exists.

/**
 * A request path with the query string and fragment removed, for logging.
 *
 * A query string is where a caller puts the things a log should not keep — a
 * token, a signed parameter, a search term — and a 5xx is exactly the moment a
 * request gets logged in full. A path with no query is still the whole
 * diagnostic value of the field (nobody debugs a 500 from a query string), so
 * there is nothing to trade off.
 *
 * Returns `undefined` for a missing path so callers can pass it straight
 * through to a JSON payload.
 */
export function pathForLog(path: string | undefined): string | undefined {
  if (!path) return undefined
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}
