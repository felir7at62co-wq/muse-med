/** Current native-draft guidance must reach resumed conversations, not only new skill reads. */
import { expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import * as CreationPolicy from '../src/creation-policy.ts'
import * as JianyingDraft from '../src/jianying-draft.ts'

/** Text actually sent to the model, including in-history system updates. */
function systemText(request: GenerateOptions): string {
  return request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
    .filter(part => part.type === 'text').map(part => part.text).join('\n')
}

it.each([false, true])('refreshes legacy draft guidance in the same Agent; in-history updates=%s', async (inHistory) => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'subprocess', name: 'cordis:subprocess' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, subprocess: LocalSubprocess, 'native-draft': JianyingDraft } })
  try {
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const legacy = '历史草稿曾用 E:\\old-build\\.desktop-build\\project\\scripts\\draft_generator.py 的 DraftGenerator。'
    const adapter = new MockAdapter([textResponse(legacy), textResponse('使用当前原生工具。'),
      textResponse('重新挂载后继续。'), textResponse('恢复保存的会话后继续使用原生工具。')])
    if (inHistory) { adapter.systemPromptUpdate = 'in-history'; adapter.toolUpdate = 'in-history' }
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('legacy-draft-route'), { provider: 'mock', model: 'mock' }, { cwd: home })
    await agent.ctx.plugin(CreationPolicy)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    }
    await send('保留之前的草稿工作。')
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'jianying_draft')).not.toBe(true)
    const mount = () => ctx.loader.create({ name: 'cordis:native-draft', config: {
      source: home, pythonPath: process.execPath, timeoutMs: 10_000, graceMs: 50,
      maxInputBytes: 10_000, maxOutputBytes: 10_000,
    } })
    const draft = await mount()
    await ctx.loader.await()
    await send('继续生成剪映草稿。')
    const current = adapter.requests[1]!
    expect(current.tools?.some(tool => tool.name === 'jianying_draft')).toBe(true)
    expect(JSON.stringify(current.messages)).toContain(JSON.stringify(legacy).slice(1, -1))
    expect(systemText(current)).toContain('## 剪映草稿：当前原生入口')
    expect(systemText(current)).toContain('历史会话')
    expect(systemText(current)).toContain('不要沿用历史记录中的绝对开发路径')
    expect(systemText(current)).toContain('audio_mode="embedded"')
    expect(systemText(current)).toContain('BGM 独立')
    expect(systemText(current)).toContain('未声明模式的旧请求仍走独立主音轨')
    expect(systemText(current)).toContain('不新增用户审批')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'system/message')
      .some(event => JSON.stringify(event.data).includes('## 剪映草稿：当前原生入口'))).toBe(true)
    await ctx.loader.resolve(draft).fiber!.dispose()
    const without = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(without.sections.some(section => section.name === 'tool:jianying_draft')).toBe(false)
    await mount()
    await ctx.loader.await()
    const restored = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(restored.sections.filter(section => section.name === 'tool:jianying_draft')).toHaveLength(1)
    await send('继续使用新入口，不执行历史脚本。')
    expect(systemText(adapter.requests[2]!)).toContain('## 剪映草稿：当前原生入口')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
    const { agent: resumed } = await ctx.agents.create({ sessionId: SessionId('resumed-legacy-draft-route'),
      agentOptions: { provider: 'mock', model: 'mock' }, seed: [...agent.session.snapshotEvents()] })
    await resumed.ctx.plugin(CreationPolicy)
    resumed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '恢复会话，继续交付草稿。' }] }))
    await resumed.whenIdle()
    expect(systemText(adapter.requests[3]!)).toContain('## 剪映草稿：当前原生入口')
    expect(JSON.stringify(adapter.requests[3]!.messages)).toContain(JSON.stringify(legacy).slice(1, -1))
    expect(adapter.requests[3]!.tools?.some(tool => tool.name === 'jianying_draft')).toBe(true)
  } finally { await ctx.fiber.dispose() }
})
