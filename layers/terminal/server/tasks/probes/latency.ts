// Cron task: one latency probe per lab, hourly at :07, in an invocation of its
// own so no other task's requests share its connections
// (layers/terminal/server/pipeline/probes/run.ts). A probe that failed because
// of our key, credit or request is spooled for the ops digest; a lab's own
// failures are the data. So is a lab skipped because its flagship's model
// could not be settled or would break the budget (pipeline/probes/resolve.ts).
//
// To run one locally: put NUXT_OPENROUTER_API_KEY in .env, start the dev server,
// and open /_nitro/tasks/probes:latency. It spends real credit (about two cents).

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { blobRawReader } from '../../pipeline/judge/class-map'
import { blobRawStore } from '../../pipeline/poll'
import { probeOrigin, runProbes } from '../../pipeline/probes/run'
import { withHeartbeat } from '../../utils/task-heartbeat'

/** Spooled once per run in which a probe was refused for a reason of ours. */
export const PROBE_SETUP_FAILED_KIND = 'probe_setup_failed'

const task = defineTask({
  meta: {
    name: 'probes:latency',
    description: 'Send each lab’s flagship model one fixed streaming request and time it',
  },
  async run() {
    const report = await runProbes(db, {
      fetch: (input, init) => fetch(input, init),
      clock: () => Date.now(),
      now: () => new Date(),
      apiKey: useRuntimeConfig().openrouterApiKey,
      raw: blobRawStore(blob),
      readRaw: blobRawReader(blob),
      ranFrom: import.meta.dev ? 'local' : await probeOrigin((input, init) => fetch(input, init)),
    })
    const setup = report.probes.filter((p) => p.outcome === 'setup')
    if (setup.length > 0) {
      await recordOpsEvent(db, {
        kind: PROBE_SETUP_FAILED_KIND,
        detail: `${setup.map((p) => p.lab).join(', ')}: ${setup[0]!.detail ?? 'refused'}`,
      })
    }
    return { result: report }
  },
})

export default withHeartbeat(task)
