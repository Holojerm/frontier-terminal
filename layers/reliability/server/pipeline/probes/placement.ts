// Where the latency probes run. OpenRouter's edge runs near its caller, so a probe's time to
// first token includes the distance from wherever it left; unpinned, that was whichever
// Cloudflare colo ran the cron. Each placement is one Durable Object created with a location
// hint, the cron asks it to run the probes, and every request leaves from that object's colo.
//
// A placement is configuration: add 'weur' or 'apac' to PROBE_PLACEMENTS and the next run
// probes from there too, stored and rolled as a series of its own. Each one is another full
// set of probes, and they share PROBE_MONTHLY_BUDGET_USD (targets.ts), so raise the budget
// with it.
//
// A location hint is honoured only when the object is first created, and is best effort;
// every row records `ran_from`, the colo it actually left from.

/** Cloudflare's Durable Object location hints (developers.cloudflare.com/durable-objects/reference/data-location/). */
export const PROBE_LOCATIONS = {
  enam: 'eastern North America',
  wnam: 'western North America',
  sam: 'South America',
  weur: 'western Europe',
  eeur: 'eastern Europe',
  apac: 'Asia-Pacific',
  oc: 'Oceania',
  afr: 'Africa',
  me: 'the Middle East',
} as const

export type ProbeLocationHint = keyof typeof PROBE_LOCATIONS

/** Rows from before placement, or from a dev server: they left from wherever the run happened to be. */
export const UNPINNED = 'unpinned'

export type ProbePlacement = ProbeLocationHint | typeof UNPINNED

/**
 * Where the probes run: eastern North America only, until a few weeks of clean data say
 * whether Europe or Asia add anything. The first entry is the series /api/probes and the
 * theses read.
 */
export const PROBE_PLACEMENTS: readonly [ProbeLocationHint, ...ProbeLocationHint[]] = ['enam']

export const PRIMARY_PLACEMENT: ProbeLocationHint = PROBE_PLACEMENTS[0]

export const placementLabel = (placement: string): string =>
  placement in PROBE_LOCATIONS
    ? PROBE_LOCATIONS[placement as ProbeLocationHint]
    : 'whichever Cloudflare data center ran it'

export const isProbeLocation = (value: unknown): value is ProbeLocationHint =>
  typeof value === 'string' && Object.hasOwn(PROBE_LOCATIONS, value)

/** One object per placement. A new name, never reused: the hint only applies when the object is created. */
export const probeObjectName = (hint: ProbeLocationHint) => `probes-${hint}`

/**
 * The route the object runs the probes on (server/routes/_probes/run.post.ts).
 * It answers only inside the object; on the public Worker it is a 404.
 */
export const PROBE_RUN_PATH = '/_probes/run'

/** Spooled when a run would have probed from no fixed place: the binding is missing. Nothing is probed. */
export const PROBE_UNPINNED_KIND = 'probe_unpinned'
/** Spooled per placement whose object did not answer with a report. */
export const PROBE_PLACEMENT_FAILED_KIND = 'probe_placement_failed'

/** The part of a Durable Object namespace binding the cron uses. */
export interface ProbeNamespace {
  idFromName(name: string): unknown
  get(
    id: never,
    options: { locationHint: ProbeLocationHint },
  ): { fetch(request: Request): Promise<Response> }
}

/**
 * Whether this request is running inside a Durable Object. Nitro's
 * `cloudflare-durable` entry sets `durable` on the platform context only for
 * a request the object's own fetch handler received.
 */
export function insideDurableObject(context: object): boolean {
  const cloudflare = (context as { cloudflare?: unknown }).cloudflare as
    | { durable?: unknown }
    | undefined
  return cloudflare?.durable !== undefined && cloudflare.durable !== null
}

export interface PlacementRun<Report> {
  placement: ProbeLocationHint
  report: Report | null
  /** Why the object gave no report. */
  error: string | null
}

/**
 * Ask each placement's object to run the probes, all at once: each object has
 * its own connections, so one placement's probes never wait on another's.
 */
export async function dispatchProbes<Report>(
  namespace: ProbeNamespace,
  placements: readonly ProbeLocationHint[] = PROBE_PLACEMENTS,
): Promise<PlacementRun<Report>[]> {
  return Promise.all(
    placements.map(async (placement): Promise<PlacementRun<Report>> => {
      try {
        const stub = namespace.get(namespace.idFromName(probeObjectName(placement)) as never, {
          locationHint: placement,
        })
        const response = await stub.fetch(
          new Request(`https://probes.internal${PROBE_RUN_PATH}?placement=${placement}`, {
            method: 'POST',
          }),
        )
        if (!response.ok) {
          const body = (await response.text()).slice(0, 300)
          return { placement, report: null, error: `HTTP ${response.status}: ${body}` }
        }
        return { placement, report: (await response.json()) as Report, error: null }
      } catch (error) {
        return { placement, report: null, error: String(error).slice(0, 300) }
      }
    }),
  )
}
