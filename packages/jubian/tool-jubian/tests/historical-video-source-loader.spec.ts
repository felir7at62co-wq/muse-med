/** Native original-source proof through a configured Loader using a record-shaped offline replay. */
import { createHash } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

const card = { id: 201, scriptId: 101, episodeId: 21 }
const identity: Jubian.HistoricalVideoSourceIdentity = {
  scriptId: card.scriptId, episodeId: card.episodeId, storyboardId: card.id, taskId: 301, subtaskId: 401, firstResultId: 501,
}
const task = { id: identity.taskId, storyboardId: card.id, scriptId: card.scriptId, episodeId: card.episodeId,
  taskType: 1, taskStatus: 'succeeded' }
const original = 'https://jubian-aigc.tos-cn-beijing.volces.com/offline/p3-base.mp4'
const processed = 'https://jubian-aigc.tos-cn-beijing.volces.com/offline/p3-upscaled.mp4'
const media = Buffer.from('000000106674797069736f6d00000000', 'hex')
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

it('uses only the exact original URL and a fresh native download owned by the current Session', async () => {
  const fixture = await configurationFixture({ hmr: false, rows: [
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:native-executor' },
    { name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-fixture' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, 'native-executor': NativeToolExecutor, credentials: MemoryCredentials, jubian: Jubian } })
  const { ctx } = fixture
  const project = await realpath(fixture.home)
  const basePath = join(project, 'original.mp4'), processedPath = join(project, 'upscaled.mp4')
  let current = original
  let lastTaskType = 1
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const path = url.pathname.replace('/prod-api', '')
    if (url.href === original || url.href === processed) return new Response(media)
    if (path === '/aigc/storyboard/201' && init?.method === 'GET') return Response.json({ code: 200, data: card })
    if (path === '/aigc/storyboard/byStoryboard/201' && init?.method === 'GET') return Response.json({ code: 200, data: [task] })
    if (path === '/admin/aigc/video/task/301' && init?.method === 'GET') return Response.json({ code: 200, data: task })
    if (path === '/admin/aigc/video/task/sub/list' && init?.method === 'POST') return Response.json({ code: 200,
      data: { total: 1, rows: [{ id: identity.subtaskId, aigcVideoTaskId: task.id, scriptId: task.scriptId, storyboardId: card.id,
        episodeId: card.episodeId, taskStatus: 'succeeded', resultList: [{
          firstResultId: identity.firstResultId, taskType: 1, resultStatus: 'succeeded', tosVideoUrl: original,
          lastTaskType, lastResultStatus: 'succeeded', lastTosVideoUrl: current, hdCount: lastTaskType === 1 ? 0 : 1,
        }] }] } })
    throw new Error('Unexpected offline replay request')
  })
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: project, workspaceSecrets: false,
      historicalVideoSourceVerification: true } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await expect.poll(() => typeof ctx.get('jubianHistoricalVideoSource')).toBe('function')
    const verify = ctx.get('jubianHistoricalVideoSource')!
    const lookup = { method: 'sources', script_id: card.scriptId, storyboard_id: card.id }
    const request = (media_url: string, output_path: string) => ({ method: 'download', media_kind: 'video',
      media_url, output_path, resume: true })
    const adapter = new MockAdapter([
      toolCallResponse('read-card', 'jubian_video', lookup),
      toolCallResponse('fetch-base', 'jubian_media', request(original, basePath)),
      textResponse('Read and downloaded the original.'),
      toolCallResponse('read-processed-card', 'jubian_video', lookup),
      toolCallResponse('fetch-latest', 'jubian_media', request(processed, processedPath)),
      textResponse('Read the still-available original and later derivative.'),
      toolCallResponse('read-contradictory-card', 'jubian_video', lookup),
      textResponse('The current card history is contradictory.'),
      toolCallResponse('read-card-other-session', 'jubian_video', lookup),
      toolCallResponse('try-reused-base', 'jubian_media', request(original, basePath)),
      textResponse('The second Session reused an existing file.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const normal = { provider: 'mock', model: 'mock' } as const
    const agent = await ctx.agentLoop.create(SessionId('original-source-owner'), normal, { cwd: project })
    const ask = async (worker: typeof agent) => {
      worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the card source.' }] }))
      await worker.whenIdle()
    }
    const input = { ...identity, projectDir: project, sourcePath: basePath }
    const signal = new AbortController().signal
    await ask(agent)
    const recorded = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(recorded.map(event => event.data.message.isError)).toEqual([false, false])
    const baseDigest = sha(original)
    expect(recorded[0]?.data.meta).toMatchObject({ [TOOL_BODY_META_KEY]: {
      historical_video_sources: [{ ...identity, originalUrlSha256: baseDigest }],
    } })
    expect(recorded[1]?.data.meta).toMatchObject({ [TOOL_BODY_META_KEY]: {
      path: basePath, bytes: media.length, source_sha256: baseDigest, reused: false,
    } })
    const originalReceipt = { path: basePath, sha256: sha(media), urlSha256: baseDigest,
      receiptPath: `${basePath}.jubian-video-${baseDigest.slice(0, 16)}.json` }
    await expect(verify(agent.session, input, signal)).resolves.toEqual(originalReceipt)
    await expect(verify(agent.session, { ...input, episodeId: 22 }, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
    await expect(verify(agent.session, { ...input, subtaskId: 402 }, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
    const fork = ctx.sessions.fork(agent.session, undefined, SessionId('inherited-source-records'))
    await expect(verify(fork, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')

    current = processed
    lastTaskType = 20
    await ask(agent)
    await expect(verify(agent.session, input, signal)).resolves.toEqual(originalReceipt)
    await expect(verify(agent.session, { ...input, sourcePath: processedPath }, signal))
      .rejects.toThrow('HISTORICAL_VIDEO_SOURCE_DOWNLOAD')
    await writeFile(basePath, Buffer.alloc(media.length))
    await expect(verify(agent.session, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
    await writeFile(basePath, media)

    // The 035 replay shape repeats the same original URL as latest on generation task type 1.
    // A history result that calls that same latest URL an upscale cannot issue authority.
    current = original
    await ask(agent)
    await expect(verify(agent.session, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
    lastTaskType = 1
    const other = await ctx.agentLoop.create(SessionId('no-fresh-download'), normal, { cwd: project })
    await ask(other)
    const reused = other.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)?.data.message.content[0]
    expect(reused?.type === 'text' && JSON.parse(reused.text)).toMatchObject({ reused: true })
    await expect(verify(other.session, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_DOWNLOAD')
    const copied = ToolCallId('copied-original-text')
    other.session.append('tool/call', { turn: 2, step: 1, name: 'jubian_media', callId: copied,
      arguments: JSON.stringify(request(original, basePath)) })
    other.session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId: copied, isError: false,
      content: recorded[1]?.data.message.content ?? [] }) }, { surfaceOp: 'append' })
    await expect(verify(other.session, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_DOWNLOAD')
    expect(fetcher.mock.calls.filter(([input]) => String(input) === original)).toHaveLength(1)

  } finally {
    fetcher.mockRestore()
    await ctx.fiber.dispose()
  }
})
