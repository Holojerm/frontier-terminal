// Prefetch a page's data on link intent, so a client-side navigation does not
// start its API calls only at the click.
//
// NuxtLink already prefetches a route's JS when the link scrolls into view, but
// not its data: each page's useFetch calls run after the click, from the
// browser, and download the full API responses that a server render would
// have trimmed (13 calls and 3.2 s for /labs/anthropic on a throttled phone).
//
// On intent (a pointer resting on the link, focus, touchstart, mousedown) this
// fetches the target page's HTML: one request, often an HTML-cache hit, whose
// embedded payload already holds every useFetch result, transformed. On the
// navigation it hands that data to Nuxt through `nuxtApp.static.data`, the slot
// Nuxt's own payload plugin fills for prerendered routes and the one useFetch's
// default getCachedData reads on a client navigation. The seeded keys are
// removed once the page has rendered, so later navigations fetch fresh data.
//
// Why not Nuxt's native payload extraction: it needs `cache`/`swr` route
// rules, which also turn on Nitro's response cache and fight the HTML cache
// keyed on build and poll stamp (layers/terminal/server/utils/html-cache.ts).
//
// Each prefetch is a page render, which spends the visitor's API rate limit
// on an HTML-cache miss, so it waits for a resting pointer, runs once per path
// per TTL, caps concurrency, and skips Save-Data connections.
//
// Desktop-class intent only. Measured on a throttled phone, a tap gives about
// 100 ms of lead and the HTML (markup and inline CSS as well as the payload)
// outweighs the API calls it replaces, so touch and slow connections keep the
// plain path. Unthrottled, a 250 ms hover took /hiring 539 -> 118 ms and
// /revenue 655 -> 129 ms (2026-11-04).

// `parsePayload` is Nuxt's own reviver-aware payload parser; it is not part of
// the public `#app` exports, so this reaches into the composable directly.
import { parsePayload } from '#app/composables/payload'

const HOVER_MS = 80
const TTL_MS = 30_000
const MAX_INFLIGHT = 3
/**
 * Prefetches per rolling minute. The anonymous budget is 60 reads a minute per
 * IP per route, and a page render on an HTML-cache miss spends one on each
 * route the page calls; a pointer swept across a menu should not spend them.
 */
const MAX_PER_MINUTE = 8
const WAIT_ON_NAVIGATION_MS = 4_000
const PAYLOAD_RE = /<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

type Entry = { at: number; data: Promise<Record<string, unknown> | null> }

export default defineNuxtPlugin((nuxtApp) => {
  // A touch screen also fires mousedown, just before the click: no lead at all,
  // and the navigation would then wait on the heavier HTML.
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return
  const router = useRouter()
  const entries = new Map<string, Entry>()
  const started: number[] = []
  let inflight = 0

  /** Save-Data, or a connection the browser rates slower than 4g. */
  const constrained = () => {
    const c = (
      navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection
    return c?.saveData === true || (c?.effectiveType !== undefined && c.effectiveType !== '4g')
  }

  /** The router path a link would navigate to, or null when it isn't one we prefetch. */
  const targetOf = (a: HTMLAnchorElement): string | null => {
    if (a.target && a.target !== '_self') return null
    if (a.hasAttribute('download')) return null
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin) return null
    const path = url.pathname + url.search
    if (path === router.currentRoute.value.fullPath.split('#')[0]) return null
    const resolved = router.resolve(path)
    return resolved.matched.length ? resolved.fullPath.split('#')[0]! : null
  }

  const prefetch = (path: string) => {
    const hit = entries.get(path)
    if (hit && Date.now() - hit.at < TTL_MS) return
    if (inflight >= MAX_INFLIGHT || constrained()) return
    const minuteAgo = Date.now() - 60_000
    while (started.length && started[0]! < minuteAgo) started.shift()
    if (started.length >= MAX_PER_MINUTE) return
    started.push(Date.now())
    inflight += 1
    const data = fetch(path, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : null))
      .then(async (html) => {
        const json = html?.match(PAYLOAD_RE)?.[1]
        if (!json) return null
        const payload = (await parsePayload(json)) as { data?: Record<string, unknown> }
        return payload.data ?? null
      })
      .catch(() => null)
      .finally(() => {
        inflight -= 1
      })
    entries.set(path, { at: Date.now(), data })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: HTMLAnchorElement | null = null
  const anchorOf = (e: Event) =>
    (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const now = (e: Event) => {
    const a = anchorOf(e)
    const path = a && targetOf(a)
    if (path) prefetch(path)
  }
  const soon = (e: Event) => {
    if (e instanceof PointerEvent && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
    const a = anchorOf(e)
    if (!a || a === pending) return
    clearTimeout(timer)
    pending = a
    timer = setTimeout(() => {
      const path = targetOf(a)
      if (path) prefetch(path)
    }, HOVER_MS)
  }
  const cancel = (e: Event) => {
    if (pending && !pending.contains((e as PointerEvent).relatedTarget as Node | null)) {
      clearTimeout(timer)
      pending = null
    }
  }
  document.addEventListener('pointerover', soon, { passive: true })
  document.addEventListener('pointerout', cancel, { passive: true })
  document.addEventListener('focusin', soon)
  document.addEventListener('mousedown', now)

  let seeded: string[] = []
  router.beforeResolve(async (to) => {
    const entry = entries.get(to.fullPath.split('#')[0]!)
    if (!entry || Date.now() - entry.at > TTL_MS) return
    const data = await Promise.race([
      entry.data,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_ON_NAVIGATION_MS)),
    ])
    if (!data) return
    for (const key in data) {
      if (key in nuxtApp.static.data) continue
      nuxtApp.static.data[key] = data[key]
      seeded.push(key)
    }
  })
  const unseed = () => {
    for (const key of seeded) delete nuxtApp.static.data[key]
    seeded = []
  }
  nuxtApp.hook('page:finish', unseed)
  nuxtApp.hook('app:error', unseed)
})
