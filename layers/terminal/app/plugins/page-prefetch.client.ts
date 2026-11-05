// Prefetch a page's data on link intent, so a client-side navigation does not
// start its API calls only at the click.
//
// NuxtLink already prefetches a route's JS when the link scrolls into view, but
// not its data: each page's useFetch calls run after the click, from the
// browser, and download the full API responses that a server render would
// have trimmed (13 calls and 3.2 s for /labs/anthropic on a throttled phone).
//
// On intent (a pointer resting on the link, focus, touchstart, mousedown) this
// asks /api/page-data for the target page's hydration payload: one request,
// served from the stamp-keyed HTML cache when the page is there, holding every
// useFetch result already transformed. On the navigation it hands that data to
// Nuxt through `nuxtApp.static.data`, the slot Nuxt's own payload plugin fills
// for prerendered routes and the one useFetch's default getCachedData reads on
// a client navigation. The seeded keys are removed once the page has rendered,
// so later navigations fetch fresh data.
//
// Each prefetch can be a page render, which spends the visitor's API rate
// limit on an HTML-cache miss, so a pointer has to rest on the link, a path
// runs once per TTL, concurrency and the per-minute count are capped, and
// Save-Data or slow connections are skipped.

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

type Entry = { at: number; data: Promise<Record<string, unknown> | null> }

export default defineNuxtPlugin((nuxtApp) => {
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

  /**
   * The path a link would navigate to, or null when it isn't one we prefetch.
   * A query string is skipped: the HTML cache refuses to key on one, so
   * /api/page-data does too.
   */
  const targetOf = (a: HTMLAnchorElement): string | null => {
    if (a.target && a.target !== '_self') return null
    if (a.hasAttribute('download')) return null
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin || url.search) return null
    if (url.pathname === router.currentRoute.value.path) return null
    return router.resolve(url.pathname).matched.length ? url.pathname : null
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
    const data = fetch(`/api/page-data?path=${encodeURIComponent(path)}`)
      .then((res) => (res.ok ? res.text() : null))
      .then(async (json) => {
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
    // A touch's pointerover lands with the tap itself; touchstart covers it.
    if (e instanceof PointerEvent && e.pointerType === 'touch') return
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
  document.addEventListener('touchstart', now, { passive: true })
  document.addEventListener('mousedown', now)

  let seeded: string[] = []
  router.beforeResolve(async (to) => {
    const entry = entries.get(to.path)
    if (!entry || Date.now() - entry.at > TTL_MS || Object.keys(to.query).length) return
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
