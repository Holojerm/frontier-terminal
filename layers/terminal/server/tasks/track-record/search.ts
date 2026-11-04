// Cron task: find press and newsroom candidates for material alerts whose
// window has closed (layers/terminal/server/pipeline/track-record/search.ts).
// Runs on the */5 tick with one GDELT query per run. A failure is spooled for
// the digest and never touches the poll.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { createFetcher } from '../../pipeline/fetch'
import { blobRawStore } from '../../pipeline/poll'
import { runTrackRecordSearch } from '../../pipeline/track-record/search'

export default defineTask({
  meta: {
    name: 'track-record:search',
    description: 'Search GDELT and the lab newsrooms for the first report of each material alert',
  },
  async run() {
    const config = useRuntimeConfig()
    const result = await runTrackRecordSearch(db, {
      raw: blobRawStore(blob),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
        // GDELT answers a burst with minutes of 429s; one attempt per run is the rate.
        attempts: 1,
      }),
      now: () => new Date(),
    }).catch(async (error: unknown) => {
      await recordOpsEvent(db, { kind: 'track_record_search_failed', detail: String(error) })
      return null
    })
    return { result }
  },
})
