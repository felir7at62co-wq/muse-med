/**
 * Redacted descriptions of a Jubian response nothing could read.
 *
 * A rejected payload has to be reported without being reproduced: a tool result
 * carrying a provider body could put a credential, a signed URL or a long
 * provider message into a model's context. Everything here therefore keeps
 * structure only — top-level types, own key names, lengths, and one bounded
 * excerpt — with the values of credential-named fields removed, any absolute
 * URL reduced to its origin, and long opaque runs replaced. The same description
 * is what the opt-in debug dump persists, so an operator can send back what the
 * remote actually returned without sending back a token.
 *
 * {@link describeRejection} is the one summary both layers reject through: the
 * transport rejects a body it could not read as an envelope, and every reader in
 * `@deepseek-ai/dsh-jubian-api` rejects a payload it could not read fields from.
 * Neither writes its own, because two summaries would drift and one of them
 * would then be the reason an operator could not tell what arrived.
 */
import { DEBUG_DUMP_ENV } from './debug-dump.ts'

/** One JSON value's top-level type, as a diagnostic names it. */
type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

/** Key-name words whose value is never reproduced. */
const SENSITIVE_WORDS = new Set([
  'token', 'tokens', 'authorization', 'auth', 'cookie', 'cookies', 'secret', 'secrets',
  'password', 'passwd', 'pwd', 'credential', 'credentials', 'signature', 'sign', 'session',
  'sessionid', 'jwt', 'bearer', 'apikey', 'accesskey', 'accesskeyid', 'secretkey', 'privatekey',
  'ticket', 'xsec',
])

/** Longest excerpt any diagnostic carries. */
const EXCERPT_CHARS = 200

/** Own keys listed before the list is cut. */
const KEY_CAP = 24

/** Characters kept from one string value inside an excerpt. */
const VALUE_CHARS = 80

/** Elements walked per array while building an excerpt. */
const ELEMENT_CAP = 6

/** Nested levels reproduced before a value collapses to its type. */
const DEPTH_CAP = 3

/** Bytes of an undecodable body shown as hex. */
const HEX_BYTES = 16

/** The top-level type of one parsed JSON value. */
function jsonType(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object': return 'object'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return 'null'
  }
}

/** Split one key name into lowercase words across case, digit and separator boundaries. */
function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/u).filter(Boolean).map(word => word.toLowerCase())
}

/** Whether one key name is one whose value a diagnostic must never reproduce. */
function sensitiveKey(name: string): boolean {
  const parts = words(name)
  return parts.some(part => SENSITIVE_WORDS.has(part)) || SENSITIVE_WORDS.has(parts.join(''))
}

/** Remove credentials that sit inside a string value rather than behind a key name. */
function scrubText(text: string): string {
  // Every pattern below matches case-insensitively, so its character classes
  // carry one letter range and not two.
  return text
    .replace(/([?&][A-Z0-9_-]*(?:token|sign|signature|secret|key|credential)[A-Z0-9_-]*=)[^&\s"']*/giu,
      '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})+\b/gu, '[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/gu, '[redacted]')
}

/** One string value as an excerpt may carry it: origin only, scrubbed, shortened. */
function excerptString(text: string): string {
  const scrubbed = scrubText(text)
  const url = /^(https?):\/\/([^/?#\s]+)(?:[/?#]\S*)?$/iu.exec(scrubbed)
  const bounded = url === null ? scrubbed : `${url[1] ?? ''}://${url[2] ?? ''}/…`
  return bounded.length <= VALUE_CHARS ? bounded : `${bounded.slice(0, VALUE_CHARS)}…`
}

/**
 * One value as an excerpt may carry it: values behind a sensitive key removed,
 * absolute URLs reduced to their origin, strings and containers bounded.
 */
function bounded(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return excerptString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= DEPTH_CAP) return Array.isArray(value) ? `[array of ${value.length}]` : '[object]'
  if (Array.isArray(value)) {
    const items = value.slice(0, ELEMENT_CAP).map(item => bounded(item, depth + 1))
    return value.length > ELEMENT_CAP ? [...items, `[${value.length - ELEMENT_CAP} more]`] : items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const kept = entries.slice(0, KEY_CAP)
    .map(([key, item]) => [key, sensitiveKey(key) ? '[redacted]' : bounded(item, depth + 1)] as const)
  return Object.fromEntries(entries.length > KEY_CAP ? [...kept, ['…', `${entries.length - KEY_CAP} more keys`]] : kept)
}

/** The bounded JSON text one excerpt shows for a value. */
function excerpt(value: unknown): string {
  // `JSON.stringify` is typed as returning a string but answers `undefined` for
  // one, so the absent case is read from the value rather than from its result.
  const text = JSON.stringify(bounded(value, 0)) as string | undefined
  const shown = text ?? 'undefined'
  return shown.length <= EXCERPT_CHARS ? shown : `${shown.slice(0, EXCERPT_CHARS)}…`
}

/** Key names of one object value, capped and marked when the cap cut them. */
function keyList(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  if (keys.length <= KEY_CAP) return keys.join(', ')
  return `${keys.slice(0, KEY_CAP).join(', ')}, …(${keys.length - KEY_CAP} more)`
}

/**
 * Describe one parsed payload without reproducing it.
 *
 * Used where a response arrived as JSON but is not what the caller could read,
 * so the report says which top-level type, own keys and lengths the remote
 * actually sent.
 * @param value - The parsed payload, as `JSON.parse` returned it.
 * @returns One line naming the top-level type, the own keys and the lengths, then a redacted excerpt.
 */
export function describePayload(value: unknown): string {
  const type = jsonType(value)
  if (type === 'object') {
    const record = value as Record<string, unknown>
    return `top-level object with ${Object.keys(record).length} keys [${keyList(record)}], excerpt ${excerpt(value)}`
  }
  if (type === 'array') {
    const items = value as unknown[]
    const first = items[0]
    const firstType = items.length === 0 ? ''
      : `, first element ${jsonType(first)}${jsonType(first) === 'object'
        ? ` with keys [${keyList(first as Record<string, unknown>)}]` : ''}`
    return `top-level array of ${items.length} elements${firstType}, excerpt ${excerpt(value)}`
  }
  if (type === 'string') {
    return `top-level string of ${(value as string).length} characters, excerpt ${excerpt(value)}`
  }
  return `top-level ${type}, excerpt ${excerpt(value)}`
}

/** First bytes of a body that never decoded, so the failure is still recognizable. */
function hex(body: Uint8Array): string {
  return [...body.slice(0, HEX_BYTES)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}

/**
 * Describe one body that never became a JSON value.
 * @param text - The strictly decoded body, or null when it was not valid UTF-8.
 * @param body - The exact bytes received.
 * @returns One line naming the decode or parse failure, the byte length and a bounded excerpt.
 */
export function describeUnparsed(text: string | null, body: Uint8Array): string {
  if (text === null) {
    return `body is not strict UTF-8: ${body.byteLength} bytes, first ${HEX_BYTES} bytes hex ${hex(body)}`
  }
  return `body is not JSON: ${body.byteLength} bytes, excerpt ${excerpt(text)}`
}

/**
 * The redacted value an opt-in debug dump may persist for one payload.
 * @param value - Any parsed payload.
 * @returns A bounded copy with credential-named fields removed and URLs reduced to their origin.
 */
export function redactForDump(value: unknown): unknown {
  return bounded(value, 0)
}

/** The envelope codes this client reads as a success, as a rejection names them. */
const ACCEPTED_ENVELOPE_CODES = '0 / 200'

/** One sentence naming the opt-in capture switch and how to use it. */
const CAPTURE_HINT = `Capture the body: set ${DEBUG_DUMP_ENV}=<file path> and repeat the call once;`
  + ' the redacted response structure is appended to that file.'

/**
 * Whether one detail already names the capture switch, and so has been summarised once.
 * @param detail - A rejection detail a diagnostic may have produced.
 * @returns True when the detail already carries the capture sentence.
 */
export function namesCaptureSwitch(detail: string): boolean {
  return detail.includes(DEBUG_DUMP_ENV)
}

/** The integer `code` a candidate envelope states, whether or not an array wrapped it. */
function statedCode(value: unknown): number | null | undefined {
  const candidate: unknown = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const code = (candidate as Record<string, unknown>).code
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : null
}

/**
 * Describe one parsed payload that arrived where a readable one was required.
 *
 * This is the summary every rejected envelope carries, from either layer: the
 * structure {@link describePayload} reports, the envelope `code` compared against
 * the accepted set, and the switch that captures the body for a diagnosis. No
 * credential and no provider message survives it — the excerpt is the redacted
 * one {@link describePayload} already produces — and any value, a `null`, an
 * array, a string or a number, is described rather than rejected, so a diagnostic
 * never fails while reporting a failure.
 * @param value - The parsed value that was rejected.
 * @returns One line naming the structure, the envelope code against the accepted set, and the capture switch.
 */
export function describeRejection(value: unknown): string {
  const structure = describePayload(value)
  const code = statedCode(value)
  const comparison = code === undefined
    ? structure
    : `${structure}, code=${code === null ? 'none, not an integer' : String(code)}`
      + ` (accepted envelope codes: ${ACCEPTED_ENVELOPE_CODES})`
  return `${comparison}. ${CAPTURE_HINT}`
}

/**
 * Describe one response body that never became a JSON value.
 * @param text - The strictly decoded body, or null when it was not valid UTF-8.
 * @param body - The exact bytes received.
 * @returns The decode or parse failure, the byte length, a bounded excerpt and the capture switch.
 */
export function describeBodyRejection(text: string | null, body: Uint8Array): string {
  return `${describeUnparsed(text, body)}. ${CAPTURE_HINT}`
}
