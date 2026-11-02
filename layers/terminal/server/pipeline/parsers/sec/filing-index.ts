import {
  FilingIndexOutput,
  registerParser,
  type ParserId,
  type Provenance,
  type Provider,
  type RegistrationDocumentRow,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// filing-index-<provider>-<form>-<filed>-<accession> — EDGAR's index page for
// one registration filing (www.sec.gov/Archives/edgar/data/{cik}/{accession}/
// {accession}-index.htm), derived per S-1 / S-1/A / 424B4 in a resolved lab's
// submissions feed (derived.ts). The feed names the accession but not the
// document; the index's document table does: sequence 1, whose Type is the
// filing's own form, is the prospectus. The page states the filer's CIK and
// the form, and a mismatch with the key it was derived for throws.

export interface RegistrationTarget {
  provider: Provider
  /** Root form as the key spells it: S-1, S-1/A or 424B4. */
  form: string
  filed: string
  accession_no: string
}

const FORM_SLUGS: Readonly<Record<string, string>> = {
  's-1': 'S-1',
  's-1-a': 'S-1/A',
  '424b4': '424B4',
}

/** `S-1/A` -> `s-1-a`; null for a form no registration source is derived for. */
export function registrationFormSlug(form: string): string | null {
  const slug = form.toLowerCase().replace('/', '-')
  return FORM_SLUGS[slug] ? slug : null
}

/** The derived key for one registration filing: `<provider>-<form>-<filed>-<accession>`. */
export function registrationKey(
  provider: Provider,
  form: string,
  filed: string,
  accessionNo: string,
): string {
  const slug = registrationFormSlug(form)
  if (!slug) throw new Error(`no registration source is derived for form ${form}`)
  return `${provider}-${slug}-${filed}-${accessionNo}`
}

export function registrationTarget(key: string): RegistrationTarget {
  const m = key.match(/^([a-z]+)-(s-1-a|s-1|424b4)-(\d{4}-\d{2}-\d{2})-(\d{10}-\d{2}-\d{6})$/)
  if (!m) throw new Error(`registration key is not <provider>-<form>-<filed>-<accession>: ${key}`)
  return {
    provider: m[1] as Provider,
    form: FORM_SLUGS[m[2]!]!,
    filed: m[3]!,
    accession_no: m[4]!,
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;/g, '’')
}

/** A cell's text: tags stripped, entities decoded, whitespace collapsed. */
export function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[\s ]+/g, ' ')
    .trim()
}

/** Every `<tr>` of a fragment as its cells' text, empty cells kept. */
export function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]!)),
  )
}

export function parseFilingIndex(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): RegistrationDocumentRow[] {
  const pageCik = html.match(/CIK<\/acronym>[^<]*<a[^>]*>\s*(\d{10})/)?.[1]
  if (pageCik !== cik) throw new Error(`filing index is CIK ${pageCik}, derived for CIK ${cik}`)
  const pageForm = html.match(/<div id="formName">\s*<strong>Form ([^<]+)<\/strong>/)?.[1]?.trim()
  if (pageForm !== target.form) {
    throw new Error(`filing index is Form ${pageForm}, derived for ${target.form}`)
  }
  const name = html.match(/<span class="companyName">([^<]+)/)?.[1]
  const entityName = name ? cellText(name).replace(/\s*\(Filer\)$/, '') : ''
  if (!entityName) throw new Error('filing index names no filer')

  const primary = tableRows(html).find((cells) => cells[0] === '1')
  if (!primary || primary[3] !== target.form) {
    throw new Error(`filing index has no sequence-1 document of type ${target.form}`)
  }
  const document = primary[2]!.split(' ')[0]!
  return FilingIndexOutput.parse({
    rows: [
      {
        provider: target.provider,
        cik,
        entity_name: entityName,
        accession_no: target.accession_no,
        form: target.form,
        filed: target.filed,
        document,
        ...prov,
      },
    ],
  }).rows
}

/** The CIK a derived EDGAR Archives URL was composed with (`/edgar/data/{cik}/`), zero-padded. */
export function archivesCik(url: string): string {
  const m = url.match(/\/Archives\/edgar\/data\/(\d+)\//)
  if (!m) throw new Error(`not an EDGAR Archives URL: ${url}`)
  return m[1]!.padStart(10, '0')
}

/** The representative fixtures the shared parsers are gated on (fixtures/manifest.json). */
export const REGISTRATION_FIXTURE = {
  key: 'anthropic-s-1-2026-10-26-0001628280-26-067168',
  indexSourceId: 'filing-index-anthropic-s-1-2026-10-26-0001628280-26-067168',
  indexPath: 'fixtures/sec/filing-index-anthropic-s-1.html',
  prospectusSourceId: 'prospectus-revenue-anthropic-s-1-2026-10-26-0001628280-26-067168',
  prospectusPath: 'fixtures/sec/prospectus-anthropic-s-1.html',
} as const

registerParser({
  name: REGISTRATION_FIXTURE.indexSourceId as ParserId,
  lane: 'sec',
  fixturePath: REGISTRATION_FIXTURE.indexPath,
  sideFixturePaths: [],
  schema: FilingIndexOutput,
  parse: (text) => {
    const prov = fixtureProvenance(REGISTRATION_FIXTURE.indexSourceId)
    return FilingIndexOutput.parse({
      rows: parseFilingIndex(
        text,
        registrationTarget(REGISTRATION_FIXTURE.key),
        archivesCik(prov.source_url),
        prov,
      ),
    })
  },
})
