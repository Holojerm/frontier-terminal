import type { Recipe } from '#layers/core/server/recipes/contract'
import { GPU_AZURE, GPU_ORACLE } from './gpu-apis'
import {
  GPU_COREWEAVE,
  GPU_CRUSOE,
  GPU_DIGITALOCEAN,
  GPU_GOOGLE_CLOUD,
  GPU_LAMBDA,
  GPU_NEBIUS,
  GPU_TOGETHER,
  GPU_VERDA,
} from './gpu-pages'

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
  GPU_GOOGLE_CLOUD,
]
