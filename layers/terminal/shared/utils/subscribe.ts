// What the subscribe form and its routes agree on: the address shape, and the
// one path a signup is credited to.

import { z } from 'zod'

/** Lowercased and trimmed: the form the unique index sees. */
export const normalizeEmail = (value: string): string => value.trim().toLowerCase()

// Deliberately plain: one @, a dotted domain, no spaces. The confirmation mail
// is the real validation; this only keeps obvious junk out of the table.
const EMAIL = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]{2,}$/

export const subscribeBody = z.object({
  email: z
    .string()
    .max(254)
    .transform(normalizeEmail)
    .refine((v) => EMAIL.test(v), 'Enter a valid email address.'),
  /** The page the form sat on. Stored with its query stripped. */
  from: z.string().max(200).optional(),
  /** Honeypot: a person never sees this field, so any value means a bot. */
  website: z.string().max(200).optional(),
})
export type SubscribeBody = z.infer<typeof subscribeBody>

export const tokenBody = z.object({ token: z.string().min(16).max(256) })

/** A path worth keeping as "subscribed from": absolute, no query, no fragment. */
export function cleanFromPath(value: string | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null
  return value.split(/[?#]/)[0]!.slice(0, 120) || null
}
