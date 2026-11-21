// Every recipe the survey tick runs, in run order: the app's composition root
// for recipes (core's coverage and run code read it from here). Adding one is a
// file in its domain's recipes folder, a fixture under fixtures/recipes/ with
// its test, and a line here.

import { CLOUDFLARE_CHANGELOG } from '#layers/terminal/server/theses/recipes/cloudflare-changelog'
import type { Recipe } from '#layers/core/server/recipes/contract'
import { EARNINGS_RELEASE_RECIPES } from '#layers/compute/server/recipes/earnings-releases'
import { EPOCH_CHIP_TYPES, EPOCH_CHIP_USERS } from '#layers/compute/server/recipes/epoch-chip-users'
import {
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
} from '#layers/compute/server/recipes/epoch-data-centers'
import { GITHUB_AGENT_RECIPES } from '#layers/terminal/server/theses/recipes/github-agent-prs'
import { GPU_RECIPES } from '#layers/compute/server/recipes/gpu-recipes'
import { GREENHOUSE_CLOUDFLARE } from '#layers/terminal/server/theses/recipes/greenhouse-departments'
import { INVESTEE_RECIPES } from '#layers/terminal/server/theses/recipes/investee-facts'
import { MLPERF_INFERENCE } from '#layers/compute/server/recipes/mlperf-inference'
import { NEWSROOM_RECIPES } from '#layers/terminal/server/pipeline/track-record/newsrooms'
import {
  NPM_CONTROL_RECIPES,
  NPM_LAB_RECIPES,
  NPM_WRANGLER,
} from '#layers/terminal/server/theses/recipes/npm-downloads'
import { PAY_RECIPES } from '#layers/terminal/server/theses/recipes/pay-bands'
import { PYPI_LAB_RECIPES } from '#layers/terminal/server/theses/recipes/pypi-downloads'
import { RAMP_AI_INDEX } from '#layers/terminal/server/theses/recipes/ramp-ai-index'
import { RATE_LIMIT_RECIPES } from '#layers/pricing/server/recipes/rate-limits'
import {
  SEC_REVENUE_AKAM,
  SEC_REVENUE_CRWV,
  SEC_REVENUE_FSLY,
  SEC_REVENUE_NET,
} from '#layers/terminal/server/theses/recipes/sec-revenue'

export const RECIPES: readonly Recipe[] = [
  SEC_REVENUE_NET,
  SEC_REVENUE_AKAM,
  SEC_REVENUE_FSLY,
  NPM_WRANGLER,
  GREENHOUSE_CLOUDFLARE,
  CLOUDFLARE_CHANGELOG,
  SEC_REVENUE_CRWV,
  ...GPU_RECIPES,
  // Demand and supply beside OpenRouter, audited 2026-11-04 (docs/source-audit.md).
  RAMP_AI_INDEX,
  ...NPM_LAB_RECIPES,
  // Non-AI packages the npm series are divided by, added 2026-11-20.
  ...NPM_CONTROL_RECIPES,
  ...PYPI_LAB_RECIPES,
  ...GITHUB_AGENT_RECIPES,
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
  // Parents' filings, rate limits and posted pay, audited 2026-11-04.
  ...INVESTEE_RECIPES,
  ...RATE_LIMIT_RECIPES,
  ...PAY_RECIPES,
  // The labs' newsroom feeds the track record reads, audited 2026-11-04.
  ...NEWSROOM_RECIPES,
  // What the utilization read divides: stated token volume, benchmark
  // throughput, estimated compute and CoreWeave's active power, audited 2026-11-19.
  ...EARNINGS_RELEASE_RECIPES,
  MLPERF_INFERENCE,
  EPOCH_CHIP_USERS,
  EPOCH_CHIP_TYPES,
]
