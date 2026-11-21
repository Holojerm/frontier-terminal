// The tracked labs by name: how a reader sees each id, each lab's homepage,
// and the vendor spellings other sources use for them.

import type { LabId, ProviderId } from '../types/common'

/** The tracked labs, in the registry order every page lists them in. */
export const LABS: readonly LabId[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'meta',
  'mistral',
  'deepseek',
  'alibaba',
  'moonshot',
] as const

export const labPath = (lab: LabId) => `/labs/${lab}`

export function isLab(s: string): s is LabId {
  return (LABS as readonly string[]).includes(s)
}

export const LAB_DISPLAY: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  meta: 'Meta',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  moonshot: 'Moonshot AI',
  other: 'Other',
}

/** Each lab's own homepage: the identity a lab page's structured data points at. */
export const LAB_SITE: Record<Exclude<ProviderId, 'other'>, string> = {
  openai: 'https://openai.com',
  anthropic: 'https://www.anthropic.com',
  google: 'https://ai.google',
  xai: 'https://x.ai',
  meta: 'https://ai.meta.com',
  mistral: 'https://mistral.ai',
  deepseek: 'https://www.deepseek.com',
  alibaba: 'https://qwen.ai',
  moonshot: 'https://www.moonshot.ai',
}

/** A provider id as a reader sees it; an id outside the registry reads as itself. */
export const labName = (id: string): string => (LAB_DISPLAY as Record<string, string>)[id] ?? id

/** Ramp's and Epoch's vendor names → the terminal's labs. */
export const LAB_OF_NAME: Readonly<Record<string, LabId>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  xai: 'xai',
  spacexai: 'xai',
  'mistral-ai': 'mistral',
  mistral: 'mistral',
  google: 'google',
  'google-deepmind': 'google',
  meta: 'meta',
  deepseek: 'deepseek',
  alibaba: 'alibaba',
  'moonshot-ai': 'moonshot',
}
