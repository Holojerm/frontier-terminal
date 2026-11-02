// Extension points: the places core reads data that belongs to a product. A
// feature registers a contributor here instead of core importing its tables.
//
// This is a trimmed copy of the template's file. The template's also carries
// account-deletion, admin-view, onboarding and purge contributors; this app has
// no accounts, so only the fleet counter registry is kept, with the template's
// names and signatures so a later sync can swap the template's file in.
//
// A plain registry, not Nitro hooks: every consumer takes the Drizzle client as
// an argument so the workerd test suite can drive it without booting Nitro, and
// tests call the same register function a Nitro plugin does.

import type { drizzle } from 'drizzle-orm/d1'
import type * as tables from '../db/schema'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type ExtensionDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * Plain numbers a fork adds to `extra` in GET /api/fleet. `extra` is what the
 * fleet dashboard already renders generically, so a counter here needs no change
 * on the dashboard.
 */
export interface FleetExtraContributor {
  key: string
  /**
   * Counts only, like every fleet counter. Names must be unique across
   * contributors; on a clash the contributor registered later wins.
   */
  collect: (db: ExtensionDb, now: Date) => Promise<Record<string, number>>
}

// Keyed by contributor key, so registering twice (plugin + test, or a dev
// reload) replaces rather than duplicates.
const fleetExtraContributors = new Map<string, FleetExtraContributor>()

export function registerFleetExtraContributor(contributor: FleetExtraContributor): void {
  fleetExtraContributors.set(contributor.key, contributor)
}

export function getFleetExtraContributors(): FleetExtraContributor[] {
  return [...fleetExtraContributors.values()]
}

/** Test-only: forget every registration, to exercise core with no features. */
export function clearExtensionsForTest(): void {
  fleetExtraContributors.clear()
}
