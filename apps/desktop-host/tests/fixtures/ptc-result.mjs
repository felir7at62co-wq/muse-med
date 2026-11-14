/** JSON-only fixture programs may be followed by the PTC renderer's partial-enforcement notice. */
const partialNotice = '\nFile sandbox enforcement is partial on this host.'

/**
 * Read the complete JSON result, accepting only the renderer's exact optional notice.
 * @param {string} text - Complete model-visible run_code text with no program logs.
 * @returns {unknown} Parsed result; other trailing output remains a JSON error.
 */
export function parsePtcFixtureResult(text) {
  return JSON.parse(text.endsWith(partialNotice) ? text.slice(0, -partialNotice.length) : text)
}
