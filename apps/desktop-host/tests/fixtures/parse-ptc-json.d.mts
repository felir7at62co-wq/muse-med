/** JSON-only fixture output retains its actual model-visible enforcement notice. */
/**
 * Read one JSON value with at most the renderer's exact partial-enforcement notice.
 * @param text - Unmodified run_code text from a fixture program with no console logs.
 * @returns The program's JSON value.
 * @throws For invalid JSON, other trailing text, or repeated notices.
 */
export function parsePtcJson(text: string): unknown
