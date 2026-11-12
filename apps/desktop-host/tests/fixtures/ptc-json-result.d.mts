/** Exact rendering notice emitted by the production PTC tool on partially confined hosts. */
export const PARTIAL_SANDBOX_NOTICE: string

/**
 * Read one object payload while retaining only the exact known PTC notice.
 * @param content - Actual model-visible tool blocks.
 * @returns The validated object and its separately reported notices.
 */
export function parsePtcJsonResult(content: ReadonlyArray<{ type: string; text?: string }>): {
  value: Record<string, unknown>
  notices: string[]
}
