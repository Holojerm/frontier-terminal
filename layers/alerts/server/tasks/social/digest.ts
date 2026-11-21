// Cron task: queue the weekly thread, Monday 13:00 UTC beside theses:digest
// (layers/alerts/server/pipeline/social.ts), then schedule a social drain on
// the EVENTS queue (layers/core/server/utils/events.ts) to send it. With no
// Buffer key it returns before touching the database.

import { enqueueWeeklyDigest } from '../../pipeline/social'

// The result type is spelled out because TypeScript infers it from the first
// `return` alone, and this task has two shapes.
const task = defineTask<{ skipped: 'unconfigured' } | { queued: number }>({
  meta: {
    name: 'social:digest',
    description: 'Queue the weekly what-moved thread for the social accounts',
  },
  async run() {
    const runtime = useRuntimeConfig()
    const config = readSocialConfig(runtime.social)
    if (!config) return { result: { skipped: 'unconfigured' } }
    const queued = await enqueueWeeklyDigest(db, config.channels, runtime.public.appUrl)
    if (queued) await scheduleDrain(kvStore, 'social.drain', FANOUT_SETTLE_SECONDS, new Date())
    return { result: { queued } }
  },
})

export default withHeartbeat(task)
