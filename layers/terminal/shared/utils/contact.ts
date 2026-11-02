// The one address a reader can write to.
//
// A Cloudflare Email Routing alias on the site's own domain rather than a
// personal inbox: the address printed on every page outlives whichever
// mailbox it forwards to, and changing that mailbox is a routing rule, not a
// deploy. Fixed rather than derived from appUrl, which is localhost in dev.

export const CONTACT_EMAIL = 'contact@frontierterm.com'

/**
 * A mailto link with the subject filled in, so a buyer's message is sortable
 * from a correction or a press request before anyone opens it.
 */
export function mailto(subject: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`
}
