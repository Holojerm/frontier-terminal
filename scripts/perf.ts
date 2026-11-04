// Page-load harness — `bun run perf`. Not a CI gate: one network's numbers are
// too noisy to fail a build on. Run it before and after a performance change.
//
// Each run is a fresh browser context (empty HTTP cache) on a throttled
// mid-tier-phone profile, so the numbers are a first visit's, not a
// repeat visitor's. Reports the median of --runs per route, plus what the
// server said about the document: x-html-cache (hit/miss) and Server-Timing
// (layers/terminal/server/utils/server-timing.ts) — a long TTFB is only
// actionable once you know which stage it was spent in.
//
// Real visitors on this site almost always miss the HTML cache: it is per data
// centre and its key rotates on every poll. A run against a warm cache
// therefore flatters the site. --bust appends a query string, which the HTML
// cache refuses to key on, so every run renders.
//
//   bun run perf                                   # prod, 3 runs per route
//   bun run perf --base https://x.localhost --runs 5
//   bun run perf --routes /,/prices --bust
//   bun run perf --out before.json   then   bun run perf --compare before.json

import { chromium, type Page } from '@playwright/test'
import { parseArgs } from 'node:util'

const DEFAULT_ROUTES = [
  '/',
  '/prices',
  '/prices/model:openai:tts-1',
  '/labs/anthropic',
  '/theses',
  '/theses/anthropic',
  '/hiring',
  '/revenue',
  '/incidents',
  '/disclosures',
  '/rankings',
  '/releases',
  '/alerts',
  '/data',
  '/about',
]

/** Slow 4G with a 4x CPU slowdown — Lighthouse's mobile profile, roughly. */
const THROTTLE = { latencyMs: 150, downKbps: 1600, upKbps: 750, cpu: 4 }

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://frontierterm.com' },
    runs: { type: 'string', default: '3' },
    routes: { type: 'string' },
    bust: { type: 'boolean', default: false },
    'no-throttle': { type: 'boolean', default: false },
    out: { type: 'string' },
    compare: { type: 'string' },
  },
})

const base = values.base.replace(/\/$/, '')
const runs = Math.max(1, Number(values.runs) || 3)
const routes = values.routes ? values.routes.split(',') : DEFAULT_ROUTES

interface Run {
  ttfb: number
  fcp: number
  lcp: number
  load: number
  jsKB: number
  cssKB: number
  totalKB: number
  requests: number
  htmlCache: string
  serverTiming: string
}

type Metric = Exclude<keyof Run, 'htmlCache' | 'serverTiming'>
const METRICS: Metric[] = ['ttfb', 'fcp', 'lcp', 'load', 'jsKB', 'cssKB', 'totalKB', 'requests']

interface RouteResult {
  route: string
  median: Record<Metric, number>
  runs: Run[]
}

async function measure(page: Page, url: string): Promise<Run> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  if (!values['no-throttle']) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: THROTTLE.latencyMs,
      downloadThroughput: (THROTTLE.downKbps * 1024) / 8,
      uploadThroughput: (THROTTLE.upKbps * 1024) / 8,
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpu })
  }

  const types = new Map<string, string>()
  const bytes = { js: 0, css: 0, total: 0, requests: 0 }
  cdp.on('Network.responseReceived', (e) => types.set(e.requestId, e.type))
  cdp.on('Network.loadingFinished', (e) => {
    const type = types.get(e.requestId)
    bytes.total += e.encodedDataLength
    bytes.requests++
    if (type === 'Script') bytes.js += e.encodedDataLength
    if (type === 'Stylesheet') bytes.css += e.encodedDataLength
  })

  const response = await page.goto(url, { waitUntil: 'networkidle' })
  if (!response || response.status() !== 200) {
    throw new Error(`${url} answered ${response?.status() ?? 'nothing'}`)
  }
  const headers = response.headers()

  const timing = await page.evaluate(
    () =>
      new Promise<{ ttfb: number; fcp: number; lcp: number; load: number }>((resolve) => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1
        const done = (lcp: number) =>
          resolve({ ttfb: nav.responseStart, fcp, lcp, load: nav.loadEventEnd })
        new PerformanceObserver((list) => {
          const entries = list.getEntries()
          done(entries[entries.length - 1]!.startTime)
        }).observe({ type: 'largest-contentful-paint', buffered: true })
        setTimeout(() => done(-1), 3000)
      }),
  )

  return {
    ...timing,
    jsKB: bytes.js / 1024,
    cssKB: bytes.css / 1024,
    totalKB: bytes.total / 1024,
    requests: bytes.requests,
    htmlCache: headers['x-html-cache'] ?? '-',
    serverTiming: headers['server-timing'] ?? '',
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const pad = (v: string | number, n: number) => String(v).padStart(n)

function printTable(results: RouteResult[], previous?: Map<string, RouteResult>): void {
  const width = Math.max(...results.map((r) => r.route.length), 5) + 2
  console.info(
    'route'.padEnd(width) +
      METRICS.map((m) => pad(m, 9)).join('') +
      '  cache  server-timing (run 1)',
  )
  for (const r of results) {
    const before = previous?.get(r.route)
    const cells = METRICS.map((m) => {
      const now = Math.round(r.median[m])
      if (!before) return pad(now, 9)
      const delta = now - Math.round(before.median[m])
      return pad(`${now}${delta === 0 ? '' : delta > 0 ? `+${delta}` : delta}`, 9)
    })
    const caches = r.runs.map((x) => x.htmlCache[0] ?? '-').join('')
    console.info(
      r.route.padEnd(width) +
        cells.join('') +
        '  ' +
        caches.padEnd(5) +
        '  ' +
        r.runs[0]!.serverTiming,
    )
  }
  if (previous) console.info('\n(+/- is the change against --compare; lower is better everywhere)')
}

const browser = await chromium.launch()
const results: RouteResult[] = []
try {
  for (const route of routes) {
    const sample: Run[] = []
    for (let i = 0; i < runs; i++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
      const page = await context.newPage()
      const url = base + route + (values.bust ? `?perf=${Date.now()}-${i}` : '')
      try {
        sample.push(await measure(page, url))
      } finally {
        await context.close()
      }
    }
    const result = {
      route,
      median: Object.fromEntries(
        METRICS.map((m) => [m, median(sample.map((s) => s[m]))]),
      ) as Record<Metric, number>,
      runs: sample,
    }
    results.push(result)
    console.error(`measured ${route}`)
  }
} finally {
  await browser.close()
}

let previous: Map<string, RouteResult> | undefined
if (values.compare) {
  const old = (await Bun.file(values.compare).json()) as { results: RouteResult[] }
  previous = new Map(old.results.map((r) => [r.route, r]))
}

console.info(
  `\n${base} — median of ${runs} cold-cache run(s)${values['no-throttle'] ? '' : ', throttled mobile'}${values.bust ? ', HTML cache bypassed' : ''}. ms and KB.\n`,
)
printTable(results, previous)

if (values.out) {
  await Bun.write(
    values.out,
    JSON.stringify(
      { base, runs, bust: values.bust, at: new Date().toISOString(), results },
      null,
      2,
    ),
  )
  console.info(`\nwrote ${values.out}`)
}
