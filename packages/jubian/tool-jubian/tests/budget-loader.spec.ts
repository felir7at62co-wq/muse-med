import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as DramaSettings from '@deepseek-ai/dsh-drama-settings'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Jubian from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

it('mounts the drama default and enforces its current limit in the real tool composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-loader-'))
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = url instanceof Request ? url.url : url.toString()
    if (!path.includes('/model/charge/getSelectList?taskType=2')) {
      throw new Error(`Unexpected provider request: ${path}`)
    }
    return new Response(JSON.stringify({ code: 200, data: [{ id: 42, standardId: 42, modelId: 'gpt-image-2',
      platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张', genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }] }),
    { status: 200 })
  })
  try {
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      '- name: test:settings',
      "- name: '@deepseek-ai/dsh-drama-settings'",
      '- name: test:credentials',
      '  config:',
      '    JUBIANAI_ADMIN_TOKEN: mocked-token',
      "- name: '@deepseek-ai/dsh-tool-jubian'",
      '  config:',
      `    ledgerRoot: ${JSON.stringify(join(root, 'ledger'))}`,
      '    workspaceSecrets: false',
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['test:settings', MemorySettings], ['@deepseek-ai/dsh-drama-settings', DramaSettings],
      ['test:credentials', MemoryCredentials], ['@deepseek-ai/dsh-tool-jubian', Jubian],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.settings.get('drama')).toMatchObject({ seriesBudgetCents: 400_000 })
    await ctx.settings.update('drama', { seriesBudgetCents: 0 })
    const tool = ctx.tools.get('jubian_video')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('Missing Jubian video tool')
    const args = { method: 'image_generate', script_id: 2708, asset_name: 'x', asset_type: 1,
      prompt: 'p', idempotency_key: 'new-paid-image' }
    const result = await ctx.tools.execute({
      callId: ToolCallId('budget-loader'), name: 'jubian_video', arguments: args,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('授权上限 0.00 CNY') } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await new JubianLedger({ root: join(root, 'ledger') }).records()).toEqual([])
    const toolRow = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-jubian')
    await toolRow?.fiber?.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
