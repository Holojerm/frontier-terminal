// Cron task: one latency probe per lab, hourly at :07, in an invocation of its
// own so no other task's requests share its connections. The probes don't
// run here: the cron fires from whichever colo Cloudflare picks, so it asks
// each placement's Durable Object to run them from where it lives
// (layers/reliability/server/utils/probe-runner.ts, pipeline/probes/placement.ts).
// A probe that failed because of our key, credit or request is spooled for
// the ops digest; a lab's own failures are the data. So is a lab skipped
// because its flagship's model could not be settled or would break the
// budget (pipeline/probes/resolve.ts).
//
// To run one locally: put NUXT_OPENROUTER_API_KEY in .env, start the dev server,
// and open /_nitro/tasks/probes:latency. It probes in-process, stored as
// `unpinned`, and spends real credit (about two cents).

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
