#!/usr/bin/env bun
// The labs' release notes, reduced to what dates an archived price event
// (layers/terminal/server/pipeline/archive/release-notes.ts): each dated
// note before ARCHIVE_UNTIL that names a model, and the first day each lab's
// notes cover. Reads the committed pages under fixtures/release-notes/ and
// writes release-notes.json beside the reader, which the signal loader
// imports. A test fails when the two drift.
//
//   bun run release-notes              rebuild the JSON from the fixtures
//   bun run release-notes -- --fetch   re-read the live pages into the fixtures first

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { userAgentFor } from '../layers/core/server/pipeline/fetch'
import { ARCHIVE_UNTIL } from '../layers/terminal/server/pipeline/archive/eras'
import {
  RELEASE_NOTE_FIXTURES,
  releaseNotesFile,
} from '../layers/terminal/server/pipeline/archive/release-notes-file'
import { RELEASE_NOTE_SOURCES } from '../layers/terminal/server/pipeline/archive/release-notes'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'layers/terminal/server/pipeline/archive/release-notes.json')

if (process.argv.includes('--fetch')) {
  for (const source of RELEASE_NOTE_SOURCES) {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': userAgentFor(source.url, {
          secContactEmail: '',
          appUrl: 'https://frontierterm.com',
        })!,
      },
    })
    if (!res.ok) throw new Error(`${source.url}: HTTP ${res.status}`)
    const text = await res.text()
    source.parse(text) // refuse a page the reader can't read before overwriting the fixture
    writeFileSync(join(ROOT, RELEASE_NOTE_FIXTURES[source.provider]!), text)
    console.error(
      `${source.provider}: ${text.length} bytes; update fixtures/manifest.json's fetched_at`,
    )
  }
}

const pages = Object.fromEntries(
  await Promise.all(
    RELEASE_NOTE_SOURCES.map(
      async (s) =>
        [
          s.provider,
          await Bun.file(join(ROOT, RELEASE_NOTE_FIXTURES[s.provider]!)).text(),
        ] as const,
    ),
  ),
)
const file = releaseNotesFile(pages, ARCHIVE_UNTIL.slice(0, 10))
writeFileSync(OUT, `${JSON.stringify(file, null, 1)}\n`)
console.error(
  `${file.notes.length} notes; coverage ${Object.entries(file.coverage)
    .map(([p, d]) => `${p} ${d}`)
    .join(', ')}`,
)
