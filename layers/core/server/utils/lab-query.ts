// `?lab=` on the routes that cut an all-lab payload to one lab.

import { z } from 'zod'
import { LABS } from '../../shared/utils/lab-names'
import type { LabId } from '../../shared/types/common'

export const labQuerySchema = z.object({ lab: z.enum(LABS as [LabId, ...LabId[]]).optional() })
