// Which domain's sources ride which poll tick, in the order the tick polls
// them: the app's composition root for scopes. The policy (what each tick is,
// and that the survey takes everything the careers and filings ticks leave) is
// core's (layers/core/server/pipeline/scopes.ts). A scope with no entry polls
// nothing of its own; the survey has none.

import type { PollScope } from '#layers/core/server/pipeline/contracts'
import type { ScopeEntry } from '#layers/core/server/pipeline/scopes'
import { LAUNCH_SCOPE } from '#layers/pricing/server/pipeline/scopes'
import { CAREERS_SCOPE } from '#layers/talent/server/pipeline/scopes'
import { EDGAR_SCOPE, FILINGS_SCOPE } from '#layers/terminal/server/pipeline/scopes'

export const SCOPE_ENTRIES: Partial<Record<PollScope, readonly ScopeEntry[]>> = {
  edgar: [EDGAR_SCOPE, LAUNCH_SCOPE],
  careers: [CAREERS_SCOPE],
  filings: [FILINGS_SCOPE],
}
