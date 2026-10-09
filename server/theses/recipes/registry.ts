// Every recipe the survey tick runs. Adding one is a file in this folder, a
// fixture under fixtures/recipes/ with its test, and a line here.

import { CLOUDFLARE_CHANGELOG } from './cloudflare-changelog'
import type { Recipe } from './contract'
import { GREENHOUSE_CLOUDFLARE } from './greenhouse-departments'
import { NPM_WRANGLER } from './npm-downloads'
import { SEC_REVENUE_AKAM, SEC_REVENUE_FSLY, SEC_REVENUE_NET } from './sec-revenue'

export const RECIPES: readonly Recipe[] = [
  SEC_REVENUE_NET,
  SEC_REVENUE_AKAM,
  SEC_REVENUE_FSLY,
  NPM_WRANGLER,
  GREENHOUSE_CLOUDFLARE,
  CLOUDFLARE_CHANGELOG,
]
