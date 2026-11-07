// GET /api/reliability — the feed's own track record for due diligence
// (/data#reliability): each source's good runs over 30 and 90 days and its
// longest gap, the periods our data was older than we say, EDGAR acceptance
// to alert for each filing a rule alerted on, each deploy's smoke test, and
// the corrections log (layers/terminal/server/utils/terminal-reliability.ts).
// Takes no input; `as_of` is refused, since the rollup is kept for the present.

import manifest from '~~/fleet.json'

import { repoSlug, workflowRunsUrl } from '../pipeline/reliability/deploys'
import { queryReliability, reliabilityStamp } from '../utils/terminal-reliability'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'reliability', limit: 60, windowSeconds: 60 })
  const repoUrl = manifest.links.github ?? ''
  const slug = repoSlug(repoUrl)
  const opts = {
    buildSha: useRuntimeConfig().public.buildSha || null,
    repoUrl,
    runsUrl: slug ? workflowRunsUrl(slug) : '',
  }
  // The rollup, deploy reads and filing records land between polls, so they key the cache too.
  const variant = await reliabilityStamp(terminalDb)
  return serveTerminal(event, 'reliability', (ctx) => queryReliability(terminalDb, ctx, opts), {
    variant,
  })
})
