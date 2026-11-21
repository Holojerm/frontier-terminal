// Cron task: the earnings-call reader, hourly at :07 (layers/companies/server/calls/ingest.ts).
// A call's release reaches EDGAR within minutes and its transcript within a
// day or two, so an hourly read puts first_seen_at within the hour. Each
// AssemblyAI job submitted on one run is collected on a later one.

import { runCallReads } from '../../calls/ingest'
import { paceSec } from '#layers/core/server/pipeline/sec-pace'

const task = defineTask({
  meta: {
    name: 'calls:read',
    description:
      'Read earnings-call exhibits, transcripts and AssemblyAI replays; store guidance and score it against later filings',
  },
  async run() {
    const config = useRuntimeConfig()
    const ua = { secContactEmail: config.secContactEmail, appUrl: config.public.appUrl }
    const result = await runCallReads(db, {
      raw: blobRawStore(blob),
      readRaw: blobRawReader(blob),
      fetcher: paceSec(createFetcher(ua)),
      userAgent: (url) => userAgentFor(url, ua),
      assemblyKey: config.assemblyaiApiKey,
      now: new Date(),
    })
    return { result }
  },
})

export default withHeartbeat(task)
