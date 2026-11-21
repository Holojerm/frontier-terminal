// Cron task: one latency probe per lab, hourly at :07, in its own invocation so no other
// task's requests share its connections. The cron fires from whichever colo Cloudflare
// picks, so it asks each placement's Durable Object to run the probes where it lives
// (layers/reliability/server/utils/probe-runner.ts, pipeline/probes/placement.ts).
// Failures over our key, credit or request are spooled for the ops digest, as is a lab
// skipped because its flagship's model could not be settled or would break the budget
// (pipeline/probes/resolve.ts). A lab's own failures are the data.
//
// Local run: put NUXT_OPENROUTER_API_KEY in .env, start the dev server, and open
// /_nitro/tasks/probes:latency. It probes in-process, stored as `unpinned`, and spends real
// credit (about two cents).

import { UNPINNED } from '../../pipeline/probes/placement'
import type { ProbeRunReport } from '../../pipeline/probes/run'

const task = defineTask({
  meta: {
    name: 'probes:latency',
    description: 'Send each lab’s flagship model one fixed streaming request and time it',
  },
  async run({ context }): Promise<{ result: ProbeRunReport | PinnedProbeResult }> {
    if (import.meta.dev) return { result: await runProbesHere(UNPINNED, 'local') }
    const env = (context as { cloudflare?: { env?: Record<string, unknown> } }).cloudflare?.env
    return { result: await dispatchPinnedProbes(db, env) }
  },
})

export default withHeartbeat(task)
