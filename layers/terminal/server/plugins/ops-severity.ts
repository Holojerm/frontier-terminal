// Registers this app's ops event tiers with core's digest classifier
// (server/utils/ops-severity.ts). Plugins run once per isolate, before the
// ops:alert cron reads them to rank the digest and hold each tier.
import { registerTerminalOpsSeverity } from '../utils/terminal-ops-severity'

export default defineNitroPlugin(() => {
  registerTerminalOpsSeverity()
})
