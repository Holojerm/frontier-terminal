// PostHog product analytics and exception tracking, no session replay. An empty
// NUXT_PUBLIC_POSTHOG_KEY turns the whole plugin off.
//
// The SDK is imported after hydration rather than at module scope so it stays out
// of the entry chunk: this site's first paint is its product. Anything thrown
// before it arrives goes unreported, which is the price of that.

export default defineNuxtPlugin((nuxtApp) => {
  const key = useRuntimeConfig().public.posthogKey
  if (!key) return

  let captureException: ((error: Error, properties: Record<string, unknown>) => void) | undefined

  // `capture_exceptions` only sees window.onerror, and Vue swallows component
  // errors before they get there. A hook rather than config.errorHandler, because
  // Nuxt's error page depends on the handler it installs there.
  nuxtApp.hook('vue:error', (err, instance, info) => {
    captureException?.(err instanceof Error ? err : new Error(String(err)), {
      vue_component: instance?.$options?.__name,
      vue_info: info,
    })
  })

  onNuxtReady(async () => {
    // Rejects when a blocker drops the chunk; the site works the same without it.
    const posthog = await import('posthog-js').then((m) => m.default).catch(() => undefined)
    if (!posthog) return

    posthog.init(key, {
      // Same-origin relay, server/routes/ingest/[...path].ts: survives ad blockers
      // and keeps every *.posthog.com host out of the CSP.
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      // Includes `capture_pageview: 'history_change'`, which follows the Vue router.
      defaults: '2026-08-30',

      // No accounts here, so every visitor stays anonymous and costs no profile.
      person_profiles: 'identified_only',

      capture_exceptions: true,
      capture_dead_clicks: true,

      // Explicit, because a project setting would otherwise switch these on with
      // no deploy, and /about tells visitors they are off.
      disable_session_recording: true,
      enable_heatmaps: false,
      capture_performance: false,

      loaded: (ph) => {
        if (import.meta.dev) ph.opt_out_capturing()
      },
    })

    captureException = (error, properties) => posthog.captureException(error, properties)
  })
})
