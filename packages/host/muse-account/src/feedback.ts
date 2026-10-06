/** Explicit desktop submissions to the same authenticated Muse opinion inbox as the website. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { readMuseSession } from './session.ts'
import type { MuseFeedbackId, MuseFeedbackReceipt, MuseFeedbackRequest } from './types.ts'

/** Bounded failures; uncertain POST outcomes must be checked in the inbox before another submission. */
export class MuseFeedbackError extends Error {
  constructor(readonly code: 'sign-in-required' | 'account-changed' | 'unconfirmed' | 'rejected' | 'rate-limited' | 'unavailable' | 'invalid-input') {
    super(`MUSE feedback: ${code}`)
  }
}

/** Host-owned session, excerpt and credential readers; no cookie is passed by the browser. */
export interface MuseFeedbackOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly excerptChars: number
  /**
   * Read the live Session's maintained visible-message projection.
   * @param request - Feedback target whose Session must exist.
   * @returns Derived messages, or undefined when the Session is unavailable.
   */
  readonly readMessages: (request: MuseFeedbackRequest) => readonly Message[] | undefined
  /** @returns Local authentication values used only for redaction. */
  readonly secrets: () => Promise<readonly string[]>
  readonly fetcher?: typeof fetch
}

const CATEGORIES = new Set(['task-result', 'instruction-following', 'product-interaction', 'service-stability', 'resource-cost', 'security-privacy-permission', 'other'])

function redact(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) result = result.split(secret).join('[redacted]')
  }
  return result
    .replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk-|__Host-muse=)[A-Za-z0-9_.=-]+/gu, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization|cookie)\s*[=:]\s*)[^\s,"'&<>]+/giu, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/gu, '[redacted]')
}

function visibleText(message: Message | undefined): string {
  return message?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

/** Sends one explicit POST, accepting only a matching authenticated durable receipt. */
export class MuseFeedbackClient {
  constructor(private readonly options: MuseFeedbackOptions) {}

  /**
   * Capture the current account, verify the target and send optional related visible excerpts.
   * @param request - Transport-validated target, form fields and diagnostics choice.
   * @returns Confirmed inbox record ID and revision; no automatic retry is made.
   */
  async submit(request: MuseFeedbackRequest): Promise<MuseFeedbackReceipt> {
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (!session) throw new MuseFeedbackError('sign-in-required')
    if (typeof request.sessionId !== 'string' || request.sessionId.length > 200 || request.sessionId.length === 0
      || typeof request.includeDiagnostics !== 'boolean' || (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 5000))
      || (request.category !== undefined && !CATEGORIES.has(request.category))
      || !['message', 'session'].includes(request.target.kind)) throw new MuseFeedbackError('invalid-input')
    const messages = this.options.readMessages(request)
    if (!messages) throw new MuseFeedbackError('invalid-input')
    let index = messages.length - 1
    if (request.target.kind === 'message') {
      const target = request.target
      index = messages.findIndex(message => message.id === target.messageId && message.role === 'assistant')
      if (index < 0) throw new MuseFeedbackError('invalid-input')
    } else {
      while (index >= 0 && messages[index]?.role !== 'assistant') index -= 1
    }
    const answer = messages[index]
    let userIndex = index < 0 ? messages.length - 1 : index - 1
    while (userIndex >= 0 && (messages[userIndex]?.role !== 'user' || messages[userIndex]?.source.kind !== 'user')) userIndex -= 1
    let secrets: readonly string[]
    try { secrets = await this.options.secrets() } catch { throw new MuseFeedbackError('unavailable') }
    const scrub = (text: string): string => redact(text, [session.cookie, session.cookie.slice('__Host-muse='.length), ...secrets])
    const category = request.category === 'other' || (request.target.kind === 'message' && request.target.rating === 'positive') ? 'other' : 'bug'
    const title = request.target.kind === 'message' ? 'Muse Desktop · Message feedback' : 'Muse Desktop · Task feedback'
    const body = [
      `Source: Muse Desktop\nTarget: ${request.target.kind}\nSession: ${request.sessionId}`,
      ...(request.target.kind === 'message' ? [`Message: ${request.target.messageId}\nRating: ${request.target.rating}`] : []),
      `Category: ${request.category ?? 'unspecified'}\nFeedback:\n${scrub(request.text?.trim() ?? '')}`,
      ...(request.includeDiagnostics ? [
        `Related user request (excerpt, up to ${this.options.excerptChars} characters):\n${scrub(visibleText(messages[userIndex])).slice(0, this.options.excerptChars)}`,
        `Related assistant answer (excerpt, up to ${this.options.excerptChars} characters):\n${scrub(visibleText(answer)).slice(0, this.options.excerptChars)}`,
      ] : []),
    ].join('\n\n')
    if (body.length > 8000) throw new MuseFeedbackError('invalid-input')
    if ((await readMuseSession(this.options.sessionFile, this.options.baseUrl))?.revision !== session.revision) throw new MuseFeedbackError('account-changed')
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(new URL('/api/muse.feedback', this.options.baseUrl), {
        method: 'POST', headers: { cookie: session.cookie, origin: this.options.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ title, body, category }), redirect: 'manual', signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      })
    } catch { throw new MuseFeedbackError('unconfirmed') }
    if (response.status === 303 || response.status === 401) throw new MuseFeedbackError('sign-in-required')
    if (response.status === 429) throw new MuseFeedbackError('rate-limited')
    if (response.status !== 201) throw new MuseFeedbackError(response.status >= 500 ? 'unconfirmed' : 'rejected')
    let value: unknown
    try { value = await response.json() } catch { throw new MuseFeedbackError('unconfirmed') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MuseFeedbackError('unconfirmed')
    const receipt = value as Record<string, unknown>
    if (typeof receipt.id !== 'string' || !/^[a-f0-9]{32}$/u.test(receipt.id) || receipt.revision !== 1
      || receipt.username !== session.username || receipt.title !== title || receipt.body !== body || receipt.category !== category) throw new MuseFeedbackError('unconfirmed')
    try {
      if ((await readMuseSession(this.options.sessionFile, this.options.baseUrl))?.revision !== session.revision) throw new MuseFeedbackError('account-changed')
    } catch (error) {
      if (error instanceof MuseFeedbackError) throw error
      throw new MuseFeedbackError('unconfirmed')
    }
    return { id: brandString<MuseFeedbackId>(receipt.id), revision: receipt.revision }
  }
}

/**
 * Collect local authentication values only for removal from explicit feedback text.
 * @param ctx - Host services owning configured credentials.
 * @returns Values to redact; none are sent as diagnostic fields.
 */
export async function feedbackSecrets(ctx: Context): Promise<readonly string[]> {
  const secrets = Object.entries(process.env)
    .filter((entry): entry is [string, string] => /(?:TOKEN|SECRET|PASSWORD|API_?KEY|COOKIE)/iu.test(entry[0]) && typeof entry[1] === 'string')
    .map(([, value]) => value)
  const credentials = ctx.get('credentials')
  if (!credentials) return secrets
  for (const entry of await credentials.listRecords()) {
    const record = await credentials.readRecord(entry.key)
    if (record?.kind === 'api-key') {
      if (record.key) secrets.push(record.key)
      if (record.env) secrets.push(...Object.values(record.env))
    }
  }
  const settings = ctx.get('settings')
  for (const provider of ctx.llm.listConfigurableProviders()) {
    if (!settings) break
    let value: unknown = settings.describe({ redactSecrets: true }).find(row => row.ns === provider.settingsNs)?.value
    for (const part of provider.settingsPath) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
    if (value && typeof value === 'object' && 'apiKeyEnv' in value && typeof value.apiKeyEnv === 'string') {
      const resolved = await credentials.resolve(credentialRef(value.apiKeyEnv))
      if (resolved) secrets.push(resolved.value)
    }
  }
  return secrets
}
