// The enforcement half of the security headers in nuxt.config.ts.
//
// A Content-Security-Policy is a promise about what the app loads, and the
// expensive failure is not "the policy is too weak" — it is "the policy is
// slightly too strong and something stopped working six weeks ago", or "someone
// added a host to make a build go green". Neither shows up in a unit test.
//
// So this suite runs a real browser against the real header and fails on any
// violation, and it pins the external-host list to exactly what this file says.

import { expect, test } from '@playwright/test'

import { recordConsole } from '../lib/console'

/** Every public route. One today; add a route here when a page lands. */
const ROUTES = ['/']

/**
 * ── `eval` refusals are fatal ────────────────────────────────────────────────
 *
 * Zod v4 feature-probed for its JIT compiler by calling `new Function("")`
 * inside a try/catch. This policy refuses it; zod caught the throw and fell
 * back to its interpreter, so validation was correct either way — but the
 * refusal was still *reported*, as a securitypolicyviolation and a console
 * error, on every page load for every visitor.
 *
 * app/plugins/00.zod-jitless.client.ts sets `z.config({ jitless: true })`,
 * which is zod's own switch for exactly this case, and the probe no longer
 * happens. With the only known-benign eval refusal gone, an eval violation is a
 * genuine regression — something new is calling `eval`/`new Function`, or the
 * plugin stopped running — and it fails like any other violation. If this
 * starts failing, find what is evaluating code; do NOT add `'unsafe-eval'`,
 * which the assertion at the bottom of this file exists to prevent.
 */

// The recorder — addInitScript registration, the securitypolicyviolation
// listener, the console/pageerror listeners — lives in test/lib/console.ts.

for (const route of ROUTES) {
  test(`${route} renders with no CSP violation`, async ({ page }) => {
    const recorder = recordConsole(page)
    await recorder.ready

    await page.goto(route)
    // Hydration and lazily-imported chunks load after first paint, and a chunk
    // is exactly the kind of thing a wrong `script-src` refuses.
    await page.waitForLoadState('networkidle')

    // Every violation counts, eval included — nothing is filtered out here.
    const blocking = await recorder.cspViolations()

    // Some blocks (a refused worker, a refused eval) surface only on the
    // console, so both channels are watched and both are fatal.
    const cspConsoleErrors = recorder.messages
      .filter((m) => m.type() === 'error' && /content security policy/i.test(m.text()))
      .map((m) => m.text())

    expect(
      blocking.map((v) => `${v.directive} blocked ${v.blockedURI} (${v.sourceFile})`),
      `CSP violations on ${route}. Either the page is loading something new, or ` +
        'the policy in nuxt.config.ts needs the source added — decide which before loosening it.',
    ).toEqual([])
    expect(cspConsoleErrors, `CSP console errors on ${route}`).toEqual([])
  })
}

test.describe('the headers are actually on the wire', () => {
  test('every security header is present on a document response', async ({ page }) => {
    const response = await page.goto('/')
    const headers = response!.headers()

    expect(headers['content-security-policy']).toBeTruthy()
    expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['x-content-type-options']).toBe('nosniff')

    // Not preload. It is a submission to a browser-vendor registry that is slow
    // and painful to reverse, so it stays the app owner's decision — if this
    // ever starts failing, someone added it on a domain that may not be ready.
    expect(headers['strict-transport-security']).not.toContain('preload')
  })

  test('the headers cover non-document routes too', async ({ request }) => {
    // routeRules is '/**', and nosniff on assets plus HSTS on API calls are the
    // reason. A narrower pattern would silently drop exactly these.
    const response = await request.get('/api/status')
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['strict-transport-security']).toBeTruthy()
  })
})

test.describe('the web app manifest', () => {
  // No `manifest-src` directive is set in nuxt.config.ts, so it falls back to
  // `default-src 'self'` — same-origin is already allowed. This is the check
  // that keeps it true: if the manifest or an icon it references ever moved
  // off-origin, "Add to Home Screen" would fail with nothing in this app's own
  // logs to explain why.
  test('/manifest.webmanifest is served with the right content type, and its icons resolve', async ({
    request,
  }) => {
    const manifestResponse = await request.get('/manifest.webmanifest')
    expect(manifestResponse.status()).toBe(200)
    expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json')

    const manifest = await manifestResponse.json()
    expect(manifest.icons.length).toBeGreaterThan(0)

    for (const icon of manifest.icons as { src: string }[]) {
      const iconResponse = await request.get(icon.src)
      expect(iconResponse.status(), `${icon.src} should 200`).toBe(200)
      expect(iconResponse.headers()['content-type']).toContain('image/png')
    }
  })
})

test.describe('the directives that make the policy worth having', () => {
  test('the anti-bypass directives are locked down', async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''

    // script-src carries 'unsafe-inline' (nuxt.config.ts explains why it has to),
    // and these are what keep that from being a blank cheque: object-src and
    // base-uri are the two classic ways to bypass a script-src, form-action
    // stops an injected form from posting off-origin, and frame-src 'none'
    // says this site frames nothing.
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
  })

  test("eval stays blocked — 'unsafe-eval' must never be added", async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''

    // The tempting "fix" for a noisy console is to add 'unsafe-eval' here —
    // which converts a harmless report into a genuine capability for anything
    // that achieves script injection.
    expect(
      csp,
      "'unsafe-eval' re-enables the exact class of attack this policy exists to stop",
    ).not.toContain('unsafe-eval')
  })

  test('no external origin has crept into script-src', async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? ''

    // The guard that makes this suite worth running after everyone has left:
    // adding a tag manager, a chat widget or a font CDN means adding a host
    // here, and that should be a decision someone makes on purpose — argued
    // for in nuxt.config.ts, not appended to make a build go green.
    const externalHosts = scriptSrc
      .split(/\s+/)
      .filter((source) => source.startsWith('http') || source.startsWith('//'))

    expect(externalHosts).toEqual([])
  })
})
