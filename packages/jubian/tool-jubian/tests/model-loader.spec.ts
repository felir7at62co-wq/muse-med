/** Model settings tool registration, schema, and rendered output through the real Loader. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Jubian from '../src/index.ts'

it('loads model preview/apply, renders free outcomes, and disposes registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-model-loader-'))
  const ctx = new Context()
  const modelConfig = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
    prompt: 'keep', materialList: [] }
  let board = { id: 1, scriptId: 2708, episodeId: 9, isGenerate: 1, modelConfig: JSON.stringify(modelConfig) }
  const calls: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(String(init?.method))
    const path = url instanceof Request ? url.url : url.toString()
    let data: unknown
    if (path.includes('/model/charge/')) data = [{ id: 11, modelId: modelConfig.modelId, platformId: 'YU_DIAN',
      genTypes: [{ id: 7, type: 3 }], videoStandards: [
        { id: 91, ratio: '9:16', resolution: '720p', genNum: 1 },
        { id: 92, ratio: '9:16', resolution: '1080p', genNum: 1 },
      ] }]
    else if (init?.method === 'PUT') {
      if (typeof init.body !== 'string') throw new Error('Expected JSON request body')
      board = JSON.parse(init.body) as typeof board; data = null
    } else data = board
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
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
      ['test:credentials', MemoryCredentials], ['@deepseek-ai/dsh-tool-jubian', Jubian],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const tool = ctx.tools.get('jubian_model')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('Missing jubian_model')
    const args = { method: 'preview', script_id: 2708, project_dir: root, scope: 'storyboards',
      storyboard_ids: [1], changes: { resolution: '1080p' } }
    expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
    expect(validateJsonSchemaValue(tool.parameters, { ...args, changes: { prompt: 'replace' } }, '')).not.toEqual([])
    const runContext = { signal: new AbortController().signal } as ToolRunContext
    const plan = await tool.execute(args, runContext) as Record<string, unknown>
    expect(calls.every(method => method === 'GET')).toBe(true)
    const applyArgs = { method: 'apply', script_id: 2708, project_dir: root,
      preview_path: plan.preview_path, idempotency_key: plan.fingerprint }
    expect(validateJsonSchemaValue(tool.parameters, applyArgs, '')).toEqual([])
    const outcome = await tool.execute(applyArgs, runContext) as JsonValue
    expect(tool.output.render(applyArgs, outcome)).toMatchInlineSnapshot(`
      [
        {
          "text": "{
        \"status\": \"applied\",
        \"replayed\": false,
        \"paid_requests\": 0,
        \"items\": [
          {
            \"storyboard_id\": 1,
            \"status\": \"applied\"
          }
        ],
        \"next\": \"Existing storyboards only; defaults and produced media are unchanged. On partial outcome, reconcile before a new preview; never change keys to retry.\"
      }",
          "type": "text",
        },
      ]
    `)
    expect(calls.filter(method => method === 'PUT')).toHaveLength(1)
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-jubian')
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('jubian_model')).toBeUndefined()
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
