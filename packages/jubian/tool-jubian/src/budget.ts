/** Live project budgets shared by model tools, project bibles and the Settings page. */
import type { Context } from '@deepseek-ai/cordis'
import { readProjectBudget, updateProjectBudget, JubianError } from '@deepseek-ai/dsh-jubian'
import type { BudgetApproval, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { ProjectBudget } from '@deepseek-ai/dsh-jubian/types'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared runtime project-budget reader and user-facing Settings writer. */
    jubianBudget: JubianBudgets
  }
}

/**
 * Parse an exact CNY amount without floating-point decimal rounding.
 * @param value - Yuan text with at most two decimal places.
 * @returns Nonnegative safe integer cents.
 */
export function budgetCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new JubianError('INVALID_ARGUMENT', 'limit_cny must be a nonnegative amount with at most two decimal places')
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new JubianError('INVALID_ARGUMENT', 'limit_cny is too large')
  return cents
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function content(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function answerAmount(value: string): number | undefined {
  const match = /^(?:同意|批准|调整为|提高到|授权|approve\s*)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|CNY|yuan)?\s*(?:[（(](?:推荐|Recommended)[）)])?$/i
    .exec(value.trim())
  return match?.[1] === undefined ? undefined : budgetCents(match[1])
}

function ambiguousBudget(text: string): boolean {
  return /不是|没(?:有)?(?:说|授权|批准|同意)|不(?:要|同意|允许|批准|提高|改|调|变)|别|拒绝|取消|撤回|禁止|维持|保持/i.test(text)
    || /do not|don't|not\s|unchanged|cancel|revoke|pause|美元|美金|欧元|日元|港币|英镑|澳元|韩元|dollars?|pounds?|\$/i.test(text)
    || /USD|EUR|JPY|HKD|GBP|AUD|CAD|NZD|KRW|CHF|SGD|USDT|BTC|ETH|tokens?/i.test(text)
    || /假如|假设|如果|例子|举例|示例|比如|例如|演示|听说|他说|她说|有人说|引用|原话|["“「]|example|hypothetic|suppose|\bif\b|quote/i.test(text)
    || /每包|每次|单次|单包|per\s+(?:task|call|package)/i.test(text)
}

function approvedAmounts(text: string): number[] {
  const subject = /(?:总预算|预算上限|预算|总额度|额度|(?:total\s+)?budget|ceiling|limit)\s*/
  const action = /(?:(?:调整|提高|增加|设置|设|改|定|批准|授权)(?:到|为|成)?|为|是|就是|set\s+(?:to|at)|raise\s+to|is|[=:：])?\s*/
  const amount = /[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?![\d.万亿千百])/
  const pattern = new RegExp(subject.source + action.source + amount.source, 'gi')
  return [...text.matchAll(pattern)].map(match => budgetCents(match[1] ?? ''))
}

/**
 * Find exact user budget approval in the current maintained conversation messages.
 * Assistant prose and self-reported authorization never count; a later budget answer supersedes earlier amounts.
 * @param messages - Current Session message projection, including genuine ask_user_question results.
 * @param sessionId - Session identity included in saved evidence references.
 * @param scriptId - Exact project whose total ceiling changes.
 * @param cents - Amount to match against actual human text or a matching budget-question answer.
 * @param sessionProject - True only when the real Session cwd is exactly this bound project root.
 * @returns Recorded user evidence; absence requires a human question before the write.
 */
export function budgetApproval(messages: readonly Message[], sessionId: string, scriptId: number, cents: number,
  sessionProject = false): BudgetApproval {
  const refuse = (): never => { throw new JubianError('INVALID_ARGUMENT',
    `No explicit user authorization for project ${scriptId} total budget ${(cents / 100).toFixed(2)} CNY. Use ask_user_question with id jubian-budget-${scriptId}; reuse an existing explicit answer without asking again.`) }
  let currentProject: number | undefined = sessionProject ? scriptId : undefined
  const scopes = messages.map((message) => {
    if (message.role === 'user' && message.source.kind === 'user') {
      const named = [...new Set([...content(message).matchAll(/(?:项目|script[_ ]?id|project)\s*[#：:=]?\s*(\d+)/gi)]
        .map(match => Number(match[1])))]
      if (named.length) currentProject = named.length === 1 ? named[0] : undefined
    }
    return currentProject
  })
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user' && message.source.kind === 'user') {
      const text = content(message)
      if (!/(预算|额度|budget|ceiling|limit)/i.test(text)) continue
      const projects = [...new Set([...text.matchAll(/(?:项目|script[_ ]?id|project)\s*[#：:=]?\s*(\d+)/gi)]
        .map(match => Number(match[1])))]
      if (projects.length && !projects.includes(scriptId)) continue
      if (projects.length > 1) return refuse()
      if (scopes[index] !== scriptId) continue
      if (ambiguousBudget(text)) return refuse()
      const amounts = approvedAmounts(text)
      if (/[?？]|是否|能否|可以吗/i.test(text)
        || amounts.length !== 1 || amounts[0] !== cents) return refuse()
      return { kind: 'user-message', reference: `${sessionId}/${message.id}`, text }
    }
    if (message.role !== 'tool' || message.isError) continue
    const call = messages.slice(0, index).flatMap(item => item.role === 'assistant' ? item.content : [])
      .filter(block => block.type === 'tool-call')
      .find(block => block.id === message.toolCallId && block.name === 'ask_user_question')
    if (!call) continue
    let request: Record<string, unknown> | undefined, response: Record<string, unknown> | undefined
    try { request = record(JSON.parse(call.arguments)); response = record(JSON.parse(content(message))) }
    catch (_error) { continue }
    if (!Array.isArray(request?.questions) || !Array.isArray(response?.answers)) continue
    const questionId = `jubian-budget-${scriptId}`
    const question = request.questions.map(record).find(item => item?.id === questionId)
    const answer = response.answers.map(record).find(item => item?.id === questionId)
    if (!question || !answer || !Array.isArray(answer.selected)) continue
    const questionText = typeof question.question === 'string' ? question.question : ''
    const questionProjects = [...new Set([...questionText.matchAll(/(?:项目|script[_ ]?id|project)\s*[#：:=]?\s*(\d+)/gi)]
      .map(match => Number(match[1])))]
    if (questionProjects.length !== 1 || questionProjects[0] !== scriptId
      || !/(总预算|总额度|预算上限|total\s+(?:budget|ceiling)|project\s+budget)/i.test(questionText)
      || ambiguousBudget(questionText)) return refuse()
    const labels = Array.isArray(question.options) ? question.options.map(record).map(option => option?.label) : []
    if (answer.selected.some(selected => typeof selected !== 'string' || !labels.includes(selected))) return refuse()
    const selected: unknown[] = answer.selected
    const values = [...selected, ...(typeof answer.custom === 'string' ? [answer.custom] : [])]
    if (values.length !== 1 || typeof values[0] !== 'string' || answerAmount(values[0]) !== cents) return refuse()
    return { kind: 'user-answer', reference: `${sessionId}/${message.id}/${questionId}`,
      text: `${String(question.question)}\n${values[0]}` }
  }
  return refuse()
}

/** Shared project-authorization service; Remote writes represent a user's explicit Settings submission. */
export class JubianBudgets extends TypertRemoteService {
  private readonly ledger: JubianLedger

  constructor(ctx: Context, options: { ledger: JubianLedger }) {
    super(ctx, 'jubianBudget')
    this.ledger = options.ledger
  }

  /**
   * Read one actual project ceiling and ledger totals.
   * @param scriptId - Exact remote project ID.
   * @returns Current effective authorization, accounting and revision.
   */
  @Remote
  async read(scriptId: number): Promise<ProjectBudget> {
    try { return await readProjectBudget(this.ledger, scriptId) }
    catch (error) { throw new RemoteError('jubian-budget/rejected', error instanceof Error ? error.message : String(error), {}, { cause: error }) }
  }

  /**
   * Save the ceiling a user explicitly entered in Settings, then read the real authorization.
   * @param scriptId - Exact selected project ID.
   * @param limitCents - User-entered total CNY ceiling, in nonnegative integer cents.
   * @param expectedRevision - Exact revision shown when the user edited the amount.
   * @returns Saved ceiling and unchanged spend/reservations; stale edits fail before writing.
   */
  @Remote
  async update(scriptId: number, limitCents: number, expectedRevision: string): Promise<ProjectBudget> {
    try { return await updateProjectBudget(this.ledger, { script_id: scriptId, limit_cents: limitCents,
      expected_revision: expectedRevision, authorization: { kind: 'settings', reference: 'settings/jubian-budget',
        text: `Settings: project ${scriptId} total budget ${(limitCents / 100).toFixed(2)} CNY` } }) }
    catch (error) { throw new RemoteError('jubian-budget/rejected', error instanceof Error ? error.message : String(error), {}, { cause: error }) }
  }
}
