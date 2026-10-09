// Every open thesis. Adding one is a new file beside anthropic.ts, its
// journal page under docs/theses/, and a line here.

import type { ThesisDef } from '#shared/utils/thesis-types'

import { ANTHROPIC_THESIS } from './anthropic'

export const THESES: readonly ThesisDef[] = [ANTHROPIC_THESIS]
