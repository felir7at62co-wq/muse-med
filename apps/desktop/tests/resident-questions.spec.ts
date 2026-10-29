/** Product discovery keeps both shipped question tools usable before professional-tool discovery. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Discovery from '@deepseek-ai/dsh-tool-discovery'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as BotQuestions from './fixtures/resident-bot-questions.mjs'

const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it.each(['classic', 'bot'] as const)('presents and executes the %s question tool without a discovery call', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-resident-questions-'))
  const ctx = new Context()
  try {
    const row = loadOverlayPatches('resident-question-test', patchPath)
      .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
    if (!row) throw new Error('Missing product tool discovery row')
    const config: unknown = row.config
    if (!config || typeof config !== 'object' || !('alwaysLoad' in config)) throw new Error('Missing resident tool names')
    const names: unknown = config.alwaysLoad
    if (!Array.isArray(names) || !names.every((name: unknown): name is string => typeof name === 'string')) {
      throw new Error('Resident tool names must be strings')
    }
    const discovery = Discovery.Config({ ...config, alwaysLoad: names })
    expect(discovery.alwaysLoad).toContain('ask_user_question')
    expect(discovery.alwaysLoad).toContain('ask_user')
    expect(discovery.alwaysLoad).not.toContain('video_inspect')
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, llm: Llm, sessions: Sessions, projections: Projections,
      prompt: SystemPrompt, tools: Tools, agents: Agents, loop: AgentLoop,
      discovery: Discovery, questions: UserQuestions, ask: AskUser, botQuestions: BotQuestions })
    const composition = join(root, 'cordis.yml')
    await writeFile(composition, JSON.stringify([
      { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
      { id: 'projections', name: 'cordis:projections' }, { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' }, { id: 'agents', name: 'cordis:agents' },
      { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
      { id: 'questions', name: 'cordis:questions' }, { id: 'ask', name: 'cordis:ask' },
      ...mode === 'bot' ? [{ id: 'bot-tools', name: 'cordis:botQuestions' }] : [],
      { id: 'discovery', name: 'cordis:discovery', config: discovery },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composition).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    if (mode === 'bot') {
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'bot-tools')
      expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
      expect(ctx.tools.schemas().map(schema => schema.name)).toContain('ask_user')
    }
    const answer = vi.fn(async () => ({ answers: [{ id: 'delivery', selected: ['Word'] }] }))
    ctx.on('user-questions/request', answer)
    ctx.tools.register(defineTool({ name: 'video_inspect', description: 'Inspect video frames.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'No fixture video.',
    }))
    const tool = mode === 'bot' ? 'ask_user' : 'ask_user_question'
    const args = mode === 'bot' ? { question: 'Which delivery format?', options: [{ label: 'Word' }, { label: 'Markdown' }] }
      : { questions: [{ id: 'delivery', question: 'Which delivery format?', options: [{ label: 'Word' }, { label: 'Markdown' }] }] }
    const responses = [toolCallResponse('resident-question-call', tool, args), ...mode === 'classic' ? [textResponse('Answered.')] : []]
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = (await ctx.agents.create({ sessionId: SessionId(`${mode}-resident-question`), meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Clarify the output format.' }] }))
    await agent.whenIdle()
    const initial = adapter.requests[0]
    expect(initial?.tools?.filter(schema => schema.name === tool)).toHaveLength(1)
    expect(initial?.tools?.some(schema => schema.name === 'video_inspect')).toBe(false)
    if (mode === 'bot') expect(initial?.tools?.some(schema => schema.name === 'ask_user_question')).toBe(false)
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.data.name)).toEqual([tool])
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).not.toBe(true)
    expect(JSON.stringify(result?.data.message.content)).toContain(mode === 'bot' ? 'The card is on screen' : 'Word')
    expect(answer).toHaveBeenCalledTimes(mode === 'bot' ? 0 : 1)
    responses.push(toolCallResponse('release-resident-question', 'tool_context', { operation: 'release', tools: [tool] }),
      textResponse('Checked.'))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the question tool available.' }] }))
    await agent.whenIdle()
    const release = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
    expect(release?.data.message.isError).toBe(true)
    expect(JSON.stringify(release?.data.message.content)).toContain('Constant tools already remain available')
    const shown = (await ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map(schema => schema.name)
    expect(shown).toContain(tool)
    expect(shown).not.toContain('video_inspect')
    expect(ctx.toolDiscovery.state(agent)).toEqual({ loaded: [], pinned: [] })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
