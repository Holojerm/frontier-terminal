import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { Provider } from '#layers/core/server/utils/contracts'
import { parseRevenueFilersBlock } from './parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from './parsers/sec/whitelist'
import { registrationFormSlug, registrationKey } from './parsers/sec/filing-index'
import { periodBefore, segmentKey } from './parsers/sec/xbrl-segment'
import { derivedSourceId, type DerivedKind } from '#layers/core/server/pipeline/derived'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'

// The SEC's derived sources (core's derived.ts has the mechanism): a resolved
// lab's submissions and company facts from its `filer` row, a segment filer's
// recent 10-Q/10-K from its submissions feed, a resolved lab's registration
// filings from its submissions feed, and each such filing's primary document
// from its filing index. Each is a DerivedKind in COMPANY_DERIVED_KINDS.

export interface ResolvedFiler {
  provider: Provider
  cik: string
  name: string
}

/** The `filer` rows the store holds: which labs resolved, to which CIK. */
export async function resolvedFilers(db: PipelineDb): Promise<ResolvedFiler[]> {
  const rows = await db
    .select({ provider: tables.entities.provider, payload: tables.entities.payload })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'filer'))
  const out: ResolvedFiler[] = []
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as { cik?: unknown; name?: unknown }
      if (typeof p.cik === 'string' && /^\d{10}$/.test(p.cik) && typeof p.name === 'string') {
        out.push({ provider: row.provider as Provider, cik: p.cik, name: p.name })
      }
    } catch {
      continue
    }
  }
  return out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
}

/** Periodic filings a segment source is derived for, per filer: one fiscal year's worth. */
export const SEGMENT_FILINGS_PER_FILER = 4

export interface SegmentFiling {
  ticker: string
  cik: string
  segment: string
  accession_no: string
  file_date: string
}

/**
 * The newest 10-Q/10-K per segment filer (sources.yaml revenue_filers with a
 * `segment`), read from the filings its submissions feed stored. Amendments
 * are left out: the instance-name rule (sources.yaml › xbrl-segment) is
 * verified on originals only.
 */
export async function segmentFilings(
  db: PipelineDb,
  sourcesYaml: string,
): Promise<SegmentFiling[]> {
  const whitelist = parseCikWhitelistBlock(sourcesYaml)
  const out: SegmentFiling[] = []
  for (const filer of parseRevenueFilersBlock(sourcesYaml).values()) {
    const cik = filer?.segment ? whitelist.get(filer.ticker) : null
    if (!filer?.segment || !cik) continue
    const form = sql<string | null>`json_extract(${tables.entities.payload}, '$.form')`
    const fileDate = sql<string | null>`json_extract(${tables.entities.payload}, '$.file_date')`
    const accession = sql<string | null>`json_extract(${tables.entities.payload}, '$.accession_no')`
    const rows = await db
      .select({ accession, fileDate })
      .from(tables.entities)
      .where(
        and(
          eq(tables.entities.source_id, `edgar-submissions-${filer.ticker.toLowerCase()}`),
          eq(tables.entities.entity_type, 'filing'),
          inArray(form, ['10-Q', '10-K']),
        ),
      )
      .orderBy(desc(fileDate), desc(accession))
      .limit(SEGMENT_FILINGS_PER_FILER)
    for (const r of rows) {
      if (!r.accession || !/^\d{10}-\d{2}-\d{6}$/.test(r.accession)) continue
      if (!r.fileDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.fileDate)) continue
      out.push({
        ticker: filer.ticker,
        cik,
        segment: filer.segment,
        accession_no: r.accession,
        file_date: r.fileDate,
      })
    }
  }
  return out
}

/** Registration filings an index source is derived for, per resolved lab: the S-1 and its latest amendments. */
export const REGISTRATION_FILINGS_PER_FILER = 3

export interface RegistrationFiling {
  provider: Provider
  cik: string
  form: string
  accession_no: string
  file_date: string
}

/**
 * The newest S-1 / S-1/A / 424B4 per lab resolved from its own S-1, read from
 * the filings its derived submissions feed stored. A lab tagged in
 * sources.yaml files XBRL under a ticker and is read from company facts.
 */
export async function registrationFilings(db: PipelineDb): Promise<RegistrationFiling[]> {
  const form = sql<string | null>`json_extract(${tables.entities.payload}, '$.form')`
  const fileDate = sql<string | null>`json_extract(${tables.entities.payload}, '$.file_date')`
  const accession = sql<string | null>`json_extract(${tables.entities.payload}, '$.accession_no')`
  const out: RegistrationFiling[] = []
  for (const filer of await resolvedFilers(db)) {
    const rows = await db
      .select({ accession, fileDate, form })
      .from(tables.entities)
      .where(
        and(
          eq(tables.entities.source_id, `edgar-submissions-${filer.provider}`),
          eq(tables.entities.entity_type, 'filing'),
          inArray(form, ['S-1', 'S-1/A', '424B4']),
        ),
      )
      .orderBy(desc(fileDate), desc(accession))
      .limit(REGISTRATION_FILINGS_PER_FILER)
    for (const r of rows) {
      if (!r.accession || !/^\d{10}-\d{2}-\d{6}$/.test(r.accession)) continue
      if (!r.fileDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.fileDate)) continue
      if (!r.form || !registrationFormSlug(r.form)) continue
      out.push({
        provider: filer.provider,
        cik: filer.cik,
        form: r.form,
        accession_no: r.accession,
        file_date: r.fileDate,
      })
    }
  }
  return out
}

export interface RegistrationDocument extends RegistrationFiling {
  document: string
}

/** The primary documents the filing-index sources located. */
export async function registrationDocuments(db: PipelineDb): Promise<RegistrationDocument[]> {
  const rows = await db
    .select({ payload: tables.entities.payload })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.entity_type, 'document'),
        like(tables.entities.source_id, 'filing-index-%'),
      ),
    )
  const out: RegistrationDocument[] = []
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as Record<string, unknown>
      const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null)
      const [provider, cik, form, accession_no, file_date, document] = [
        s('provider'),
        s('cik'),
        s('form'),
        s('accession_no'),
        s('filed'),
        s('document'),
      ]
      if (!provider || !cik || !form || !accession_no || !file_date || !document) continue
      if (!registrationFormSlug(form) || !/^[A-Za-z0-9._-]+\.htm$/.test(document)) continue
      out.push({ provider: provider as Provider, cik, form, accession_no, file_date, document })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => (a.accession_no < b.accession_no ? -1 : 1))
}

const archivesPath = (url: string, f: { cik: string; accession_no: string }) =>
  url
    .replace('{cik_number}', String(Number(f.cik)))
    .replace('{accession_digits}', f.accession_no.replace(/-/g, ''))

/** The SEC's template kinds, in the order server/registries/lanes.ts lists them. */
export const COMPANY_DERIVED_KINDS: readonly DerivedKind[] = [
  {
    from: 'filer',
    load: async (db) => {
      const filers = await resolvedFilers(db)
      return (t) =>
        filers.map((f) => ({
          source_id: derivedSourceId(t.id, f.provider),
          url: t.url.replace('{cik}', f.cik),
          ext: 'json',
        }))
    },
  },
  {
    from: 'segment-filing',
    load: async (db, sourcesYaml) => {
      const segments = await segmentFilings(db, sourcesYaml)
      return (t) =>
        segments.map((f) => ({
          source_id: derivedSourceId(t.id, segmentKey(f.ticker, f.file_date, f.accession_no)),
          url: t.url
            .replace('{cik_number}', String(Number(f.cik)))
            .replace('{accession_digits}', f.accession_no.replace(/-/g, ''))
            .replace('{prefix}', f.segment.split(':')[0]!)
            .replace('{period}', periodBefore(f.file_date).replace(/-/g, '')),
          ext: 'xml',
        }))
    },
  },
  {
    from: 'registration-filing',
    load: async (db) => {
      const registrations = await registrationFilings(db)
      return (t) =>
        registrations.map((f) => ({
          source_id: derivedSourceId(
            t.id,
            registrationKey(f.provider, f.form, f.file_date, f.accession_no),
          ),
          url: archivesPath(t.url, f).replace('{accession_no}', f.accession_no),
          ext: 'html',
        }))
    },
  },
  {
    from: 'registration-document',
    load: async (db) => {
      const documents = await registrationDocuments(db)
      return (t) =>
        documents.map((d) => ({
          source_id: derivedSourceId(
            t.id,
            registrationKey(d.provider, d.form, d.file_date, d.accession_no),
          ),
          url: archivesPath(t.url, d).replace('{document}', d.document),
          ext: 'html',
        }))
    },
  },
]
