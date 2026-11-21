// The median the press series, the ground truth and the call guidance take of
// their figures.

/** The middle value; the mean of the middle two for an even count. */
export function middle(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
