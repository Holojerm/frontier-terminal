// The eras of each lab's job board, as the Internet Archive holds them:
// which board the lab posted its open roles on, over which window, and which
// parser reads that shape. Unlike the pricing eras, two eras of one lab may
// overlap: a board's API and its HTML page are two copies of one listing,
// and each capture is an observation of it at its own instant. The count at
// an instant is the newest parsed capture at or before it, whichever era it
// came from. Every era ends at the day the live lane began reading the lab's
// board (HIRING_ARCHIVE_UNTIL): from then on the live pipeline is the record.
//
// How each window was found: the CDX listing of each candidate URL, cut
// where the lab moved its board (docs/source-audit.md › Internet Archive ›
// Hiring). Stretches with no readable capture are stated with their reason:
// the fixed ones in HIRING_ARCHIVE_GAPS, and any other stretch of more than
// HIRING_GAP_DAYS between two read captures, computed on the read side
// (terminal-archive.ts › queryHiringReach).

import {
  parseAshbyBoardHtml,
  parseGreenhouseBoardHtml,
  parseGreenhouseDepartmentsJson,
  parseGreenhouseJobBoardsHtml,
  parseGreenhouseJobsJson,
  parseLeverBoardHtml,
  type ArchivedBoardCount,
} from '../parsers/hiring/wayback-boards'
import { ARCHIVE_FROM } from './eras'

export type HiringArchiveProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'mistral'

/** The day the live lane first read each lab's board (sources.yaml, docs/source-audit.md). */
export const HIRING_ARCHIVE_UNTIL: Readonly<Record<HiringArchiveProvider, string>> = {
  openai: '2026-08-25T00:00:00.000Z',
  anthropic: '2026-08-25T00:00:00.000Z',
  xai: '2026-08-25T00:00:00.000Z',
  // The live Mistral board (mistral-ashby) shipped 2026-11-01, Google's
  // (google-careers, DeepMind roles) 2026-11-04.
  mistral: '2026-11-01T00:00:00.000Z',
  google: '2026-11-04T00:00:00.000Z',
}

/** A stretch between two read captures longer than this is a stated gap. */
export const HIRING_GAP_DAYS = 45

export interface HiringEra {
  id: string
  provider: HiringArchiveProvider
  /** The board as the lab published it; the CDX key. */
  url: string
  from: string
  until: string
  /** What the capture looks like, for the audit and the reach panel. */
  shape: string
  parse: (text: string) => ArchivedBoardCount
}

const until = (p: HiringArchiveProvider) => HIRING_ARCHIVE_UNTIL[p]

export const HIRING_ARCHIVE_ERAS: readonly HiringEra[] = [
  {
    id: 'openai-greenhouse-2023',
    provider: 'openai',
    url: 'https://boards.greenhouse.io/openai',
    from: ARCHIVE_FROM,
    until: '2024-03-14T00:00:00.000Z',
    shape: 'boards.greenhouse.io/openai: every opening on one page, grouped by department',
    parse: parseGreenhouseBoardHtml,
  },
  {
    id: 'openai-ashby-2024',
    provider: 'openai',
    url: 'https://jobs.ashbyhq.com/openai',
    from: '2024-03-14T00:00:00.000Z',
    until: until('openai'),
    shape:
      'jobs.ashbyhq.com/openai: every listed posting in the page’s app data, with its department',
    parse: parseAshbyBoardHtml,
  },
  {
    id: 'anthropic-lever-2023',
    provider: 'anthropic',
    url: 'https://jobs.lever.co/Anthropic',
    from: ARCHIVE_FROM,
    until: '2024-05-14T00:00:00.000Z',
    shape: 'jobs.lever.co/Anthropic: every posting on one page, grouped by top-level category',
    parse: parseLeverBoardHtml,
  },
  {
    id: 'anthropic-greenhouse-2024',
    provider: 'anthropic',
    url: 'https://boards.greenhouse.io/anthropic',
    from: '2024-05-14T00:00:00.000Z',
    until: '2025-03-20T00:00:00.000Z',
    shape: 'boards.greenhouse.io/anthropic: every opening on one page, grouped by department',
    parse: parseGreenhouseBoardHtml,
  },
  {
    id: 'anthropic-departments-api',
    provider: 'anthropic',
    url: 'https://boards-api.greenhouse.io/v1/boards/anthropic/departments',
    from: '2024-06-01T00:00:00.000Z',
    until: until('anthropic'),
    shape:
      'the board API’s /departments: every job under its department, the join the live lane reads',
    parse: parseGreenhouseDepartmentsJson,
  },
  {
    id: 'anthropic-job-boards-2025',
    provider: 'anthropic',
    url: 'https://job-boards.greenhouse.io/anthropic',
    from: '2025-03-20T00:00:00.000Z',
    until: until('anthropic'),
    shape: 'job-boards.greenhouse.io/anthropic: 50 roles a page and the board’s own total',
    parse: parseGreenhouseJobBoardsHtml,
  },
  {
    id: 'xai-greenhouse-2023',
    provider: 'xai',
    url: 'https://boards.greenhouse.io/xai',
    from: '2023-11-01T00:00:00.000Z',
    until: '2025-03-04T00:00:00.000Z',
    shape:
      'boards.greenhouse.io/xai: every opening on one page, grouped by department and sub-department',
    parse: parseGreenhouseBoardHtml,
  },
  {
    id: 'xai-jobs-api-2023',
    provider: 'xai',
    url: 'https://boards-api.greenhouse.io/v1/boards/xai/jobs',
    from: '2023-11-01T00:00:00.000Z',
    until: '2025-03-04T00:00:00.000Z',
    shape: 'the board API’s /jobs: every job, no department',
    parse: parseGreenhouseJobsJson,
  },
  {
    id: 'xai-job-boards-2025',
    provider: 'xai',
    url: 'https://job-boards.greenhouse.io/xai',
    from: '2025-03-04T00:00:00.000Z',
    until: until('xai'),
    shape: 'job-boards.greenhouse.io/xai: 50 roles a page and the board’s own total',
    parse: parseGreenhouseJobBoardsHtml,
  },
  {
    id: 'mistral-lever-2023',
    provider: 'mistral',
    url: 'https://jobs.lever.co/mistral',
    from: ARCHIVE_FROM,
    until: '2026-07-12T00:00:00.000Z',
    shape: 'jobs.lever.co/mistral: every posting on one page, grouped by top-level category',
    parse: parseLeverBoardHtml,
  },
  {
    id: 'mistral-ashby-2026',
    provider: 'mistral',
    url: 'https://jobs.ashbyhq.com/mistral.ai',
    from: '2026-07-12T00:00:00.000Z',
    until: until('mistral'),
    shape: 'jobs.ashbyhq.com/mistral.ai: every listed posting in the page’s app data',
    parse: parseAshbyBoardHtml,
  },
  {
    id: 'deepmind-greenhouse-2023',
    provider: 'google',
    url: 'https://boards.greenhouse.io/deepmind',
    from: ARCHIVE_FROM,
    until: '2025-03-31T00:00:00.000Z',
    shape: 'boards.greenhouse.io/deepmind: every opening on one page, grouped by department',
    parse: parseGreenhouseBoardHtml,
  },
  {
    id: 'deepmind-job-boards-2025',
    provider: 'google',
    url: 'https://job-boards.greenhouse.io/deepmind',
    from: '2025-03-31T00:00:00.000Z',
    until: '2026-02-01T00:00:00.000Z',
    shape:
      'job-boards.greenhouse.io/deepmind: 50 roles a page and the board’s own total, every role with its department when one page holds them',
    parse: parseGreenhouseJobBoardsHtml,
  },
]

/** Stretches with no readable archived board, and why. Printed on /hiring, /data and in the audit. */
export const HIRING_ARCHIVE_GAPS: readonly {
  provider: HiringArchiveProvider
  from: string
  until: string
  reason: string
}[] = [
  {
    provider: 'xai',
    from: '2023-01-01',
    until: '2023-11-05',
    reason:
      'xAI announced itself in July 2023. The Archive’s first copy of its board is from November 2023.',
  },
  {
    provider: 'mistral',
    from: '2023-01-01',
    until: '2023-09-27',
    reason:
      'Mistral was founded in April 2023. The Archive’s first copy of its Lever board is from September 2023.',
  },
  {
    provider: 'google',
    from: '2026-02-01',
    until: '2026-11-04',
    reason:
      'From early 2026 deepmind.google/careers also sends applicants to Google’s careers site (company=DeepMind), the listing we read live. From then the Greenhouse board holds only part of DeepMind’s roles (9 on 2026-08-30), so we stop reading it.',
  },
]

/** What travels with a lab's archived points: where the archived board differs from the live one. */
export const HIRING_ARCHIVE_CAVEATS: Readonly<Partial<Record<HiringArchiveProvider, string>>> = {
  google:
    'These copies are DeepMind’s own Greenhouse board, the one deepmind.google linked to until early 2026. We read Google’s careers feed (its DeepMind roles) live. That’s a different listing, so the two series don’t join.',
  xai: 'The board API’s copies through February 2025 name xAI as the company on every role. After the 2025 merger the board mixes SpaceX and xAI roles (see the board’s caveat), and the copies from 2025 on don’t say which is which.',
  anthropic:
    'Until spring 2024 Anthropic posted its roles on Lever, under other department names. Then it moved to Greenhouse, the board we read live.',
  openai:
    'Until March 2024 OpenAI posted its roles on Greenhouse, under other department names. Then it moved to Ashby, the board we read live.',
  mistral:
    'Until July 2026 Mistral posted its roles on Lever. Most of its categories there are the department names its Ashby board (the one we read live) uses.',
}

/** Labs whose archived boards are not read, and why. */
export const HIRING_ARCHIVE_NOT_COVERED: readonly { provider: string; reason: string }[] = [
  {
    provider: 'meta',
    reason:
      'Meta posts its roles on metacareers.com, which draws its listing with scripts and has no public board API. Meta’s AI roles aren’t separable from the rest of the company there either.',
  },
]

/**
 * Archived department ids that are today's live departments, by the board's
 * own id: a Greenhouse department keeps its id when the lab renames it
 * ("Communications & Marketing", then "Communications & Brand", then
 * "Communications", all 4002047008), and an Ashby department is the root
 * team whose id the posting carried. A row whose id is here is filed under
 * the live label; every other row keeps the label it printed. The original
 * label always ships beside it (archived_hiring.label). Live labels are the
 * boards' /departments as the live lane reads them
 * (fixtures/hiring/*-greenhouse-departments.json).
 */
export const HIRING_DEPARTMENT_IDS: Readonly<
  Partial<Record<HiringArchiveProvider, Readonly<Record<string, string>>>>
> = {
  anthropic: {
    '4002061008': 'AI Research & Engineering',
    '4079949008': 'Applied AI',
    '4002047008': 'Communications',
    '4050632008': 'Compute',
    '4010154008': 'Data Science & Analytics',
    '4050633008': 'Engineering & Design - Product',
    '4002052008': 'Finance',
    '4090681008': 'Hardware',
    '4002054008': 'Legal',
    '4048023008': 'Marketing & Brand',
    '4002055008': 'People',
    '4002057008': 'Product Management, Support, & Operations',
    '4078392008': 'Public Benefit',
    '4002056008': 'Public Policy',
    '4002065008': 'Safeguards (Trust & Safety)',
    '4002062008': 'Sales',
    '4002063008': 'Security',
    '4019632008': 'Software Engineering - Infrastructure',
    '4086263008': 'Technical Education',
    '4050634008': 'Technical Program Management',
  },
  // OpenAI: only the ids whose archived labels differ from today's. The
  // UUIDs are Ashby departments renamed in place ("Model Deployment for
  // Business", then "Forward Deployed Engineering"). The numeric ids are
  // OpenAI's 2023 Greenhouse departments, tied to the Ashby department that
  // records them as its importedId ("Go-to-Market", 4019741004).
  openai: {
    '4013608004': 'Finance',
    '4014375004': 'Global Affairs',
    '4019741004': 'Go To Market',
    '4050087004': 'Safety Systems',
    '4051531004': 'Research',
    '4055987004': 'Executive Operations',
    '4072147004': 'Scaling',
    '923a141e-ff07-478e-9039-1d4fdbd65588': 'Forward Deployed Engineering',
    'eff48121-06cf-4eb6-84c1-681413e2dc4e': 'XYZ - Consumer Devices | Restricted',
  },
  xai: {
    '4042930007': 'Data Center',
    '4024733007': 'Engineering',
    '4046282007': 'Finance',
    '4025087007': 'Human Data',
    '4046295007': 'Information Security',
    '4047058007': 'Information Technology',
    '4052172007': 'Infrastructure',
    '4046281007': 'Legal',
    '4043619007': 'People',
    '4046294007': 'Product',
    '4065610007': 'Safety',
    '4059410007': 'Sales',
    '4046310007': 'Security',
  },
}

/** The live department a counted label files under: by the board's id, else the label itself. */
export function liveDepartment(
  provider: string,
  departmentId: string | null,
  label: string,
): string {
  const ids = HIRING_DEPARTMENT_IDS[provider as HiringArchiveProvider]
  return (departmentId !== null && ids?.[departmentId]) || label
}

export function hiringEraById(id: string): HiringEra | null {
  return HIRING_ARCHIVE_ERAS.find((e) => e.id === id) ?? null
}
