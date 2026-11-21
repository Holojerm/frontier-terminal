// Mail to the owner's inbox: the weekly thesis digest and the press brief,
// never ops alerts (fleet sends those). Delivery is the `send_email` binding
// (OWNER_EMAIL), pinned in wrangler.toml to one verified address. The binding
// is passed in because Nitro hands a scheduled task the fetch handler's `env`,
// and `cloudflare:workers` does not resolve under Nuxt's server tsconfig.

/** The `send_email` binding's shape: only the call we make. */
interface SendEmailBinding {
  send(message: {
    to: string
    from: { name: string; email: string }
    subject: string
    html: string
    text: string
  }): Promise<unknown>
}

export interface OwnerMessage {
  subject: string
  html: string
  text: string
  /** What the message accounts for; carried for callers, not read here. */
  ids?: string[]
}

export type OwnerMailer = (message: OwnerMessage) => Promise<void>

/** A mailer, or null when the binding or its addresses are not configured. */
export function getOwnerMailer(env: Record<string, unknown> | undefined): OwnerMailer | null {
  const config = useRuntimeConfig()
  const to = config.ownerEmailTo
  const from = config.ownerEmailFrom
  const binding = env?.OWNER_EMAIL as SendEmailBinding | undefined

  if (!to || !from || !binding) return null

  const sender = { name: config.public.appName, email: from }
  return async (message) => {
    await binding.send({
      to,
      from: sender,
      subject: message.subject,
      html: message.html,
      text: message.text,
    })
  }
}
