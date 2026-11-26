/** The real Loader and Agent loop retain the old rejection and then observe renewed Muse credentials. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('checks once, records rejection, then reads the renewed token without restarting or generating', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'executor', name: 'cordis:executor' }, { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'expired-fixture' } },
  ], builtins: { executor: NativeToolExecutor, prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.headers.authorization === 'Bearer expired-fixture'
      ? { code: 401, msg: 'private server message' } : { code: 200, rows: [], total: 0 }))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Fixture server has no TCP address')
    await ctx.loader.create({ name: 'cordis:jubian', config: {
      ledgerRoot: home, workspaceSecrets: false, baseUrl: `http://127.0.0.1:${address.port}/prod-api`,
    } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('first-check', 'jubian_catalog', { method: 'auth' }), textResponse('Authentication was rejected.'),
      toolCallResponse('renewed-check', 'jubian_catalog', { method: 'auth' }), textResponse('Read access is now confirmed.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('auth-owner'), { provider: 'mock', model: 'mock' }, { cwd: home })
    const ask = (text: string): void => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })) }
    ask('Check my current Jubian connection without generating anything.')
    await agent.whenIdle()
    await ctx.jubianToken.set('renewed-fixture')
    expect((await ctx.credentials.resolve(credentialRef('JUBIANAI_ADMIN_TOKEN')))?.value).toBe('renewed-fixture')
    ask('I renewed the token in Muse. Check again once.')
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(2)
    expect(results[0]?.isError).toBe(true)
    expect(results[1]?.isError).not.toBe(true)
    const failed = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(failed?.type === 'tool/result' && failed.data.error).toMatchObject({
      name: 'JubianAuthenticationCheckError', code: 'AUTHENTICATION_REQUIRED',
    })
    expect(results).toMatchSnapshot('renewed credential check')
    expect(JSON.stringify(results)).not.toMatch(/expired-fixture|renewed-fixture|private server message/)
    expect(requests).toEqual(['Bearer expired-fixture', 'Bearer renewed-fixture'].map(authorization => ({
      method: 'GET', path: '/prod-api/aigc/script/list?pageNum=1&pageSize=1', authorization,
    })))
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[3]?.messages.some(message => message.role === 'tool'
      && JSON.stringify(message.content).includes('read_access_confirmed'))).toBe(true)
  } finally {
    try { await ctx.fiber.dispose() }
    finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    }
  }
})
