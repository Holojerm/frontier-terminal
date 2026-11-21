// The eras of each lab's status feed, as the Internet Archive holds them:
// which feed URL, over which window, read by which parser. Windows are
// half-open [from, until) and never overlap within a lab. Every era ends by
// the day the live status lane began reading that lab's feed
// (STATUS_LIVE_FROM): from then on entities holds the record.
//
// robots.txt still applies to a copy. A URL the live site's robots.txt
// disallows is never read from the Archive either: status.claude.com and
// status.x.ai disallow /api/, so Anthropic is read from history.atom only,
// and no lab's /api/ copy is read at all. How each window was found, and
// each site's robots.txt: docs/source-audit.md › "Addendum, 2026-11-21:
// Internet Archive (status-page incidents)". Stretches no copy covers are in
// STATUS_ARCHIVE_GAPS.

import type { LabId } from '../../../shared/utils/terminal-types'
import {
  googleCloudArchived,
  incidentioRssArchived,
  statuspageAtomArchived,
  xaiArchived,
  type ArchivedStatusParser,
} from '../parsers/status/wayback-status'
import { ARCHIVE_FROM } from '#layers/core/server/utils/archive-floor'

export type StatusArchiveProvider = Extract<
  LabId,
  'openai' | 'anthropic' | 'google' | 'deepseek' | 'xai'
>

/** The first poll of each live status lane (source_runs, production). */
export const STATUS_LIVE_FROM: Readonly<Record<StatusArchiveProvider | 'mistral', string>> = {
  openai: '2026-09-09T00:00:00.000Z',
  anthropic: '2026-09-09T00:00:00.000Z',
  google: '2026-09-09T00:00:00.000Z',
  mistral: '2026-11-02T00:00:00.000Z',
  deepseek: '2026-11-05T00:00:00.000Z',
  xai: '2026-11-05T00:00:00.000Z',
}

/**
 * When status.openai.com moved from Statuspage to incident.io. incident.io
 * copied the old history in at 10:40 UTC that day under new ids; ids minted
 * before this instant are those copies and are read from Statuspage instead.
 */
export const OPENAI_INCIDENTIO_FROM = '2025-02-25T10:45:00.000Z'

export interface StatusEra {
  id: string
  provider: StatusArchiveProvider
  /** The feed as the lab published it; the CDX key. */
  url: string
  from: string
  until: string
  /** What the feed looked like, for the audit. */
  shape: string
  parse: ArchivedStatusParser
  /** One copy per this many days. A feed that lists only its newest 25 needs every copy. */
  cadenceDays: number
  ext: 'xml' | 'json'
  /** What the end of a whole copy carries: a cut-short feed would read as fewer incidents. */
  end?: RegExp
}

// Statuspage printed each update in the page's own zone before the labs set them to UTC.
const PACIFIC = { UTC: 0, PDT: -420, PST: -480 }
const CHINA = { UTC: 0, CST: 480 }
const ATOM_END = /<\/feed>\s*$/
const RSS_END = /<\/rss>\s*$/

export const STATUS_ARCHIVE_ERAS: readonly StatusEra[] = [
  {
    id: 'openai-history-atom-2023',
    provider: 'openai',
    url: 'https://status.openai.com/history.atom',
    from: ARCHIVE_FROM,
    until: OPENAI_INCIDENTIO_FROM,
    shape:
      'Statuspage history.atom: the newest 25 incidents and maintenances, each update stamped in Pacific time',
    parse: statuspageAtomArchived('openai', PACIFIC),
    cadenceDays: 1,
    ext: 'xml',
    end: ATOM_END,
  },
  {
    id: 'openai-feed-rss-2025',
    provider: 'openai',
    url: 'https://status.openai.com/feed.rss',
    from: OPENAI_INCIDENTIO_FROM,
    until: STATUS_LIVE_FROM.openai,
    shape:
      'incident.io feed.rss: one item per incident with its ULID, newest status, components and newest update',
    parse: incidentioRssArchived('openai', OPENAI_INCIDENTIO_FROM),
    cadenceDays: 1,
    ext: 'xml',
    end: RSS_END,
  },
  {
    id: 'anthropic-history-atom-2023',
    provider: 'anthropic',
    url: 'https://status.anthropic.com/history.atom',
    from: ARCHIVE_FROM,
    until: '2025-09-23T00:00:00.000Z',
    shape: 'Statuspage history.atom on status.anthropic.com: the newest 25 entries',
    parse: statuspageAtomArchived('anthropic', PACIFIC),
    cadenceDays: 1,
    ext: 'xml',
    end: ATOM_END,
  },
  {
    id: 'anthropic-claude-history-atom-2025',
    provider: 'anthropic',
    url: 'https://status.claude.com/history.atom',
    from: '2025-09-23T00:00:00.000Z',
    until: STATUS_LIVE_FROM.anthropic,
    shape:
      'Statuspage history.atom on status.claude.com, the feed the live lane reads, with the same incident codes',
    parse: statuspageAtomArchived('anthropic', PACIFIC),
    cadenceDays: 1,
    ext: 'xml',
    end: ATOM_END,
  },
  {
    id: 'google-cloud-incidents-2023',
    provider: 'google',
    url: 'https://status.cloud.google.com/incidents.json',
    from: '2023-12-01T00:00:00.000Z',
    until: STATUS_LIVE_FROM.google,
    shape:
      'Google Cloud incidents.json, the feed the live lane reads: every product’s incidents over roughly the year before the copy',
    parse: googleCloudArchived,
    cadenceDays: 30,
    ext: 'json',
  },
  {
    id: 'deepseek-history-atom-2024',
    provider: 'deepseek',
    url: 'https://status.deepseek.com/history.atom',
    from: ARCHIVE_FROM,
    until: '2026-07-01T00:00:00.000Z',
    shape:
      'Statuspage history.atom, before DeepSeek moved its page to Flashduty: the newest 25 entries, stamped in China time',
    parse: statuspageAtomArchived('deepseek', CHINA),
    cadenceDays: 1,
    ext: 'xml',
    end: ATOM_END,
  },
  {
    id: 'xai-feed-2025',
    provider: 'xai',
    url: 'https://status.x.ai/feed.xml',
    from: ARCHIVE_FROM,
    until: STATUS_LIVE_FROM.xai,
    shape: 'feed.xml, the feed the live lane reads: one item per component per incident',
    parse: xaiArchived,
    cadenceDays: 1,
    ext: 'xml',
    end: RSS_END,
  },
]

/** Stretches no archived copy covers, and why. Printed on /incidents and in the audit. */
export const STATUS_ARCHIVE_GAPS: readonly {
  provider: StatusArchiveProvider
  from: string
  until: string
  reason: string
}[] = [
  {
    provider: 'openai',
    from: '2025-02-19',
    until: '2025-02-26',
    reason:
      'OpenAI moved its status page from Statuspage to incident.io in February 2025. The Archive’s last copy of the old feed is from 2025-02-19, and the new feed lists the incidents before the move under ids minted at the move, which we don’t read.',
  },
  {
    provider: 'openai',
    from: '2026-06-17',
    until: '2026-09-09',
    reason: 'The Archive has no copy of feed.rss from 2026-06-17 to our first read on 2026-09-09.',
  },
  {
    provider: 'anthropic',
    from: '2023-01-01',
    until: '2023-03-16',
    reason:
      'The Archive’s first copy of status.anthropic.com/history.atom is from 2023-10-30, and its oldest entry started on 2023-03-16.',
  },
  {
    provider: 'anthropic',
    from: '2024-05-04',
    until: '2024-06-21',
    reason:
      'No copy between 2024-05-04 and 2024-08-07, and the August copy’s 25 entries reach back only to 2024-06-21.',
  },
  {
    provider: 'deepseek',
    from: '2023-01-01',
    until: '2024-05-10',
    reason:
      'The Archive’s first copy of DeepSeek’s status feed is from 2024-06-19, and its oldest entry started on 2024-05-10.',
  },
  {
    provider: 'deepseek',
    from: '2026-05-06',
    until: '2026-11-05',
    reason:
      'DeepSeek moved its status page from Statuspage to Flashduty in mid-2026. The Archive’s last copy of the old feed is from 2026-05-06, and it has one copy of the new one (2026-10-04), whose RSS prints no end; our own record starts from 2026-08-04.',
  },
  {
    provider: 'xai',
    from: '2023-01-01',
    until: '2025-01-15',
    reason:
      'The Archive’s first copy of status.x.ai/feed.xml is from 2025-01-21, and its oldest item started on 2025-01-15.',
  },
  {
    provider: 'google',
    from: '2026-08-12',
    until: '2026-09-09',
    reason:
      'The Archive’s last copy of incidents.json before our first read is from 2026-08-12. Before then the copies each reach about a year back, so every month from 2023 on is covered.',
  },
]

/** Live status feeds with no archived history we read, and why. */
export const STATUS_ARCHIVE_NOT_COVERED: readonly { provider: LabId; reason: string }[] = [
  {
    provider: 'mistral',
    reason:
      'The Archive holds no copy of status.mistral.ai’s incident feed or its history.atom. Its one copy of the site’s robots.txt (2026-04-19) disallows /api/, so its incidents.json would be off limits anyway.',
  },
]

export function statusEraById(id: string): StatusEra | null {
  return STATUS_ARCHIVE_ERAS.find((e) => e.id === id) ?? null
}
