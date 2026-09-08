// How long a title and a description are allowed to be, in one place.
//
// scripts/check-seo.ts is the copy that fails a build, for `useSeo()` calls in
// app/pages/**.vue. Nothing here is Nuxt-specific, so both a Bun script and the
// app can import it. (`scripts/` reaches it by relative path — it is outside the
// `#shared` alias, which only exists inside a Nuxt build.)

/** Under ~50 characters is rarely a real sentence. */
export const DESCRIPTION_MIN = 50

/** Google renders roughly 155 characters of a description before truncating. */
export const DESCRIPTION_MAX = 160
