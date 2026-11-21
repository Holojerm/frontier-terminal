// What scripts/release-notes.ts writes to release-notes.json, and how: kept
// apart from the script so the test can rebuild the file from the fixtures
// and compare.

import { RELEASE_NOTE_SOURCES, type ReleaseNote } from './release-notes'

/** Where each lab's release-notes page is committed. */
export const RELEASE_NOTE_FIXTURES: Readonly<Record<string, string>> = {
  openai: 'fixtures/release-notes/openai-changelog.md',
  anthropic: 'fixtures/release-notes/anthropic-release-notes.md',
  google: 'fixtures/release-notes/gemini-release-notes.md',
  xai: 'fixtures/release-notes/xai-release-notes.md',
  deepseek: 'fixtures/release-notes/deepseek-news.html',
}

/**
 * Labs whose notes date every release from their first note on. xAI's give
 * a month for most items, so it has none: an xAI event without a dated note
 * keeps its capture window.
 */
const DAY_PRECISE = new Set(['openai', 'anthropic', 'google', 'deepseek'])

export interface ReleaseNotesFile {
  /** The first day each lab's notes date, from which an archived event needs one. */
  coverage: Record<string, string>
  notes: ReleaseNote[]
}

export function releaseNotesFile(pages: Record<string, string>, until: string): ReleaseNotesFile {
  const coverage: Record<string, string> = {}
  const notes: ReleaseNote[] = []
  for (const source of RELEASE_NOTE_SOURCES) {
    const all = source.parse(pages[source.provider]!)
    const oldest = all.reduce((m, n) => (n.date < m ? n.date : m), until)
    if (DAY_PRECISE.has(source.provider)) coverage[source.provider] = oldest
    notes.push(...all.filter((n) => n.date < until && (n.names.length > 0 || n.limits)))
  }
  notes.sort((a, b) =>
    a.provider === b.provider
      ? a.date < b.date
        ? -1
        : a.date > b.date
          ? 1
          : a.title.localeCompare(b.title)
      : a.provider.localeCompare(b.provider),
  )
  return { coverage, notes }
}
