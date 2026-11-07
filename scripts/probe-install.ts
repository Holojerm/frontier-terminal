// Installs scripts/probe.ts on the Mac mini as a once-a-minute LaunchAgent.
//
//   bun run probe:install            # copy, write the plist, (re)load it
//   bun run probe:install --remove   # unload and delete the plist
//
// The probe runs from a copy in ~/agent-jobs/probe/, not from this checkout:
// agent sessions switch branches here, and com.holojerm.session-guard kills
// long-running processes under ~/code. Re-run this after changing the probe.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const LABEL = 'com.holojerm.probe.frontier-terminal'
const HOME = homedir()
const ROOT = resolve(import.meta.dir, '..')
const DEST = join(HOME, 'agent-jobs', 'probe', 'frontier-terminal')
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG = join(HOME, 'agent-jobs', 'logs', 'probe-frontier-terminal.log')
// The same PATH agent-jobs/run-job.sh uses: mise's shims resolve bun after an upgrade.
const PATH = `/opt/homebrew/bin:${HOME}/.local/share/mise/shims:/usr/bin:/bin:/usr/sbin:/sbin`
const DOMAIN = `gui/${process.getuid?.() ?? 501}`

function launchctl(...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

launchctl('bootout', `${DOMAIN}/${LABEL}`)

if (process.argv.includes('--remove')) {
  rmSync(PLIST, { force: true })
  console.warn(`removed ${LABEL}`)
  process.exit(0)
}

mkdirSync(join(DEST, 'lib'), { recursive: true })
mkdirSync(join(HOME, 'agent-jobs', 'logs'), { recursive: true })
copyFileSync(join(ROOT, 'scripts', 'probe.ts'), join(DEST, 'probe.ts'))
copyFileSync(join(ROOT, 'scripts', 'lib', 'probe-state.ts'), join(DEST, 'lib', 'probe-state.ts'))

writeFileSync(
  PLIST,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${HOME}/.local/share/mise/shims/bun</string><string>run</string><string>${join(DEST, 'probe.ts')}</string>
  </array>
  <key>WorkingDirectory</key><string>${DEST}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${PATH}</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`,
)

const loaded = launchctl('bootstrap', DOMAIN, PLIST)
if (loaded.status !== 0) {
  console.error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`)
  process.exit(1)
}
console.warn(`loaded ${LABEL}: every 60s, log ${LOG}`)
