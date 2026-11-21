// Which URLs a webhook may point at. The Worker POSTs to whatever is stored,
// so this is the SSRF guard: https on port 443, a public DNS name, no IP
// literal, no internal-only suffix. Checked by webhooks:add, again by
// webhooks:test, and again before every send, so an edited row can't
// bypass it. Pure, no aliases: scripts/webhooks.ts imports it.
//
// A name can still resolve to a private address. The CLI resolves it on add
// and refuses one that does (addressRefusal); the Worker can't resolve names,
// and a Worker's fetch can't reach a private network anyway.

const MAX_URL_LENGTH = 2048

/** Suffixes that only ever mean a private or reserved network. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'localdomain',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
  'home.arpa',
  'arpa',
  'test',
  'example',
  'invalid',
  'onion',
]

/** Null when `raw` may be a webhook URL, else why not. */
export function webhookUrlRefusal(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) return `The URL is longer than ${MAX_URL_LENGTH} characters.`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Not a URL.'
  }
  if (url.protocol !== 'https:') return 'Only https URLs are allowed.'
  if (url.username || url.password) return 'The URL must not carry credentials.'
  if (url.port !== '' && url.port !== '443') return 'Only the default https port (443) is allowed.'
  if (url.hash) return 'The URL must not have a #fragment.'

  // WHATWG parsing has already turned 0x7f.1, 2130706433 and 127.1 into
  // dotted quads, so one pattern catches every IPv4 spelling.
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return 'Use a DNS name, not an IP address.'
  }
  if (!host.includes('.')) return 'The host must be a fully qualified public name.'
  const internal = INTERNAL_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`))
  if (internal) return `.${internal} hosts are internal-only.`
  return null
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null
}

/** [first octet, second-octet floor, second-octet ceiling] or a whole /8. */
const PRIVATE_V4: [number, number, number][] = [
  [0, 0, 255], // this network
  [10, 0, 255],
  [100, 64, 127], // carrier-grade NAT
  [127, 0, 255],
  [169, 254, 254], // link-local, cloud metadata
  [172, 16, 31],
  [192, 168, 168],
  [198, 18, 19], // benchmarking
]

function isPrivateV4([a, b, c]: number[]): boolean {
  if (a! >= 224) return true // multicast and reserved
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  return PRIVATE_V4.some(([first, lo, hi]) => a === first && b! >= lo && b! <= hi)
}

function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  // A trailing dotted quad (::ffff:10.0.0.1) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const octets = ipv4Octets(v4[1]!)
    if (!octets) return null
    text =
      text.slice(0, -v4[1]!.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (s: string) => (s ? s.split(':').map((g) => parseInt(g, 16)) : [])
  const head = parse(halves[0]!)
  const tail = halves.length === 2 ? parse(halves[1]!) : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const groups = [...head, ...Array<number>(fill).fill(0), ...tail]
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** True for an address no webhook should resolve to: private, loopback, link-local, reserved. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Octets(ip)
  if (v4) return isPrivateV4(v4)
  const g = expandV6(ip)
  if (!g) return true // unparseable: refuse rather than guess
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  const embeddedV4 = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]
  // ::ffff:a.b.c.d and 64:ff9b::a.b.c.d carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(embeddedV4)
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(embeddedV4)
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  return false
}

/** Null when every address a name resolved to is public, else why not. */
export function addressRefusal(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return 'The host does not resolve.'
  const bad = addresses.find(isPrivateAddress)
  return bad ? `The host resolves to a private or reserved address (${bad}).` : null
}
