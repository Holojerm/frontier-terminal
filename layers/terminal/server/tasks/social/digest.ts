// Cron task: queue the weekly thread, Monday 13:00 UTC beside theses:digest
// (layers/terminal/server/pipeline/social.ts). The next `social:post` tick
// sends it. With no Buffer key it returns before touching the database.

import { db } from '@nuxthub/db'

import { readSocialConfig } from '#layers/social/server/utils/social'
import { enqueueWeeklyDigest } from '../../pipeline/social'

export default defineTask({
  meta: {
    name: 'social:digest',
    description: 'Queue the weekly what-moved thread for the social accounts',
  },
  async run() {
    const runtime = useRuntimeConfig()
    const config = readSocialConfig(runtime.social)
    if (!config) return { result: { skipped: 'unconfigured' } }
    const queued = await enqueueWeeklyDigest(db, config.channels, runtime.public.appUrl)
    return { result: { queued } }
  },
})
