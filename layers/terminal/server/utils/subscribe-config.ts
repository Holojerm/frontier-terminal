// Whether public subscriptions are switched on. They are inert until both the
// Resend key and the from address are set, so the feature can ship before the
// owner configures the provider: no form, 404s, no fan-out.

import type { H3Event } from 'h3'

export interface SubscribeConfig {
  apiKey: string
  /** Bare address on a domain verified in Resend. */
  from: string
  appName: string
  /** Canonical origin, no trailing slash. */
  appUrl: string
}

interface ConfigShape {
  resendApiKey?: string
  subscribeEmailFrom?: string
  public: { appName: string; appUrl: string }
}

export function subscribeConfig(config: ConfigShape): SubscribeConfig | null {
  const apiKey = config.resendApiKey?.trim()
  const from = config.subscribeEmailFrom?.trim()
  if (!apiKey || !from) return null
  return {
    apiKey,
    from,
    appName: config.public.appName,
    appUrl: config.public.appUrl.replace(/\/+$/, ''),
  }
}

/** The config for a subscribe route, or a 404 that says nothing about why. */
export function requireSubscribe(event: H3Event): SubscribeConfig {
  const cfg = subscribeConfig(useRuntimeConfig(event) as unknown as ConfigShape)
  if (!cfg) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return cfg
}
