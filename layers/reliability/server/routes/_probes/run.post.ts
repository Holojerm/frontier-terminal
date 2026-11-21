// POST /_probes/run?placement= runs the hourly latency probes, only inside the placement's
// Durable Object (layers/reliability/server/utils/probe-runner.ts › dispatchPinnedProbes
// sends it there). On the public Worker it is a 404, so no outside request can make the
// probes run from its own colo.

import { z } from 'zod'

import { PROBE_PLACEMENTS, insideDurableObject } from '../../pipeline/probes/placement'
import { probeOrigin } from '../../pipeline/probes/run'

const query = z.object({ placement: z.enum(PROBE_PLACEMENTS) })

export default defineEventHandler(async (event) => {
  if (!insideDurableObject(event.context)) throw createError({ statusCode: 404 })
  const { placement } = await getValidatedQuery(event, query.parse)
  return runProbesHere(placement, await probeOrigin((input, init) => fetch(input, init)))
})
