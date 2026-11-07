// Table density moves layout, so it is set on <html> before first paint
// instead of after hydration like the other reader settings: an inline head
// script reads the stored choice, the way color mode's guard does. The
// tables style both densities with `in-data-[density=compact]:`, so Vue never
// renders a different class and hydration has nothing to disagree about.
// CSP already allows inline scripts for the color-mode guard (nuxt.config.ts).

import { PREFS_KEY } from '../../shared/utils/reader-prefs'

export default defineNuxtPlugin(() => {
  if (!import.meta.server) return
  useHead({
    script: [
      {
        key: 'reader-density',
        tagPosition: 'head',
        innerHTML: `try{if(JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})||'{}').density==='compact')document.documentElement.dataset.density='compact'}catch(e){}`,
      },
    ],
  })
})
