/** Reduce future frame batches only when image offload actually removes unviewed frame inputs. */

/**
 * Calculate a smaller batch when the requested oldest-image prefix removes pending frame evidence.
 * @param retained - Request-order retained input occurrences, each with the pending frame labels it shows: one for a
 *   frame image, one per pending tile for a grid page, none for other images.
 * @param offloadCount - Number of oldest retained occurrences the adapter requests omitted.
 * @param currentLimit - Existing per-Session batch limit.
 * @returns The unchanged limit for historical-image pressure, or a smaller positive limit for pending-frame loss.
 */
export function reviewBatchAfterOffload(retained: readonly (readonly string[])[], offloadCount: number, currentLimit: number): number {
  const pending = new Set(retained.flat())
  const remaining = new Set(retained.slice(offloadCount).flat())
  if (remaining.size === pending.size) return currentLimit
  return Math.min(currentLimit, Math.max(1, remaining.size))
}
