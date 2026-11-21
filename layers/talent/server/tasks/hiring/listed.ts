// Cron task: the listed companies' job boards, daily at 04:00 UTC beside
// seo:indexnow (layers/talent/server/listed-hiring/read.ts). One request per
// board, in turn; Google's board is read from the careers lane's archived
// copy of its feed, streamed, so it costs no request and the ~20 MB file is
// never held whole. Daily is enough: a board's count moves over weeks.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { userAgentFor } from '#layers/core/server/utils/pipeline-fetch'
import { runListedHiring } from '../../listed-hiring/read'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'hiring:listed',
    description: 'Read the listed companies’ job boards and class each role',
  },
  async run() {
    const config = useRuntimeConfig()
    const results = await runListedHiring(db, {
      put: async (key, body, contentType) => {
        await blob.put(key, body, { contentType })
      },
      stream: async (key) => {
        const object = await blob.get(key)
        return object ? object.stream() : null
      },
      userAgent: userAgentFor('https://boards-api.greenhouse.io/', {
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      })!,
      now: new Date(),
    })
    return { result: results }
  },
})

export default withHeartbeat(task)
