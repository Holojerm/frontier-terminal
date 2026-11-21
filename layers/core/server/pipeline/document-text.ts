// A stored document as the judge reads it, and the containment check every
// quote it sends back must pass. Shared by the readers that hand the judge a
// filing or a page: the suppliers', the power sites'.

import { comparable, pageText } from '../utils/quote-match'

const fold = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The document as a reader sees it, whitespace folded. */
export const documentText = (html: string): string => fold(pageText(html))

/** Whether `needle` is in `haystack` as a reader would compare them (see comparable). */
export const contains = (haystack: string, needle: string): boolean =>
  comparable(haystack).toLowerCase().includes(comparable(needle).toLowerCase())
