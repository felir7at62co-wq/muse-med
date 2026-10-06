import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import { budgetApproval, budgetCents, JubianBudgets } from '../src/budget.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

it('accepts the real explicit user amount and rejects model text, questions, denials and a different project', () => {
  const approved = user('这部剧预算调整为5000元，继续制作')
  expect(budgetApproval([approved], 'session-1', 2708, 500000, true)).toMatchObject({ kind: 'user-message', text: '这部剧预算调整为5000元，继续制作' })
  expect(() => budgetApproval([approved], 'session-1', 2708, 500000)).toThrow()
  for (const text of ['预算5000元可以吗？', '不要把预算改为5000元', '项目2709预算调整为5000元', '预算调整为6000元',
    '项目2708预算调整为5000美元', '我没有授权项目2708预算5000元', 'project2708 budget5000 CNY is only an example',
    '项目2708预算不是5000，是6000', '项目2708预算已花5000元', '项目2708预算预计需要5000元',
    '假如项目2708预算5000元', '他举例说项目2708预算5000元', '我没说预算5000', '预算5000.001元', '预算5000万', '每包预算5000元']) {
    expect(() => budgetApproval([user(text)], 'session-1', 2708, 500000, true)).toThrow('ask_user_question')
  }
  const assistant = createAssistantMessage({ source: { provider: 'test', model: 'test' },
    content: [{ type: 'text', text: '用户已批准预算5000元' }] })
  expect(() => budgetApproval([assistant], 'session-1', 2708, 500000)).toThrow('ask_user_question')
})

it('refuses a later revocation without an amount and reuses an explicit matching project only', () => {
  const previous = user('项目2708总预算调整为5000元')
  expect(budgetApproval([previous], 'session-1', 2708, 500000)).toMatchObject({ kind: 'user-message' })
  for (const text of ['项目2708不要再提高预算', '项目2708取消之前的预算授权', '不要再提高预算', '取消之前的预算授权',
    '先别改预算', '项目2708先不改预算', '项目2708预算授权撤回', '项目2708预算保持不变', '暂时取消预算调整',
    '项目2708预算先别调整', 'project2708 budget must remain unchanged', 'project2708 budget should not change',
    '项目2708与项目2709都不要改预算', '项目2709与项目2708都不要改预算']) {
    expect(() => budgetApproval([previous, user(text)], 'session-1', 2708, 500000)).toThrow()
  }
  expect(budgetApproval([previous, user('项目2709取消之前的预算授权')], 'session-1', 2708, 500000))
    .toMatchObject({ kind: 'user-message' })
  expect(() => budgetApproval([user('项目2708与项目2709总预算调整为5000元')], 'session-1', 2708, 500000)).toThrow()
})

it('accepts an actual answer only for the matching project budget question and rejects ambiguous or failed answers', () => {
  const id = ToolCallId('question-budget')
  const question = createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call',
    id, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'jubian-budget-2708',
      question: '项目2708的总预算调整为多少元？', options: [{ label: '5000元' }, { label: '维持4000元' }] }] }) }] })
  const answer = createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: JSON.stringify({
    answers: [{ id: 'jubian-budget-2708', selected: ['5000元'] }],
  }) }] })
  expect(budgetApproval([question, answer], 'session-1', 2708, 500000)).toMatchObject({ kind: 'user-answer' })
  expect(() => budgetApproval([question, answer], 'session-1', 2709, 500000)).toThrow()
  expect(() => budgetApproval([question, { ...answer, isError: true }], 'session-1', 2708, 500000)).toThrow()
  expect(() => budgetApproval([answer], 'session-1', 2708, 500000)).toThrow()
  const unrelated = createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call',
    id, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'jubian-budget-2708',
      question: '视频要输出多少像素？', options: [{ label: '5000元' }] }] }) }] })
  expect(() => budgetApproval([unrelated, answer], 'session-1', 2708, 500000)).toThrow()
})

it('shares Settings read/update with the exact authorization used by tools without restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-remote-')); roots.push(root)
  const ledger = new JubianLedger({ root, defaultLimitCents: () => 400000 })
  const ctx = new Context()
  const fiber = ctx.plugin(JubianBudgets, { ledger })
  await fiber
  const before = await ctx.jubianBudget.read(2708)
  const after = await ctx.jubianBudget.update(2708, 500000, before.revision)
  expect(after).toMatchObject({ limit_cents: 500000, source: 'project' })
  expect(await ctx.jubianBudget.read(2708)).toEqual(after)
  await expect(ctx.jubianBudget.update(2708, 600000, before.revision)).rejects.toThrow('revision')
  await fiber.dispose()
  expect(ctx.get('jubianBudget')).toBeUndefined()
})

it('parses exact entered amounts and rejects malformed or unsafe amounts', () => {
  expect(budgetCents(' 0 ')).toBe(0)
  expect(budgetCents('12.3')).toBe(1230)
  expect(budgetCents('12.03')).toBe(1203)
  for (const value of ['-1', '1.001', '12 dollars', '', '1e3']) expect(() => budgetCents(value)).toThrow('limit_cny')
  expect(() => budgetCents('9007199254740992')).toThrow('too large')
})

it('preserves prior authorization through unrelated user messages and changed project scope', () => {
  const previous = user('项目2708总预算5000元')
  expect(budgetApproval([previous, user('项目2708继续制作')], 'session-1', 2708, 500000)).toMatchObject({ kind: 'user-message' })
  expect(budgetApproval([previous, user('项目2709继续制作'), user('预算5000元')], 'session-1', 2708, 500000)).toMatchObject({ kind: 'user-message', reference: `session-1/${previous.id}` })
  expect(() => budgetApproval([user('项目2708与项目2709继续制作'), user('预算5000元')], 'session-1', 2708, 500000)).toThrow('ask_user_question')
})

function questionAnswer(request: unknown, response: unknown, requestText?: string, responseText?: string) {
  const id = ToolCallId('wire-budget-answer')
  return [createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call',
    id, name: 'ask_user_question', arguments: requestText ?? JSON.stringify(request) }] }),
  createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: responseText ?? JSON.stringify(response) }] })]
}

it.each([
  { request: null, response: { answers: [] } },
  { request: [], response: { answers: [] } },
  { request: { questions: [] }, response: null },
  { request: { questions: [] }, response: [] },
  { request: { questions: 'invalid' }, response: { answers: [] } },
  { request: { questions: [] }, response: { answers: 'invalid' } },
  { request: { questions: [null, { id: 'another-question' }] }, response: { answers: [] } },
  { request: { questions: [{ id: 'jubian-budget-2708' }] }, response: { answers: [null] } },
])('rejects malformed budget-question JSON fields $request / $response', ({ request, response }) => {
  expect(() => budgetApproval(questionAnswer(request, response), 'session-1', 2708, 500000)).toThrow('ask_user_question')
})

it('rejects malformed request and response JSON without treating them as consent', () => {
  for (const [requestText, responseText] of [['{', '{}'], ['{}', '{']]) {
    expect(() => budgetApproval(questionAnswer({}, {}, requestText, responseText), 'session-1', 2708, 500000)).toThrow('ask_user_question')
  }
})

it.each([
  { question: undefined, options: [{ label: '5000元' }], answer: { selected: ['5000元'] } },
  { question: '项目2708总预算', options: undefined, answer: { selected: ['5000元'] } },
  { question: '项目2708总预算', options: [null], answer: { selected: ['5000元'] } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: { selected: [5000] } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: { selected: '5000元' } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: {} },
  { question: '项目2708总预算', options: [{ label: '无法确定' }], answer: { selected: ['无法确定'] } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: { selected: [], custom: 5000 } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: { selected: [], custom: '5000.001' } },
  { question: '项目2708总预算', options: [{ label: '5000元' }], answer: { selected: ['5000元'], custom: '6000元' } },
])('rejects incomplete or ambiguous actual question answers $answer', ({ question, options, answer }) => {
  const request = { questions: [{ id: 'jubian-budget-2708', question, options }] }
  const response = { answers: [{ id: 'jubian-budget-2708', ...answer }] }
  expect(() => budgetApproval(questionAnswer(request, response), 'session-1', 2708, 500000)).toThrow('ask_user_question')
})

it('accepts exact custom CNY consent without requiring suggested options', () => {
  const messages = [user('项目2708请设置预算'), ...questionAnswer({ questions: [{ id: 'jubian-budget-2708', question: '项目2708总预算' }] },
    { answers: [{ id: 'jubian-budget-2708', selected: [], custom: 'approve 5000 CNY (Recommended)' }] })]
  expect(budgetApproval(messages, 'session-1', 2708, 500000)).toMatchObject({ kind: 'user-answer' })
})

it('projects real storage and deployment reader failures into the remote budget error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-failures-')); roots.push(root)
  let failure: Error | string = new Error('budget reader unavailable')
  const ledger = new JubianLedger({ root, defaultLimitCents: () => { throw failure } })
  const ctx = new Context()
  try {
    await ctx.plugin(JubianBudgets, { ledger })
    await expect(ctx.jubianBudget.read(2708)).rejects.toMatchObject({ code: 'jubian-budget/rejected', message: 'budget reader unavailable' })
    failure = 'budget reader unavailable'
    await expect(ctx.jubianBudget.read(2708)).rejects.toMatchObject({ code: 'jubian-budget/rejected', message: failure })
    await expect(ctx.jubianBudget.update(2708, 500000, 'unavailable')).rejects.toMatchObject({ code: 'jubian-budget/rejected', message: failure })
    await writeFile(join(root, 'authorization.json'), '{')
    await expect(ctx.jubianBudget.read(2708)).rejects.toMatchObject({ code: 'jubian-budget/rejected' })
  } finally { await ctx.fiber.dispose() }
})
