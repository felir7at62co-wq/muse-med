/** Exact rendering notice emitted by the production PTC tool on partially confined hosts. */
export const PARTIAL_SANDBOX_NOTICE = 'File sandbox enforcement is partial on this host.'

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the one object payload emitted by these PTC fixtures and retain its known notice.
 * @param {ReadonlyArray<{type: string, text?: string}>} content - Actual model-visible tool blocks.
 * @returns {{value: Record<string, unknown>, notices: string[]}} Parsed object and explicit notices.
 */
export function parsePtcJsonResult(content) {
  /** @type {Record<string, unknown>[]} */
  const values = []
  const notices = []
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') throw Error('Expected only PTC text blocks')
    let text = block.text
    if (text === PARTIAL_SANDBOX_NOTICE) { notices.push(text); continue }
    const suffix = '\n' + PARTIAL_SANDBOX_NOTICE
    if (text.endsWith(suffix)) { notices.push(PARTIAL_SANDBOX_NOTICE); text = text.slice(0, -suffix.length) }
    const value = JSON.parse(text)
    if (!isObject(value)) throw Error('Expected a PTC object payload')
    values.push(value)
  }
  if (values.length !== 1 || notices.length > 1) throw Error('Expected one PTC payload and at most one known notice')
  return { value: values[0], notices }
}
