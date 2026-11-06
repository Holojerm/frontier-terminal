// Cron task: the newsroom side of the track record search, for material
// alerts whose window has closed (layers/terminal/server/pipeline/track-record/search.ts).
// Runs on the */5 tick and fetches nothing: the newsroom posts are already
// stored by the poll, and the GDELT side runs on GitHub Actions
// (scripts/gdelt-search.ts). A failure is spooled for the digest and never
// touches the poll.

import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { runTrackRecordSearch } from '../../pipeline/track-record/search'

export default defineTask({
  meta: {
    name: 'track-record:search',
    description: 'Search the lab newsrooms for the first report of each material alert',
  },
  async run() {
    const result = await runTrackRecordSearch(db, { now: () => new Date() }).catch(
      async (error: unknown) => {
        await recordOpsEvent(db, { kind: 'track_record_search_failed', detail: String(error) })
        return null
      },
    )
    return { result }
  },
})
