// Cron task: the track record search for material alerts whose window has
// closed (layers/terminal/server/pipeline/track-record/search.ts): the newsroom
// side, and the GDELT side's search row once every GKG file in the window is
// read. Runs on the */5 tick and fetches nothing: the newsroom posts are
// stored by the poll, and the GDELT files are read on GitHub Actions
// (scripts/gdelt-search.ts).

import { db } from '@nuxthub/db'

import { runTrackRecordSearch } from '../../pipeline/track-record/search'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'track-record:search',
    description:
      'Search the lab newsrooms, and close the GDELT side once its files are read, for each material alert',
  },
  async run() {
    return { result: await runTrackRecordSearch(db, { now: () => new Date() }) }
  },
})

export default withHeartbeat(task)
