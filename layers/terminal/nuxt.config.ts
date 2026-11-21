// The terminal layer: the shell. What reads several domains at once and so belongs to none:
// the lab page and tear sheet, the compare pages, the home page's inputs, the axis pages that
// join domains (/revenue, /dependencies, /hiring, /incidents), /data with its dictionary, the
// site pages (/about, /license, /contact), the listed-company and utilization views, the
// ticks that run several domains' readers after one poll, the ops watch and fleet counters,
// the judge's alert screen, the crawler page lists and the OG cards. Fork-owned, not in
// layers.lock.json. It uses any layer below it (domains.config.ts) and nothing uses it: core
// and the app root reach it only through server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
})
