// Loads the reader's settings once hydration has finished, so the first
// client render matches the cached server HTML.

export default defineNuxtPlugin((nuxtApp) => {
  if (nuxtApp.isHydrating) nuxtApp.hooks.hookOnce('app:suspense:resolve', loadReaderPrefs)
  else loadReaderPrefs()
})
