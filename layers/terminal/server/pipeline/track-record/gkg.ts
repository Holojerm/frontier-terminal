// GDELT's Global Knowledge Graph files: one zipped TSV every 15 minutes at
// data.gdeltproject.org/gdeltv2/<stamp>.gkg.csv.zip, one row per English news
// article GDELT's crawler read in that quarter hour. They are static files,
// not the DOC search API, so they carry no per-IP limit; the same crawl is
// what the DOC API searched, so an article found here is one it would have
// returned. Terms: sources.yaml › track_record_sources › gdelt-gkg.
//
// The press side reads every file once, in order, off the Worker
// (scripts/gdelt-search.ts on GitHub Actions; a file is ~2.5 MB zipped
// and ~8 MB unzipped). What a row carries that the track record uses: the
// record id, DATE (the quarter hour GDELT read it, UTC), the outlet's domain,
// the article URL, its <PAGE_TITLE>, and the names GDELT found in its text.
// Rows naming a tracked lab, filer or model family are kept, compacted, for
// matching (mentions.ts).

/** The first quarter hour read: the earliest track-record window (2026-09-08) starts 7 days before. */
export const GKG_FROM = '2026-09-01T00:00:00.000Z'

export const GKG_BASE = 'http://data.gdeltproject.org/gdeltv2/'

export const GKG_SLOT_MS = 15 * 60_000

/** A quarter hour's file is asked for this long after it starts: GDELT publishes ~15 minutes behind. */
export const GKG_READY_MS = 30 * 60_000

/** Columns in a GKG 2.1 row. */
export const GKG_COLUMNS = 27

const pad = (n: number) => String(n).padStart(2, '0')

/** 2026-09-29T18:30:00.000Z -> 20260929183000, a file's name and its rows' DATE. */
export function gkgStamp(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

/** 20260929183000 -> 2026-09-29T18:30:00.000Z */
export function stampIso(stamp: string): string {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) throw new Error(`unreadable GKG stamp ${stamp}`)
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString()
}

export const gkgUrl = (stamp: string) => `${GKG_BASE}${stamp}.gkg.csv.zip`

/** Every quarter hour from GKG_FROM whose file should exist by `now`, oldest first. */
export function gkgSlots(now: Date, from: string = GKG_FROM): string[] {
  const out: string[] = []
  const last = now.getTime() - GKG_READY_MS
  for (let t = Date.parse(from); t <= last; t += GKG_SLOT_MS) out.push(gkgStamp(t))
  return out
}

export interface GkgArticle {
  record_id: string
  /** When GDELT read it: its file's quarter hour, ISO UTC. */
  seen_at: string
  outlet: string
  url: string
  title: string
  /** Organizations and every proper name GDELT found in the text. */
  names: string[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

/**
 * One row, or null for a row the track record cannot use: the wrong shape, a
 * DocumentIdentifier that is not a web URL (GDELT also ingests broadcast
 * transcripts and other collections), or no title.
 */
export function parseGkgRow(line: string): GkgArticle | null {
  const cols = line.split('\t')
  if (cols.length !== GKG_COLUMNS) return null
  const [record_id, date, collection, outlet, url] = cols
  // SourceCollectionIdentifier 1 is the open web.
  if (collection !== '1' || !/^https?:\/\//.test(url!) || !/^\d{14}$/.test(date!)) return null
  const title = cols[26]!.match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/)?.[1]
  if (!title?.trim()) return null
  const allNames = cols[23]!
    .split(';')
    .map((n) => n.replace(/,\d+$/, '').trim())
    .filter(Boolean)
  const orgs = cols[13]!
    .split(';')
    .map((n) => n.trim())
    .filter(Boolean)
  return {
    record_id: record_id!,
    seen_at: stampIso(date!),
    outlet: outlet!,
    url: url!,
    title: unescapeEntities(title).replace(/\s+/g, ' ').trim(),
    names: [...new Set([...orgs, ...allNames])],
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // A copy, so the Blob holds a plain ArrayBuffer whatever `data` views.
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * The one file in a GDELT zip, read through the central directory so a local
 * header that defers its sizes to a data descriptor reads the same. Stored
 * (0) and deflated (8) entries only; anything else throws.
 */
export async function unzipOne(zip: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory')
  const central = view.getUint32(eocd + 16, true)
  if (view.getUint32(central, true) !== 0x02014b50) throw new Error('zip: bad central directory')
  const method = view.getUint16(central + 10, true)
  const size = view.getUint32(central + 20, true)
  const local = view.getUint32(central + 42, true)
  if (view.getUint32(local, true) !== 0x04034b50) throw new Error('zip: bad local header')
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  const data = zip.subarray(start, start + size)
  if (method === 0) return data
  if (method === 8) return inflateRaw(data)
  throw new Error(`zip: unsupported compression method ${method}`)
}
