// The terminal layer: Frontier Terminal's product code — the fetch pipeline, the thesis engine,
// the query layer, the pages and components, and their tables and tests. Fork-owned: authored
// here, not vendored, so not in layers.lock.json. Depends on core only; pipeline, theses and
// terminal import each other, so they are one layer.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
})
