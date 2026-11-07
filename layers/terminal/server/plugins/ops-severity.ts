// Registers this app's ops event tiers with core's classifier
// (server/utils/ops-severity.ts). Plugins run once per isolate, before the
// fleet reads them through /api/fleet.
import { registerTerminalOpsSeverity } from '../utils/terminal-ops-severity'

export default defineNitroPlugin(() => {
  registerTerminalOpsSeverity()
})
