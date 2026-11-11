/** Parse JSON-only fixture programs without changing their model-visible output. */

const partialNotice = '\nFile sandbox enforcement is partial on this host.'

/**
 * Read one JSON value with at most the renderer's exact partial-enforcement notice.
 * @param {string} text - Unmodified run_code text from a fixture program with no console logs.
 * @returns {unknown} The program's JSON value.
 * @throws {SyntaxError} For invalid JSON, other trailing text, or repeated notices.
 */
export function parsePtcJson(text) {
  return JSON.parse(text.endsWith(partialNotice) ? text.slice(0, -partialNotice.length) : text)
}
