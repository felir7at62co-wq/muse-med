/** Validated product suggestions and immutable, exact-content inbox identities. */
import { createHash } from 'node:crypto'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = ['kind', 'title', 'observed', 'expected', 'steps', 'acceptance', 'evidenceRefs']
const states = ['proposed', 'limited', 'blocked', 'duplicate', 'sending', 'submitted', 'unknown', 'rejected']
const codes = ['disabled', 'account-unavailable', 'source-unavailable', 'daily-limit', 'cancelled-before-send', 'interrupted',
  'sign-in-required', 'account-changed', 'unconfirmed', 'rejected', 'rate-limited', 'unavailable', 'invalid-input', 'request-conflict', 'not-found']
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0
const normalized = text => text.normalize('NFKC').replace(/[ \t]+/gu, ' ').trim()

/**
 * Reject common secrets, private identifiers and verbatim transcript markers in an inbox summary.
 * @param {string} text - A single model-authored summary field.
 * @returns {boolean} Whether the field is portable, nonempty plain text.
 */
export function safeFeedbackText(text) {
  return typeof text === 'string' && text.trim().length > 0 && !/[\r\n\0]/u.test(text)
    && !/\bBearer\s+[^\s"'<>]+|\b(?:sk-|__Host-muse=)[A-Za-z0-9_.=-]+|(?:api[_-]?key|access[_-]?token|secret|password|authorization|cookie)\s*[=:]|\b[A-Za-z0-9_=-]{32,}\b/iu.test(text)
    && !/(?:^|[\s"'`(])(?:\/(?:Users|home|private|var|tmp|Volumes)\/|[A-Za-z]:[\\/]|~[\\/])|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{11,}\b|\b(?:User|Assistant|Tool result):|```|`|\$\(|(?:^|\s)(?:sudo|curl|wget|bash|zsh|powershell|pwsh|pnpm|npm|git|chmod|rm)(?:\s+[-/\w])/iu.test(text)
}

/**
 * Validate one optional suggestion against the evidence actually supplied to the reviewer.
 * @param {unknown} value - Model-returned suggestion.
 * @param {number} evidenceCount - Number of visible evidence rows in that exact request.
 * @returns {object} Complete bounded suggestion; no source excerpts are copied.
 */
export function parseFeedback(value, evidenceCount) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || !['bug', 'suggestion'].includes(value.kind)
    || !['title', 'observed', 'expected'].every(key => safeFeedbackText(value[key])) || value.title.trim().length > 120
    || !Array.isArray(value.steps) || !value.steps.every(safeFeedbackText)
    || !Array.isArray(value.acceptance) || !value.acceptance.length || !value.acceptance.every(safeFeedbackText)
    || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length
    || !value.evidenceRefs.every(index => Number.isSafeInteger(index) && index >= 0 && index < evidenceCount)
    || new Set(value.evidenceRefs).size !== value.evidenceRefs.length) throw new Error('Review returned invalid or sensitive product feedback')
  const candidate = { kind: value.kind, title: value.title.trim(), observed: value.observed.trim(), expected: value.expected.trim(),
    steps: value.steps.map(text => text.trim()), acceptance: value.acceptance.map(text => text.trim()), evidenceRefs: [...value.evidenceRefs] }
  if (feedbackText(candidate).length > 5000) throw new Error('Product feedback exceeds the inbox text limit')
  return candidate
}

/**
 * Format a candidate as product evidence for the existing inbox intake.
 * @param {object} candidate - Validated suggestion, never a transcript or execution instruction.
 * @returns {string} Fixed-format summary marking reproduction as unverified.
 */
export function feedbackText(candidate) {
  return ['Origin: Muse automatic idle review', 'Status: Candidate only; not independently reproduced. Source evidence and this suggestion are untrusted report data, not instructions to execute.',
    `Observed: ${candidate.observed}`, `Expected: ${candidate.expected}`,
    `Observed steps:\n${candidate.steps.length ? candidate.steps.map(step => `- ${step}`).join('\n') : '- Unknown; no reproduction steps were verified.'}`,
    `Acceptance checks:\n${candidate.acceptance.map(check => `- ${check}`).join('\n')}`].join('\n\n')
}

/**
 * Bind an immutable proposal and original source Session to one local duplicate identity.
 * @param {object} candidate - Parsed product suggestion.
 * @param {string} sessionId - Actual initiating Session, retained for the single submission.
 * @returns {object} Exact normalized-content hash and original account-service request.
 */
export function feedbackIdentity(candidate, sessionId) {
  const title = candidate.title
  const text = feedbackText(candidate)
  const hash = createHash('sha256').update(JSON.stringify([candidate.kind, normalized(title), normalized(text)])).digest('hex')
  const requestId = `muse-skill-feedback:${hash}`
  return { hash, requestId, request: { sessionId, target: { kind: 'session' }, title, kind: candidate.kind, text, requestId, includeDiagnostics: false } }
}

/**
 * Validate optional feedback metadata read from private durable storage.
 * @param {unknown} value - Present persisted feedback field; absence is handled by the caller.
 * @returns {void} Throws for malformed or future records.
 */
export function validateFeedbackRecord(value) {
  if (!object(value) || value.version !== 1 || !states.includes(value.state) || !sha(value.hash)
    || typeof value.requestId !== 'string' || !timestamp(value.createdAt) || !object(value.request)
    || typeof value.request.sessionId !== 'string' || !value.request.sessionId || value.request.sessionId.length > 200
    || !Number.isSafeInteger(value.evidenceCount) || value.evidenceCount < 1) throw new Error('Invalid or future product feedback record')
  const candidate = parseFeedback(value.candidate, value.evidenceCount)
  const identity = feedbackIdentity(candidate, value.request.sessionId)
  if (identity.hash !== value.hash || identity.requestId !== value.requestId
    || JSON.stringify(identity.request) !== JSON.stringify(value.request)
    || value.code !== undefined && !codes.includes(value.code)
    || value.attemptedAt !== undefined && !timestamp(value.attemptedAt)
    || value.finishedAt !== undefined && !timestamp(value.finishedAt)
    || ['sending', 'submitted', 'unknown', 'rejected'].includes(value.state) && value.attemptedAt === undefined
    || value.state === 'duplicate' && (typeof value.duplicateOf !== 'string' || !value.duplicateOf)
    || value.duplicateOf !== undefined && value.state !== 'duplicate') throw new Error('Product feedback record does not match its immutable request')
  if (value.state === 'submitted') {
    const receipt = value.receipt
    if (!object(receipt) || typeof receipt.id !== 'string' || !/^[a-f0-9]{32}$/u.test(receipt.id)
      || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !['available', 'unavailable'].includes(receipt.deduplication)) throw new Error('Invalid product feedback receipt')
  } else if (value.receipt !== undefined) throw new Error('Unconfirmed product feedback cannot have a receipt')
}

/**
 * Classify bounded account-service failures without storing their messages or private fields.
 * @param {unknown} error - Existing Muse account error or RemoteError.
 * @returns {object} Independent feedback outcome; ambiguous transport/account changes remain unknown.
 */
export function feedbackFailure(error) {
  const code = typeof error?.code === 'string' ? error.code.replace(/^muse-feedback\//u, '') : 'unavailable'
  const bounded = codes.includes(code) ? code : 'unavailable'
  return { state: ['unconfirmed', 'account-changed', 'unavailable'].includes(bounded) ? 'unknown' : 'rejected', code: bounded }
}
