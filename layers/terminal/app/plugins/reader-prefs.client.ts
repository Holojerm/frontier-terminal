// Loads the reader's settings once hydration has finished, so the first
// client render matches the cached server HTML, and keeps other tabs in step
// when the settings change in one of them.

import { PREFS_KEY, loadReaderPrefs } from '../composables/useReaderPrefs'

export default defineNuxtPlugin((nuxtApp) => {
  if (nuxtApp.isHydrating) nuxtApp.hooks.hookOnce('app:suspense:resolve', loadReaderPrefs)
  else loadReaderPrefs()
  window.addEventListener('storage', (e) => {
    if (e.key === PREFS_KEY || e.key === null) loadReaderPrefs()
  })
})
