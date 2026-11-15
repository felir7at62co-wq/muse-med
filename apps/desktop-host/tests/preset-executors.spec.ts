/** Product preset executor rows load through the registry and select exactly one model surface. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

/** Selection-only runtime; no program or media is executed by this configuration test. */
class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(): Promise<PtcRunResult> { throw new Error('Executor selection must not run a program') }
}

it('loads native and PTC executor selections from every product preset without the removed mode plugin', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Agents)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(PresentationRuntime)
    await ctx.plugin(AgentPresets, { default: 'short-drama' })
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-tool-executor-native', NativeExecutor],
      ['@deepseek-ai/dsh-tool-executor-ptc', PtcExecutor],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected executor module ${specifier}`)
        return modules.get(specifier)
      } }
    ctx.tools.register(defineContentToolFixture({ name: 'preset_probe', description: 'Local configuration probe',
      parameters: {}, async execute() { return [{ type: 'text', text: 'probe' }] } }))
    for (const id of ['short-drama', 'bot-coordinator', 'standard', 'minimal', 'ptc', 'creation', 'cordis']) {
      const source = await readFile(new URL(`../presets/${id}/agent.cordis.yml`, import.meta.url), 'utf8')
      expect(source).not.toContain('@deepseek-ai/dsh-agent-tool-presentation')
      const rows = parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }) as PresetDefinition['plugins']
      const plugins = rows.filter(row => row.id === 'tool-executor-native' || row.id === 'tool-executor-ptc')
      await ctx.agentPresets.register({ id, plugins })
      expect(await ctx.agentPresets.resolve(id)).not.toHaveProperty('broken')
      await using scope = await ctx.agentPresets.acquireScope(id)
      const assembly = await ctx.systemPrompt.assemble({ scope: scope.key })
      expect(assembly.tools.map(tool => tool.name), id).toEqual(['ptc', 'creation', 'cordis'].includes(id) ? ['run_code'] : ['preset_probe'])
      expect(ctx.tools.schemas(scope.key).map(tool => tool.name)).toEqual(['preset_probe'])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
