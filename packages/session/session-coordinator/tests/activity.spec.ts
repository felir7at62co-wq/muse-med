/** Main receives status digests of its executing workers when the Host mounts session activity. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionActivityDigests from '@deepseek-ai/dsh-session-activity'
import type { DispatchRequest } from '../src/types.ts'
import { mainSessionPrompt } from '../src/prompt.ts'
import { setup, textResponse } from './fixture.ts'

type Script = Parameters<typeof setup>[1]

const request: DispatchRequest = { key: 'drama-1', title: '转写《山河》', instructions: '每部作品一个执行会话', reason: '新的候选作品' }

describe('coordinator activity watches', () => {
  it('wakes Main for a stalled worker and shows its status in the session list', { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coordinator-activity-'))
    const test = await setup(root, [textResponse('ack'), 'hang', ...Array.from({ length: 20 }, () => textResponse('ack'))])
    onTestFinished(async () => {
      await test.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const main = await test.makeAgent('main', 'main-session')
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '转写《山河》' }] }))
    await main.whenIdle()
    const before = JSON.parse(await test.service.search(main, '')) as { sessions: object[] }
    expect(before.sessions.every(row => !('status' in row))).toBe(true)
    await test.ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 50 })
    const digests: string[] = []
    test.ctx.on('session/event', (session, event) => {
      if (session.id === main.id && event.type === 'user/message' && event.data.source.kind === 'session-activity') {
        digests.push(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      }
    }, { global: true })

    const task = await test.service.dispatch(main, request)
    const worker = task.attempts.at(-1)?.sessionId
    await vi.waitFor(() => { expect(digests.some(text => text.includes('no new activity'))).toBe(true) }, { timeout: 15000 })
    expect(digests.find(text => text.includes('no new activity'))).toContain(`- 转写《山河》 [${worker}] running for`)
    const listed = JSON.parse(await test.service.search(main, '')) as { sessions: { sessionId: string; status?: string }[] }
    expect(listed.sessions.find(row => row.sessionId === worker)?.status).toMatch(/^running for /u)
    await test.service.stop(main.id, task.id, 1)
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

  it('routes a cloud project lookup directly in an attended studio-enabled conversation', () => {
    const attended = { unattended: false, taskFolders: false }
    expect(mainSessionPrompt(attended, false, true)).toContain('jingliu_projects')
    expect(mainSessionPrompt(attended)).not.toContain('jingliu_projects')
    expect(mainSessionPrompt({ ...attended, unattended: true }, false, true)).not.toContain('jingliu_projects')
  })

  it('adds digest guidance to Main only when activity digests are delivered', () => {
    expect(mainSessionPrompt({ unattended: false, taskFolders: false })).not.toContain('Activity of the Sessions you dispatched')
    expect(mainSessionPrompt({ unattended: false, taskFolders: false }, true)).toContain('执行会话在等回答或审批，就告诉用户到该执行会话里处理')
    expect(mainSessionPrompt({ unattended: true, taskFolders: false }, true)).toContain('摘要带 "Needs your attention" 时用一句话记下，等回执处理。')
  })
})
