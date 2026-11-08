/** Human screenplay intent and bounded recovery of an explicitly continued request. */
import type { Message, MessageId } from '@deepseek-ai/dsh-llm'

/** A human-authored request retains its original logged identity and complete text. */
export interface ManuscriptTaskHuman { message_id: MessageId; text: string }
/** Explicit continuations retain the nearest preceding human requirement and their complete added constraints. */
export interface ManuscriptTaskRequest {
  /** Null with nonempty continuations means the original requirement is unavailable, not a new creation task. */
  request: ManuscriptTaskHuman | null
  continuations: ManuscriptTaskHuman[]
  revision: boolean
}

/** Complete human requirements exceeded the configured limit; callers must not review truncated instructions. */
export class ManuscriptTaskContextLimitError extends Error {
  readonly code = 'CONTINUITY_TASK_CONTEXT_LIMIT'

  constructor() { super('Human manuscript request and continuations exceed the configured character limit.') }
}

function positiveText(text: string): string {
  return text.replace(/(?:不需要|不|勿|无需|不要|不必|不用)(?:再)?(?:进行|涉及|做)?(?:剧本|短剧|分集|分场|剧情|台词|对白)?(?:新增|改写|重写|修改|改稿|改变|续写|润色|创作|写作|修订|修正|修复|纠正|改)(?:\s*[\/、和或]\s*(?:新增|改写|重写|修改|改稿|改变|续写|润色|创作|修订|修正|修复|纠正|改))*(?:剧情|内容|稿件|剧本)?/gu, '')
    .replace(negatedBareRevision, '')
    .replace(/\b(?:do not|don't|without|no need to)\s+(?:revise|rewrite|fix|repair|edit)(?:\s+(?:the|this))?(?:\s+(?:screenplay|plot|dialogue))?/giu, '')
}
function instructionOnly(text: string): boolean {
  return /^(?:请)?(?:只|仅|先)?(?:解释|讲解|介绍|说明|演示|讨论|如何|怎么|怎样|explain|how to)/iu.test(text.trim())
    && !/(?:然后|同时|另外|并且|并|再)(?:帮我|实际|直接|现在|请你)(?:重写|改写|编写|修改|修正|修复|生成|导出|交付)/u.test(text)
}
function screenplaySubject(text: string): boolean {
  const subject = text.replace(/(?:剧本|短剧|分集|分场)(?:采购|市场|行业|数据)?(?:报告|清单|统计)/gu, '')
    .replace(/\b(?:screenplay|short drama)\s+(?:(?:market|procurement|data)\s+)?report\b/giu, '')
  return /剧本|短剧|分集|分场|剧情|台词|对白|第[\d一二三四五六七八九十百零〇]+集|screenplay|short drama|\bplot\b|\bdialogue\b/iu.test(subject)
}
function continuation(text: string): boolean {
  if (/^\s*(?:继续|接着|然后继续|给我文件|把.{0,12}(?:文件|Word|文档)给我|继续改|continue)[。！!\s]*$/iu.test(text)) return true
  return /^\s*(?:继续|接着|然后继续|continue)\s*[，,：:；;]\s*\S/iu.test(text)
    && !/^\s*(?:继续|接着|然后继续|continue)\s*[，,：:；;]\s*(?:现在|接下来)?(?:改做|换个任务|处理新任务)/iu.test(text)
}

const revisionSubject = '(?:剧本|短剧|分集|分场|剧情|台词|对白|第[\\d一二三四五六七八九十百零〇]+集)'
const bareRevisionAction = String.raw`改(?=一下|下|这|那|该|原有|现有|当前|整个|全部|重新|的|${revisionSubject}|\s|[。.!?！？,，；;：:]|$)`
const revisionAction = String.raw`(?:修正|修复|纠正|修改|重写|改写|续写|改稿|修订|润色|精修|${bareRevisionAction})`
const negatedBareRevision = new RegExp(String.raw`(?<![分个特])别(?:再)?${bareRevisionAction}`, 'gu')
const forwardRevision = new RegExp(
  String.raw`${revisionAction}\s*(?:(?:这|那)(?:份|个|段|部)?|该|原有|现有|当前|整个|全部|一下|下|重新|的|\s)*`
  + String.raw`(?:第?[\d一二三四五六七八九十百零〇]+[集幕场章段]\s*)?`
  + String.raw`(?:[\p{L}\p{N}_./\\-]+\.(?:md|txt|docx)\s*(?:的|中|里)?\s*)?${revisionSubject}`, 'iu')
const reverseRevision = new RegExp(
  String.raw`${revisionSubject}(?:正文|内容|稿件)?\s*(?:(?:需要|进行|重新|请|要|做)\s*)*${revisionAction}`, 'u')
const englishRevision = new RegExp(String.raw`\b(?:revise|rewrite|fix|repair|edit)\s+`
  + String.raw`(?:(?:the|this|that|existing|current|entire|whole)\s+)*(?:screenplay|short drama|plot|dialogue)\b`, 'iu')
const englishFileRequest = String.raw`(?:give|send|export|save|provide|deliver|output|create|generate)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|this|that)\s+)?(?:word|docx|markdown|file|document)\b(?:\s+(?:file|document))?`
const englishFile = new RegExp(String.raw`\b${englishFileRequest}`, 'iu')
const negatedEnglishFile = new RegExp(String.raw`\b(?:do not|don't|without|no need to)\s+${englishFileRequest}`, 'giu')

/** Classify actual user requests, preserving short continuations and excluding negated editing or screenplay creation.
 * @param text - Human-authored request, never manuscript contents or model prose.
 * @returns Writing, continuation and file requirement flags for this request.
 */
export function manuscriptDeliveryIntent(text: string): { writing: boolean; continuation: boolean; file: boolean } {
  const positive = positiveText(text)
  const action = /重写|改写|创作|写作|编写|续写|改稿|润色|精修|写|修改|修订|修正|修复|纠正|rewrite|write|revise|\bfix\b|\brepair\b/iu.test(positive)
    || /(?:生成|generate).{0,12}(?:剧本|短剧|分集|分场|screenplay)/iu.test(positive)
  const fileRequest = text.replace(/(?:不需要|不必|不要|不用|无需|勿|不)(?:再|另外|额外)?(?:(?:生成|导出|保存|交付|提供|输出)(?:\s*[或和、/]\s*(?:生成|导出|保存|交付|提供|输出))*)?\s*(?:文件|文档|Word|DOCX|Markdown)(?:\s*(?:格式)?(?:文件|文档))?/giu, '')
    .replace(negatedEnglishFile, '')
  const file = /(?:交付|生成|导出|保存|提供|给我?|发送|发我|输出|做成|转成).{0,24}(?:文件|文档|\bword\b|\bdocx\b|\bmarkdown\b)/iu.test(fileRequest)
    || /(?:文件|文档|\bword\b|\bdocx\b|\bmarkdown\b).{0,12}(?:交付|导出|保存|给我|发我)/iu.test(fileRequest)
    || englishFile.test(fileRequest)
  const tutorial = instructionOnly(text)
  return { writing: manuscriptRevisionIntent(text) || (screenplaySubject(positive) && action && !tutorial),
    continuation: continuation(text), file: file && !tutorial }
}

/** Identify an affirmative request to revise existing screenplay material.
 * @param text - Human-authored requirement, excluding model-generated descriptions of work.
 * @returns Whether screenplay facts or dialogue are explicitly being repaired or rewritten.
 */
export function manuscriptRevisionIntent(text: string): boolean {
  const positive = positiveText(text)
  if (instructionOnly(text) || !screenplaySubject(positive)) return false
  return forwardRevision.test(positive) || reverseRevision.test(positive) || englishRevision.test(positive)
}

/** Recover only the latest human requirement and its explicit continuations from derived Session messages.
 * @param messages - Session.deriveMessages() output; other message roles and producers never supply requirements.
 * @param maxChars - Maximum combined requirement and continuation text; no text is silently shortened.
 * @returns Original message identities, complete text and revision intent; absent human input has a null request.
 * @throws ManuscriptTaskContextLimitError when complete selected human text exceeds maxChars.
 */
export function manuscriptTaskRequest(messages: readonly Message[], maxChars: number): ManuscriptTaskRequest {
  const continuations: ManuscriptTaskHuman[] = []
  let request: ManuscriptTaskHuman | null = null, chars = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || message.source.kind !== 'user') continue
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    chars += text.length
    if (chars > maxChars) throw new ManuscriptTaskContextLimitError()
    const human = { message_id: message.id, text }
    if (continuation(text)) continuations.unshift(human)
    else { request = human; break }
  }
  const revision = request !== null && [request, ...continuations].some(human => manuscriptRevisionIntent(human.text))
  return { request, continuations, revision }
}
