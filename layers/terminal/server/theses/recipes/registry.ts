// Every recipe the survey tick runs. Adding one is a file in this folder, a
// fixture under fixtures/recipes/ with its test, and a line here.

import { CLOUDFLARE_CHANGELOG } from './cloudflare-changelog'
import type { Recipe } from './contract'
import { EPOCH_DATA_CENTERS, EPOCH_DATA_CENTER_TIMELINES } from './epoch-data-centers'
import { GITHUB_AGENT_RECIPES } from './github-agent-prs'
import { GPU_AZURE, GPU_ORACLE } from './gpu-apis'
import {
  GPU_COREWEAVE,
  GPU_CRUSOE,
  GPU_DIGITALOCEAN,
  GPU_LAMBDA,
  GPU_NEBIUS,
  GPU_TOGETHER,
  GPU_VERDA,
} from './gpu-pages'
import { GREENHOUSE_CLOUDFLARE } from './greenhouse-departments'
import { INVESTEE_RECIPES } from './investee-facts'
import { NPM_LAB_RECIPES, NPM_WRANGLER } from './npm-downloads'
import { PAY_RECIPES } from './pay-bands'
import { PYPI_LAB_RECIPES } from './pypi-downloads'
import { RAMP_AI_INDEX } from './ramp-ai-index'
import { RATE_LIMIT_RECIPES } from './rate-limits'
import {
  SEC_REVENUE_AKAM,
  SEC_REVENUE_CRWV,
  SEC_REVENUE_FSLY,
  SEC_REVENUE_NET,
} from './sec-revenue'

/** The GPU rental price recipes the Compute thesis takes its medians over. */
export const GPU_RECIPES: readonly Recipe[] = [
  GPU_LAMBDA,
  GPU_COREWEAVE,
  GPU_NEBIUS,
  GPU_CRUSOE,
  GPU_TOGETHER,
  GPU_DIGITALOCEAN,
  GPU_VERDA,
  GPU_AZURE,
  GPU_ORACLE,
]

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
  ...PYPI_LAB_RECIPES,
  ...GITHUB_AGENT_RECIPES,
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
  // Parents' filings, rate limits and posted pay, audited 2026-11-04.
  ...INVESTEE_RECIPES,
  ...RATE_LIMIT_RECIPES,
  ...PAY_RECIPES,
]
