// Every recipe the survey tick runs. Adding one is a file in this folder, a
// fixture under fixtures/recipes/ with its test, and a line here.

import { CLOUDFLARE_CHANGELOG } from './cloudflare-changelog'
import type { Recipe } from './contract'
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
import { NPM_WRANGLER } from './npm-downloads'
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
]
