// The recipes each recipe-backed view reads, for its cache key. The views are
// their domains': the parents' filings the companies layer's (terminal-parents.ts),
// the rate limits the pricing layer's (terminal-limits.ts), posted pay the talent
// layer's (terminal-pay.ts) and adoption the adoption layer's (terminal-adoption.ts).

import { PARENT_RECIPE_IDS } from '../../../companies/server/utils/terminal-parents'
import { ADOPTION_RECIPE_IDS } from '#layers/adoption/server/utils/terminal-adoption'
import { LIMIT_RECIPE_IDS } from '#layers/pricing/server/utils/terminal-limits'
import { PAY_RECIPE_IDS } from '#layers/talent/server/utils/terminal-pay'

/** Every recipe the views read, for the cache key. */
export const VIEW_RECIPES = {
  adoption: ADOPTION_RECIPE_IDS,
  limits: LIMIT_RECIPE_IDS,
  pay: PAY_RECIPE_IDS,
  parents: PARENT_RECIPE_IDS,
} as const
