// The text of a PDF, page by page, without a PDF library: enough for the
// reports this layer reads (ERCOT's monthly PDFs), not a general reader. Flate
// streams, loose or packed objects, ToUnicode CMaps; positioning becomes a
// space or a line break. Encrypted files, other filters, and fonts with neither
// ToUnicode nor a single-byte encoding throw or yield less text, never wrong text.

export const decoder = new TextDecoder('latin1')

// Some writers (LSEG's transcripts) end a stream without its checksum, and
// DecompressionStream then errors after it has emitted every byte. What it
// emitted before the error is kept; a stream that yields nothing still throws.
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch (error) {
    if (size === 0) throw error
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

interface PdfObject {
  /** The object's text up to `stream` (its dictionary, or the whole value). */
  head: string
  /** The raw stream bytes, still encoded. */
  stream: Uint8Array | null
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g

function streamBytes(bytes: Uint8Array, text: string, from: number, head: string): Uint8Array {
  let start = from + 'stream'.length
  if (text[start] === '\r') start++
  if (text[start] === '\n') start++
  const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(head)
  if (len) {
    const n = Number(len[1])
    if (text.slice(start + n, start + n + 30).includes('endstream'))
      return bytes.subarray(start, start + n)
  }
  const end = text.indexOf('endstream', start)
  let stop = end
  while (stop > start && (text[stop - 1] === '\n' || text[stop - 1] === '\r')) stop--
  return bytes.subarray(start, stop)
}

/** Every top-level object, by number. A later definition wins (incremental updates). */
function looseObjects(bytes: Uint8Array, text: string): Map<number, PdfObject> {
  const out = new Map<number, PdfObject>()
  for (const m of text.matchAll(OBJ_RE)) {
    const at = m.index + m[0].length
    const end = text.indexOf('endobj', at)
    if (end < 0) continue
    const body = text.slice(at, end)
    const s = body.search(/\bstream\b/)
    if (s >= 0 && !/endstream/.test(body.slice(0, s))) {
      const head = body.slice(0, s)
      out.set(Number(m[1]), { head, stream: streamBytes(bytes, text, at + s, head) })
    } else {
      out.set(Number(m[1]), { head: body, stream: null })
    }
  }
  return out
}

export async function decoded(obj: PdfObject): Promise<Uint8Array> {
  if (!obj.stream) throw new Error('not a stream')
  if (/\/Encrypt\b/.test(obj.head)) throw new Error('encrypted PDF')
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.head)?.[1] ?? ''
  if (filter === '') return obj.stream
  if (/^(\/FlateDecode|\[\s*\/FlateDecode\s*\])$/.test(filter)) return inflate(obj.stream)
  throw new Error(`unsupported filter ${filter}`)
}

export async function allObjects(bytes: Uint8Array): Promise<Map<number, PdfObject>> {
  const text = decoder.decode(bytes)
  if (!text.startsWith('%PDF')) throw new Error('not a PDF')
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) throw new Error('encrypted PDF')
  const objects = looseObjects(bytes, text)
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.head)) continue
    const n = Number(/\/N\s+(\d+)/.exec(obj.head)?.[1])
    const first = Number(/\/First\s+(\d+)/.exec(obj.head)?.[1])
    const body = decoder.decode(await decoded(obj))
    const index = body.slice(0, first).trim().split(/\s+/).map(Number)
    for (let i = 0; i < n; i++) {
      const num = index[2 * i]!
      const off = first + index[2 * i + 1]!
      const next = i + 1 < n ? first + index[2 * i + 3]! : body.length
      if (!objects.has(num)) objects.set(num, { head: body.slice(off, next), stream: null })
    }
  }
  return objects
}

const ref = (s: string | undefined) => (s ? Number(/^(\d+)\s+\d+\s+R/.exec(s.trim())?.[1]) : NaN)

/** The value of /Key in a dictionary's text: a reference, a name, a number or a nested dict/array. */
function entry(dict: string, key: string): string | undefined {
  const m = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(dict)
  if (!m) return undefined
  const at = m.index + m[0].length
  const c = dict[at]
  if (c === '<' && dict[at + 1] === '<') return balanced(dict, at, '<<', '>>')
  if (c === '[') return balanced(dict, at, '[', ']')
  return /^(\d+\s+\d+\s+R|\/[^\s/<>[\]()]+|[-\d.]+)/.exec(dict.slice(at))?.[1]
}

function balanced(s: string, at: number, open: string, close: string): string {
  let depth = 0
  for (let i = at; i < s.length;) {
    if (s.startsWith(open, i)) {
      depth++
      i += open.length
    } else if (s.startsWith(close, i)) {
      depth--
      i += close.length
      if (depth === 0) return s.slice(at, i)
    } else i++
  }
  return s.slice(at)
}

/** A dictionary given inline or by reference. */
function resolveDict(objects: Map<number, PdfObject>, v: string | undefined): string {
  if (!v) return ''
  const n = ref(v)
  return Number.isNaN(n) ? v : (objects.get(n)?.head ?? '')
}

// ─── CMaps ───────────────────────────────────────────────────────────────────

interface FontMap {
  bytes: 1 | 2
  map: Map<number, string> | null
}

const hexToUtf16 = (hex: string) => {
  let s = ''
  for (let i = 0; i + 4 <= hex.length; i += 4)
    s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  if (hex.length % 4 === 2) s += String.fromCharCode(parseInt(hex.slice(-2), 16))
  return s
}

export function parseCMap(cmap: string): FontMap {
  const map = new Map<number, string>()
  const space = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(cmap)
  const bytes: 1 | 2 = space && space[1]!.length <= 2 ? 1 : 2
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g))
      map.set(parseInt(m[1]!, 16), hexToUtf16(m[2]!))
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g,
    )) {
      const lo = parseInt(m[1]!, 16)
      const hi = parseInt(m[2]!, 16)
      if (m[3]!.startsWith('[')) {
        const list = [...m[3]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToUtf16(x[1]!))
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]!)
      } else {
        const base = m[3]!.slice(1, -1)
        const start = hexToUtf16(base)
        const last = start.charCodeAt(start.length - 1)
        for (let c = lo; c <= hi; c++)
          map.set(c, start.slice(0, -1) + String.fromCharCode(last + (c - lo)))
      }
    }
  }
  return { bytes, map }
}

async function fontMaps(
  objects: Map<number, PdfObject>,
  resources: string,
  cache: Map<number, FontMap>,
): Promise<Map<string, FontMap>> {
  const out = new Map<string, FontMap>()
  const fonts = resolveDict(objects, entry(resources, 'Font'))
  for (const m of fonts.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const num = Number(m[2])
    let fm = cache.get(num)
    if (!fm) {
      const font = objects.get(num)?.head ?? ''
      const tu = objects.get(ref(entry(font, 'ToUnicode')))
      const twoByte = /\/Subtype\s*\/Type0/.test(font)
      if (tu?.stream) fm = parseCMap(decoder.decode(await decoded(tu)))
      else fm = { bytes: twoByte ? 2 : 1, map: null }
      // A simple font's codes are one byte, whatever codespace its CMap declares.
      fm.bytes = twoByte ? 2 : 1
      cache.set(num, fm)
    }
    out.set(m[1]!, fm)
  }
  return out
}

// ─── Content streams ─────────────────────────────────────────────────────────

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

function literal(s: string, at: number): { codes: number[]; end: number } {
  const codes: number[] = []
  let depth = 1
  let i = at + 1
  while (i < s.length && depth > 0) {
    const c = s[i]!
    if (c === '\\') {
      const n = s[i + 1]!
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0]
        codes.push(parseInt(oct, 8) & 0xff)
        i += 1 + oct.length
        continue
      }
      if (n === '\r' || n === '\n') {
        i += n === '\r' && s[i + 2] === '\n' ? 3 : 2
        continue
      }
      codes.push((ESC[n] ?? n).charCodeAt(0))
      i += 2
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) break
    codes.push(c.charCodeAt(0))
    i++
  }
  return { codes, end: i + 1 }
}

function hexString(s: string, at: number): { codes: number[]; end: number } {
  const end = s.indexOf('>', at)
  let hex = s.slice(at + 1, end).replace(/\s+/g, '')
  if (hex.length % 2) hex += '0'
  const codes: number[] = []
  for (let i = 0; i < hex.length; i += 2) codes.push(parseInt(hex.slice(i, i + 2), 16))
  return { codes, end: end + 1 }
}

function show(codes: number[], font: FontMap | undefined): string {
  const bytes = font?.bytes ?? 1
  let out = ''
  for (let i = 0; i + bytes <= codes.length; i += bytes) {
    const code = bytes === 2 ? (codes[i]! << 8) | codes[i + 1]! : codes[i]!
    const mapped = font?.map?.get(code)
    if (mapped !== undefined) out += mapped
    else if (bytes === 1) out += String.fromCharCode(code)
  }
  return out
}

/** The text a content stream shows, with a space or line break between runs. */
export function contentText(stream: string, fonts: Map<string, FontMap>): string {
  let out = ''
  let font: FontMap | undefined
  const operands: (string | { codes: number[] } | (number | { codes: number[] })[])[] = []
  let array: (number | { codes: number[] })[] | null = null
  const brk = (c: string) => {
    if (out && !out.endsWith(c) && !out.endsWith('\n')) out += c
  }
  let i = 0
  while (i < stream.length) {
    const c = stream[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '%') {
      const nl = stream.slice(i).search(/[\r\n]/)
      i = nl < 0 ? stream.length : i + nl
      continue
    }
    if (c === '(') {
      const r = literal(stream, i)
      ;(array ?? operands).push({ codes: r.codes })
      i = r.end
      continue
    }
    if (c === '<' && stream[i + 1] !== '<') {
      const r = hexString(stream, i)
      ;(array ?? operands).push({ codes: r.codes })
      i = r.end
      continue
    }
    if (c === '[') {
      array = []
      i++
      continue
    }
    if (c === ']') {
      if (array) operands.push(array)
      array = null
      i++
      continue
    }
    if (c === '<' || c === '>') {
      i += 2
      continue
    }
    const tok = /^[^\s()<>[\]{}/%]+|^\/[^\s()<>[\]{}/%]*/.exec(stream.slice(i, i + 200))?.[0] ?? c
    i += tok.length
    if (tok.startsWith('/') || /^[-+.\d]/.test(tok)) {
      if (array && !tok.startsWith('/')) array.push(Number(tok))
      else operands.push(tok)
      continue
    }
    switch (tok) {
      case 'Tf':
        font = fonts.get(String(operands[operands.length - 2] ?? '').slice(1))
        break
      case 'Tj':
      case "'":
      case '"': {
        if (tok !== 'Tj') brk('\n')
        const s = operands[operands.length - 1]
        if (s && typeof s === 'object' && 'codes' in s) out += show(s.codes, font)
        break
      }
      case 'TJ': {
        const a = operands[operands.length - 1]
        if (Array.isArray(a)) {
          for (const part of a) {
            if (typeof part === 'number') {
              if (part < -200) brk(' ')
            } else out += show(part.codes, font)
          }
        }
        break
      }
      case 'Td':
      case 'TD': {
        const ty = Number(operands[operands.length - 1])
        brk(Math.abs(ty) > 1 ? '\n' : ' ')
        break
      }
      case 'T*':
        brk('\n')
        break
      case 'Tm':
      case 'BT':
      case 'ET':
        brk(' ')
        break
      case 'BI': {
        const ei = stream.indexOf('EI', i)
        i = ei < 0 ? stream.length : ei + 2
        break
      }
    }
    operands.length = 0
  }
  return out
}

function pageList(
  objects: Map<number, PdfObject>,
  node: number,
  seen = new Set<number>(),
): number[] {
  if (seen.has(node)) return []
  seen.add(node)
  const head = objects.get(node)?.head ?? ''
  if (/\/Type\s*\/Page(?!s)/.test(head)) return [node]
  const kids = entry(head, 'Kids') ?? ''
  return [...kids.matchAll(/(\d+)\s+\d+\s+R/g)].flatMap((k) =>
    pageList(objects, Number(k[1]), seen),
  )
}

/** Each page's inherited /Resources: the page's own, else its nearest ancestor's. */
function resourcesOf(objects: Map<number, PdfObject>, page: number): string {
  let head = objects.get(page)?.head ?? ''
  for (let depth = 0; depth < 32; depth++) {
    const r = entry(head, 'Resources')
    if (r) return resolveDict(objects, r)
    const parent = ref(entry(head, 'Parent'))
    if (Number.isNaN(parent)) return ''
    head = objects.get(parent)?.head ?? ''
  }
  return ''
}

/**
 * A content stream's text, and the text of each form XObject it draws with
 * `Do` (FactSet's and LSEG's transcripts put every page's text in one),
 * read with the form's own resources, or the caller's when it has none.
 */
async function streamText(
  objects: Map<number, PdfObject>,
  stream: string,
  resources: string,
  cache: Map<number, FontMap>,
  depth: number,
): Promise<string> {
  let text = contentText(stream, await fontMaps(objects, resources, cache))
  if (depth >= 4 || !/\bDo\b/.test(stream)) return text
  const xobjects = resolveDict(objects, entry(resources, 'XObject'))
  for (const m of stream.matchAll(/\/([^\s/<>[\]()]+)\s+Do\b/g)) {
    const named = new RegExp(
      String.raw`\/${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s+(\d+)\s+\d+\s+R`,
    ).exec(xobjects)
    const form = named ? objects.get(Number(named[1])) : undefined
    if (!form?.stream || !/\/Subtype\s*\/Form\b/.test(form.head)) continue
    const own = entry(form.head, 'Resources')
    text +=
      '\n' +
      (await streamText(
        objects,
        decoder.decode(await decoded(form)),
        own ? resolveDict(objects, own) : resources,
        cache,
        depth + 1,
      ))
  }
  return text
}

/** The text of every page, in page order. Throws on a file it cannot read at all. */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const objects = await allObjects(bytes)
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.head))
  if (!catalog) throw new Error('no catalog')
  const root = ref(entry(catalog.head, 'Pages'))
  const cache = new Map<number, FontMap>()
  const pages: string[] = []
  for (const page of pageList(objects, root)) {
    const head = objects.get(page)!.head
    const resources = resourcesOf(objects, page)
    const contents = entry(head, 'Contents') ?? ''
    let text = ''
    for (const r of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const obj = objects.get(Number(r[1]))
      if (!obj?.stream) continue
      text +=
        (await streamText(objects, decoder.decode(await decoded(obj)), resources, cache, 0)) + '\n'
    }
    pages.push(text)
  }
  if (pages.length === 0) throw new Error('no pages')
  return pages
}
