/** Read one fixture program result while retaining the renderer's exact sandbox notice in its message. */
const sandboxNotice = '\nFile sandbox enforcement is partial on this host.'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the actual run_code renderer's JSON result, accepting only its known optional notice suffix.
 * @param {unknown} message - Original tool message; never modified.
 * @returns {Record<string, unknown>} Exactly one structured fixture program result.
 */
export function readPtcFixtureResult(message) {
  if (!record(message) || !Array.isArray(message.content) || message.content.length !== 1) {
    throw new Error('Expected exactly one structured run_code fixture result')
  }
  const block = message.content[0]
  if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text run_code fixture result')
  }
  const text = block.text.endsWith(sandboxNotice) ? block.text.slice(0, -sandboxNotice.length) : block.text
  const value = JSON.parse(text)
  if (!record(value)) throw new Error('Expected a structured run_code fixture result object')
  return value
}
