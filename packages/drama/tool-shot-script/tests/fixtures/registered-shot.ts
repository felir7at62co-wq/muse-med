/** Loader-owned compiler calls through the real tool registry. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as ShotCompiler from '../../src/index.ts'
import type { DramaShotReport } from '../../src/types.ts'

/**
 * Load a compiler row from a temporary composition without replacing its tools service.
 * @param root - Private fixture directory receiving the Loader configuration.
 * @param config - Deployment configuration supplied to the actual compiler plugin.
 * @returns Registered tool execution, checked report decoding, and awaited owner disposal.
 */
export async function registeredShot(root: string, config: ShotCompiler.Config) {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, compiler: ShotCompiler })
    const path = join(root, 'compiler.cordis.json')
    await writeFile(path, JSON.stringify([
      { name: 'cordis:prompt' }, { name: 'cordis:tools' },
      { id: 'compiler-under-test', name: 'cordis:compiler', config },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const registry = ctx.get('tools')
    const definition = registry?.get('drama_shot')
    if (registry === undefined || definition === undefined) throw new Error('The Loader did not register drama_shot')
    let calls = 0
    const execute = (args: Record<string, unknown>) => registry.execute({ name: 'drama_shot', arguments: args,
      signal: new AbortController().signal, callId: ToolCallId(`shot-review-${++calls}`) })
    const report = async (args: Record<string, unknown>): Promise<DramaShotReport> => {
      const result = await execute(args)
      const content = result.content[0]
      if (result.isError || content?.type !== 'text') throw new Error(`Expected a compiler report: ${JSON.stringify(result)}`)
      const value: unknown = JSON.parse(content.text)
      const violations = validateJsonSchemaValue(definition.output.schema, value, '')
      if (violations.length > 0) throw new Error(`Invalid compiler report: ${JSON.stringify(violations)}`)
      return value as DramaShotReport
    }
    return { execute, report, registry, dispose: () => ctx.fiber.dispose() }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
