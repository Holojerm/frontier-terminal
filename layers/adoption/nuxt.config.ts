// The adoption layer: demand for the labs outside their own numbers (OpenRouter rankings,
// implied spend share, Ramp AI Index, npm/PyPI downloads, GitHub coding-agent PRs).
// Builds on core and reads reliability's OpenRouter id-to-lab map (domains.config.ts);
// registers its lanes, recipes, MCP tools and export tables through server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'adoption' },
})
