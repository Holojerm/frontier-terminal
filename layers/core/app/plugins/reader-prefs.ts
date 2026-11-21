// Table density moves layout, so an inline head script sets it on <html> before
// first paint (the way color mode's guard does) instead of after hydration. The
// tables style both densities with `in-data-[density=compact]:`, so Vue never
// renders a different class. CSP already allows inline scripts for the color-mode
// guard (nuxt.config.ts).

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
