// `bun run dev:poll` — fill the local store by running the poll tasks on the
// dev server you already have up (`bun dev` or `bun dev:app`).
//
//   bun run dev:poll              live: poll:survey and poll:careers, the same
//                                 fetches a production tick makes (~30s)
//   bun run dev:poll --fixtures   offline: dev:fixtures, the same pipeline over
//                                 the committed fixtures/ (deterministic)
//   --url <origin>                the dev server, when it is not one of the
//                                 defaults below (a worktree's portless host)
//
// Through the server's own task endpoint (/_nitro/tasks, dev only) rather than
// writing the file: the rows go through the running server's connection, so
// there is nothing to restart (.claude/docs/gotchas.md › bun dev caches its DB
// connection). The live poll needs NUXT_SEC_CONTACT_EMAIL in .env for the SEC
// sources and NUXT_OPENROUTER_API_KEY for the rankings; without them those
// sources record a failed or skipped run and every other page still fills.
// Alerts come from the cloud judge, not a poll: `bun run dev:seed` copies them.

import pkg from '../package.json' with { type: 'json' }

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const name = pkg.portless?.name ?? pkg.name
const candidates = [
  option('--url'),
  process.env.DEV_URL,
  `https://${name}.localhost`,
  'http://localhost:3000',
].filter((u): u is string => Boolean(u))

async function answering(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

let origin: string | undefined
for (const candidate of candidates) {
  if (await answering(candidate)) {
    origin = candidate.replace(/\/+$/, '')
    break
  }
}
if (!origin) {
  console.error(`No dev server answered at ${candidates.join(', ')}.`)
  console.error('Start one with `bun dev` (or `bun dev:app`), or pass --url <origin>.')
  process.exit(1)
}

const tasks = flag('--fixtures') ? ['dev:fixtures'] : ['poll:survey', 'poll:careers']

interface SourceLine {
  source_id: string
  status: string
  detail: string | null
}

/** The source reports, wherever a task's result nests them. */
function sourcesOf(value: unknown): SourceLine[] {
  if (Array.isArray(value)) return value.flatMap(sourcesOf)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record.sources) && record.sources.every((s) => s && typeof s === 'object')) {
    return record.sources as SourceLine[]
  }
  return Object.values(record).flatMap(sourcesOf)
}

for (const task of tasks) {
  const started = Date.now()
  const res = await fetch(`${origin}/_nitro/tasks/${task}`)
  const body = (await res.json().catch(() => null)) as unknown
  const seconds = Math.round((Date.now() - started) / 1000)
  if (!res.ok) {
    console.error(
      `${task}: HTTP ${res.status} after ${seconds}s`,
      JSON.stringify(body).slice(0, 500),
    )
    process.exitCode = 1
    continue
  }
  const sources = sourcesOf(body)
  const counts: Record<string, number> = {}
  for (const s of sources) counts[s.status] = (counts[s.status] ?? 0) + 1
  console.warn(`${task}: ${seconds}s, ${sources.length} sources ${JSON.stringify(counts)}`)
  // Failures name what is missing (an unset key, a 404), which is the line worth reading.
  const failed = sources.filter((s) => s.status === 'failed' || s.status === 'skipped')
  const reasons = new Map<string, string[]>()
  for (const s of failed) {
    const reason = s.detail ?? s.status
    reasons.set(reason, [...(reasons.get(reason) ?? []), s.source_id])
  }
  for (const [reason, ids] of reasons) {
    console.warn(`  ${reason}: ${ids.length} source(s), e.g. ${ids.slice(0, 3).join(', ')}`)
  }
}
