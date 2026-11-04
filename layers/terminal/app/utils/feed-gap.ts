// How a per-lab feed that has nothing to show says so. Three axes share the
// same three states (ok, an audited cut, registered but unparsed); the words
// for each live here once, so a gap reads the same in every table and card.

import type { GapRef } from '../types/terminal-ui'

type FeedAxis = 'hiring' | 'incidents' | 'disclosures'

const CUT: Record<FeedAxis, string> = {
  hiring: 'No public feed',
  incidents: 'No public feed',
  disclosures: 'No disclosure index',
}

const UNPARSED: Record<FeedAxis, string> = {
  hiring: 'No parsed roles yet',
  incidents: 'No parsed incidents yet',
  disclosures: 'No parsed entries yet',
}

const WHAT: Record<FeedAxis, string> = {
  hiring: 'hiring feed',
  incidents: 'status feed',
  disclosures: 'disclosure index',
}

interface FeedRow {
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  display: string
  reason?: string | null
  sources: unknown[]
}

/** The stated gap for a feed row, or null when the feed has rows to show. */
export function feedGap(axis: FeedAxis, p: FeedRow): GapRef | null {
  if (p.feed === 'ok') return null
  if (p.feed === 'no_public_feed') {
    return {
      title: CUT[axis],
      reason: p.reason ?? undefined,
      name: `Why ${p.display} has no ${WHAT[axis]}`,
    }
  }
  return {
    title: UNPARSED[axis],
    reason: p.sources.length
      ? 'We’ve fetched it but haven’t read any rows from it yet.'
      : 'Not checked yet.',
    name: `Why ${p.display} shows no rows`,
  }
}
