// The browser suites' server (playwright.config.ts › webServer): the production build
// under `wrangler dev`, on a local store filled from the committed fixtures.
//
// The built Worker rather than `nuxt dev`, which the 5 GB merge-queue VM SIGKILLed after
// the 23rd test in three runs in a row (2026-11-20). On the Mac mini, one worker as on CI,
// a run peaked at 5.6 GB with the dev server (2.7 GB of it) and peaks at 4.1–4.4 GB with this
// one (1.8 GB). It renders with no first-visit Vite compile, so there is no warm-up pass,
// and it is the runtime and the header set that ship.
//
//   1. `nuxt build`, alone, before anything else is running.
//   2. A fresh store (BROWSER_SUITE_STORE): the real migrations, applied by wrangler.
//   3. The fixture fill (fill.ts), in its own process so its memory is gone before 4.
//   4. `wrangler dev` on the build, on the same store. It never fires the crons.

import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.env.BROWSER_SUITE_PORT
const storeDir = process.env.BROWSER_SUITE_STORE
if (!port || !storeDir)
  throw new Error('run through playwright.config.ts, which sets the port and store')
// Absolute: wrangler runs from .output, and the fill from the checkout root.
const store = resolve(storeDir)

let child: ReturnType<typeof Bun.spawn> | undefined
// Playwright stops the server by signalling this process; wrangler and workerd go with it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    child?.kill(signal)
    process.exit(1)
  })
}

/** Runs a step to completion. `quiet` keeps its log out of the run unless it fails. */
async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
) {
  const output = opts.quiet ? 'pipe' : 'inherit'
  child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: output,
    stderr: output,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    opts.quiet ? new Response(child.stdout as ReadableStream).text() : '',
    opts.quiet ? new Response(child.stderr as ReadableStream).text() : '',
  ])
  if (code !== 0) {
    console.error(`${out}${err}`.slice(-4000))
    throw new Error(`${cmd.join(' ')} exited ${code}`)
  }
}

// BROWSER_SUITE_BUILD skips the server minify (nuxt.config.ts › nitro.minify), which took
// the build from 3.2 GB to 4.8 GB. V8 sizes its heap from physical memory, about 1.25 GB
// on the 5 GB VM, and the build's heap still peaks at 1.5 GB (a 1 GB cap fails, measured
// 2026-11-20), so the cap is raised and the machine's memory is the limit.
await run(['bunx', 'nuxt', 'build'], {
  env: { BROWSER_SUITE_BUILD: '1', NODE_OPTIONS: '--max-old-space-size=2048' },
})

rmSync(store, { recursive: true, force: true })
// From .output, as `deploy:ci` runs wrangler, so it reads the build's own wrangler.json.
await run(
  ['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', store],
  { cwd: '.output', quiet: true },
)
await run(
  ['bun', '--tsconfig-override=.nuxt/tsconfig.server.json', 'run', 'test/server/fill.ts', store],
  { quiet: true },
)
console.info('store filled from fixtures/')

await run(
  [
    'bunx',
    'wrangler',
    'dev',
    '--port',
    port,
    '--persist-to',
    store,
    '--show-interactive-dev-session=false',
    // Not real values: they only switch the subscribe form on so axe and the CSP suite
    // see it. Nothing in these suites submits it.
    '--var',
    'NUXT_RESEND_API_KEY:browser-suite-not-a-key',
    '--var',
    'NUXT_SUBSCRIBE_EMAIL_FROM:digest@example.test',
  ],
  { cwd: '.output' },
)
