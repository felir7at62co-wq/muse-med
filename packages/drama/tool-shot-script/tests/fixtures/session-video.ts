/** Real conversation, video-choice and compiler owners with a catalogue-only transport. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianVideoSelection } from '@deepseek-ai/dsh-tool-jubian'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import * as ShotCompiler from '../../src/index.ts'
import type { DramaShotReport } from '../../src/types.ts'

const catalogue: unknown = JSON.parse(await readFile(new URL('../../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8'))

/**
 * Mount actual persisted conversations and Loader-owned compiler/video plugins.
 * @param root - Private directory containing the workspace and reusable session logs.
 * @param config - Actual compiler deployment settings.
 * @param useDefault - Whether a first use resolves the product's Seedance 2.5 default.
 * @returns Conversation creation/resume, scripted real tool turns and catalogue requests.
 */
export async function sessionVideoShot(root: string, config: ShotCompiler.Config, useDefault = true) {
  const ctx = new Context()
  const requests: Array<{ method: string; path: string }> = []
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Loader)
    const client = new JubianClient({ baseUrl: 'https://catalogue.invalid', credential: async () => 'fixture-token',
      fetch: async (url, init) => {
        const address = new URL(url instanceof Request ? url.url : url.toString())
        const method = init?.method ?? 'GET'
        requests.push({ method, path: `${address.pathname}${address.search}` })
        if (method !== 'GET' || address.pathname !== '/model/charge/getSelectList' || address.search !== '?taskType=1') {
          throw new Error('This fixture permits catalogue reads only')
        }
        if (typeof catalogue !== 'object' || catalogue === null || !('1' in catalogue)) throw new Error('Missing video catalogue fixture')
        return new Response(JSON.stringify({ code: 200, data: catalogue['1'] }))
      } })
    const video = { apply(scope: Context) {
      scope.plugin(JubianVideoSelection, { client, ledger: new JubianLedger({ root: join(root, 'ledger') }), enabled: true,
        ...(useDefault ? { defaultModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } } : {}) })
    } }
    Object.assign(ctx.loader.builtins, { include: Include, video, compiler: ShotCompiler })
    const directory = join(root, 'loader')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'cordis.json')
    await writeFile(path, JSON.stringify([{ id: 'video-owner', name: 'cordis:video' },
      { id: 'compiler-owner', name: 'cordis:compiler', config }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    for (const row of ctx.loader.entries()) await row.fiber?.await()
    const responses: ConstructorParameters<typeof MockAdapter>[0] = []
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    const create = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id),
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })).agent
    const resume = async (id: string) => (await ctx.agents.resume({ resumeSessionId: SessionId(id),
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    const run = async (agent: Agent, args: Record<string, unknown>): Promise<DramaShotReport> => {
      const before = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').length
      responses.push(toolCallResponse(`shot-review-${agent.id}-${before + 1}`, 'drama_shot', args), textResponse('Review recorded.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the authored shots without generating media.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').slice(before)
      const message = results[0]?.data.message
      const text = message?.content[0]
      if (results.length !== 1 || message?.isError || text?.type !== 'text') {
        const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
        throw new Error(`Expected one successful compiler report: ${JSON.stringify({ message, requests: adapter.requests.length, end })}`)
      }
      const value: unknown = JSON.parse(text.text)
      const definition = ctx.tools.get('drama_shot')
      if (definition === undefined) throw new Error('Missing registered compiler')
      const violations = validateJsonSchemaValue(definition.output.schema, value, '')
      if (violations.length > 0) throw new Error(`Invalid report: ${JSON.stringify(violations)}`)
      return value as DramaShotReport
    }
    return { ctx, adapter, requests, create, resume, run, service: ctx.jubianVideoSelection,
      dispose: () => ctx.fiber.dispose() }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
