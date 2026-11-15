/** Main receives activity digests of its executing workers when the Host mounts session activity. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionActivityDigests from '@deepseek-ai/dsh-session-activity'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { DispatchRequest } from '../src/types.ts'
import { mainSessionPrompt } from '../src/prompt.ts'
import { setup, textResponse } from './fixture.ts'

type Script = Parameters<typeof setup>[1]

/** The worker asks a question once after receiving its assignment; every other request answers with text. */
const script: Script = Array.from({ length: 40 }, () => (options) => {
  const assigned = options.messages.some(message => message.role === 'user'
    && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
  return assigned && !options.messages.some(message => message.role === 'tool')
    ? toolCallResponse('ask-1', 'ask_user_question', { question: '保留片头吗？' })
    : textResponse('ack')
})

const request: DispatchRequest = { key: 'drama-1', title: '转写《山河》', instructions: '每部作品一个执行会话', reason: '新的候选作品' }

describe('coordinator activity watches', () => {
  it('delivers a worker question to Main as an activity digest', { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coordinator-activity-'))
    const test = await setup(root, script)
    onTestFinished(async () => {
      await test.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await test.ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0 })
    const main = await test.makeAgent('main', 'main-session')
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '转写《山河》' }] }))
    await main.whenIdle()
    const digests: string[] = []
    test.ctx.on('session/event', (session, event) => {
      if (session.id === main.id && event.type === 'user/message' && event.data.source.kind === 'session-activity') {
        digests.push(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      }
    }, { global: true })

    const task = await test.service.dispatch(main, request)
    const worker = task.attempts.at(-1)?.sessionId
    await vi.waitFor(() => { expect(digests.some(text => text.includes('called ask_user_question'))).toBe(true) }, { timeout: 15000 })
    expect(digests.find(text => text.includes('called ask_user_question'))).toContain(`- 转写《山河》 [${worker}]`)
  })

  it('moves the watches of executing workers to a reloaded activity service', { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coordinator-activity-'))
    const hanging: Script = [textResponse('ack'), 'hang', ...Array.from({ length: 20 }, () => textResponse('ack'))]
    const test = await setup(root, hanging)
    onTestFinished(async () => {
      await test.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const first = await test.ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0 })
    const main = await test.makeAgent('main', 'main-session')
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '转写《山河》' }] }))
    await main.whenIdle()
    const task = await test.service.dispatch(main, request)
    const worker = test.ctx.agents.get(task.attempts.at(-1)?.sessionId ?? SessionId('missing'))
    await vi.waitFor(() => { expect(worker?.status).toBe('running') })
    const watch = vi.spyOn(SessionActivityDigests.prototype, 'watch')
    await test.service.dispatch(main, { ...request, key: 'drama-2', title: '转写《江湖》' })
    expect(watch.mock.calls.map(call => call[2])).toEqual(['转写《江湖》'])
    watch.mockClear()
    await first.dispose()
    await test.ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0 })
    expect(watch).toHaveBeenCalledWith(main.id, worker?.id, '转写《山河》')
    await test.service.stop(main.id, task.id, 1)
  })

  it('adds digest guidance to Main only when activity digests are delivered', () => {
    expect(mainSessionPrompt({ unattended: false, taskFolders: false })).not.toContain('Activity of the Sessions you dispatched')
    expect(mainSessionPrompt({ unattended: false, taskFolders: false }, true)).toContain('就把问题原文转告用户，并说明要在该执行会话里回答')
    expect(mainSessionPrompt({ unattended: true, taskFolders: false }, true)).toContain('摘要带 "Needs your attention" 时用一句话记下，等回执处理。')
  })
})
