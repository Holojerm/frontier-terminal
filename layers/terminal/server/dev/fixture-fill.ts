// Fill a store from the committed fixtures, offline: the polls a cron runs,
// then the filed-facts reader, the suppliers table, the recipes, the power table, the hardware prints and the theses, each answered from
// fixtures/ by URL. dev:fixtures (tasks/dev/fixtures.ts) calls it with the
// dev bindings, test/server/fill.ts with the browser suites' local D1 and R2,
// and fixture-fill.test.ts against the test database, so a page that would
// sweep empty in the browser suites fails a unit test first.

import { runFiledFacts, type FiledFactsReport } from '../../../companies/server/exposure/ingest'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/pipeline/fetch'
import type { RawReader, RawStore } from '#layers/core/server/pipeline/raw'
import type { LockRetry, LockStore } from '#layers/core/server/pipeline/lock'
import {
  manifestFixtures,
  type ManifestFixture,
} from '#layers/core/server/pipeline/parsers/fixture-provenance'
import { runPoll, type PollOutcome } from '#layers/core/server/pipeline/poll'
import type { FetchSource } from '#layers/core/server/pipeline/sources'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { runPowerSiteReads, type PowerReadReport } from '#layers/compute/server/power/ingest'
import { runPrintReads, type PrintReadReport } from '#layers/compute/server/prints/ingest'
import {
  runSupplierReads,
  type SupplierReadReport,
} from '../../../companies/server/suppliers/ingest'
import { evaluateTheses } from '../theses/evaluate'
import { runRecipes } from '../theses/recipes/run'

/** A source with no committed fixture answers like a 404: the run records it as absent. */
const NO_FIXTURE: FetchOutcome = { ok: false, status: 404, detail: 'no fixture for this URL' }

/**
 * The committed edgar-fts capture (2026-08-25) predates Anthropic's S-1, so no
 * lab resolves from it and nothing derives a prospectus. The fill answers the
 * feed from the capture taken after the filing; the parser tests keep the
 * older one.
 */
const LATER_CAPTURE: Readonly<Record<string, string>> = { 'edgar-fts': 'edgar-fts-anthropic-s-1' }

/**
 * What the filed-facts reader is answered from. Its submissions feeds share a
 * URL with the poll's (fixtures/sec/), which were captured before the 10-Qs
 * these instances come from and list filings no instance is committed for.
 */
const FILED_FACT_DIRS = ['fixtures/filed-facts/', 'fixtures/guidance/']

/**
 * The polls, in order. A derived source exists only once the row naming it is
 * stored, so a lab's prospectus takes four: edgar-fts resolves the filer, the
 * next survey reads its submissions feed, the next filings tick each filing's
 * index page, and the one after that the document.
 */
const POLLS = ['survey', 'careers', 'filings', 'survey', 'filings', 'filings'] as const

type Choose = (
  candidates: readonly ManifestFixture[],
  source: FetchSource,
) => ManifestFixture | null

/** Several fixtures can share a URL: the one captured for this source id wins, else the last one the manifest lists. */
const forPoll: Choose = (candidates, source) =>
  candidates.find((f) => f.source_id === LATER_CAPTURE[source.source_id]) ??
  candidates.find((f) => f.source_id === source.source_id) ??
  candidates.at(-1) ??
  null

const forFiledFacts: Choose = (candidates) =>
  candidates.find((f) => FILED_FACT_DIRS.some((dir) => f.path.startsWith(dir))) ?? null

/** A recipe that finds a filer’s newest instance through its submissions feed needs the feed that lists it. */
const forRecipes: Choose = (candidates, source) =>
  candidates.find((f) => f.source_id === source.source_id) ??
  forFiledFacts(candidates, source) ??
  candidates.at(-1) ??
  null

export interface FixtureFillDeps {
  db: PipelineDb
  raw: RawStore
  /** Reads back what `raw` stored (FiledFactsDeps.readRaw). */
  readRaw: RawReader
  lock: LockStore
  sourcesYaml: string
  /** Text of a committed file by repo-relative path. */
  read: (path: string) => string | Promise<string>
  now?: () => Date
  /** Tests only, as on PollDeps. */
  surveyLockRetry?: LockRetry
}

export interface FixtureFillReport {
  polls: PollOutcome[]
  filed_facts: FiledFactsReport
  /** The hand-read rows seeded; no supplier filing has a fixture, so none is read. */
  suppliers: SupplierReadReport
  recipes: number
  /** The hand-read rows seeded; no site search has a fixture, so no filing is read. */
  power: PowerReadReport
  /** The exchange feed, Accton’s page, the three committed TSMC 6-Ks and the four KCS releases. */
  prints: PrintReadReport
  theses: Awaited<ReturnType<typeof evaluateTheses>>
}

function fixtureFetcher(read: FixtureFillDeps['read'], pick: Choose): SourceFetcher {
  const byUrl = new Map<string, ManifestFixture[]>()
  for (const f of manifestFixtures) byUrl.set(f.source_url, [...(byUrl.get(f.source_url) ?? []), f])
  return async (source) => {
    const fixture = pick(byUrl.get(source.url) ?? [], source)
    if (!fixture) return NO_FIXTURE
    const text = await read(fixture.path)
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

export async function fillFromFixtures(deps: FixtureFillDeps): Promise<FixtureFillReport> {
  const { db, raw, lock, sourcesYaml, surveyLockRetry } = deps
  const now = deps.now ?? (() => new Date())
  const fetcher = fixtureFetcher(deps.read, forPoll)
  const polls: PollOutcome[] = []
  for (const scope of POLLS) {
    polls.push(await runPoll(scope, { db, raw, lock, fetcher, sourcesYaml, now, surveyLockRetry }))
  }
  const filed_facts = await runFiledFacts(db, {
    raw,
    readRaw: deps.readRaw,
    fetcher: fixtureFetcher(deps.read, forFiledFacts),
    now: now(),
    sourcesYaml,
  })
  const suppliers = await runSupplierReads(db, {
    raw,
    fetcher: fixtureFetcher(deps.read, forPoll),
    now: now(),
  })
  const recipes = await runRecipes(db, {
    raw,
    fetcher: fixtureFetcher(deps.read, forRecipes),
    now,
  })
  const power = await runPowerSiteReads(db, {
    raw,
    fetcher: fixtureFetcher(deps.read, forPoll),
    now: now(),
  })
  const prints = await runPrintReads(db, {
    raw,
    fetcher: fixtureFetcher(deps.read, forPoll),
    now: now(),
  })
  const theses = await evaluateTheses(db, { sourcesYaml, now })
  return { polls, filed_facts, suppliers, recipes: recipes.length, power, prints, theses }
}
