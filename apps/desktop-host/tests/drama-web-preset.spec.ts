/** Drama resource tools activate only for an explicitly configured secure API. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

interface Expression {
  readonly __jsExpr: string
}

interface PluginRow {
  readonly id: string
  readonly name: string
  readonly disabled: Expression
  readonly config: {
    readonly baseUrl: Expression
    readonly allowedMediaOrigins: Expression
  }
}

const parseOptions = { customTags: [
  { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) },
] }

function configuration(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function evaluate(expression: Expression, env: Readonly<Record<string, string>>): unknown {
  return runInNewContext(expression.__jsExpr, { URL, process: { env } }, { timeout: 1000 })
}

it('shares one secure opt-in between manual installation and the short-drama preset', () => {
  const preset = parseYaml(configuration('../presets/short-drama/agent.cordis.yml'), parseOptions) as PluginRow[]
  const patch = parseYaml(configuration('../../../third_party/plugins/muse-drama-web/cordis.patch.yml'), parseOptions) as { insert: PluginRow[] }[]
  const rows = preset.filter(row => row.id === 'muse-drama-web')
  expect(rows).toEqual(patch.flatMap(step => step.insert))
  expect(rows).toHaveLength(1)
  const row = rows[0]
  expect(row?.name).toBe('muse-drama-web')
  if (!row) throw new Error('Short-drama preset is missing the drama resource plugin')

  for (const baseUrl of ['', 'not-a-url', 'http://drama.test/api/v1', 'https://drama.test',
    'https://drama.test/api/v1//', 'https://drama.test/api/v1?', 'https://drama.test/api/v1#',
    'https://identity@drama.test/api/v1', 'https://' + 'a'.repeat(16_384) + '/api/v1']) {
    expect(evaluate(row.disabled, { DRAMA_WEB_BASE_URL: baseUrl }), baseUrl).toBe(true)
  }
  expect(evaluate(row.disabled, {})).toBe(true)

  const baseUrl = 'https://drama.test/api/v1/'
  const env = { DRAMA_WEB_BASE_URL: ' ' + baseUrl + ' ' }
  expect(evaluate(row.disabled, env)).toBe(false)
  expect(evaluate(row.config.baseUrl, env)).toBe(baseUrl)
  expect(evaluate(row.config.allowedMediaOrigins, env)).toEqual([])
  expect(evaluate(row.config.allowedMediaOrigins, { ...env, DRAMA_WEB_MEDIA_ORIGIN: ' https://media.test ' }))
    .toEqual(['https://media.test'])
})

it('activates the bundled source and runs library search through the native tool registry', async () => {
  const modulePath = new URL('../../../third_party/plugins/muse-drama-web/src/index.js', import.meta.url).href
  const plugin = await import(/* @vite-ignore */ modulePath)
  const context = new Context()
  const fetch = vi.fn(async () => Response.json({ items: [{ id: 7, title: '示例短剧' }] }))
  vi.stubEnv('DRAMA_WEB_TEST_TOKEN', 'mock-token')
  vi.stubGlobal('fetch', fetch)
  try {
    await context.plugin(SystemPrompt)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(AgentRegistry)
    await context.plugin(Tools)
    await context.plugin(NativeToolExecutor)
    await context.plugin(plugin, { baseUrl: 'https://drama.test/api/v1', tokenEnv: 'DRAMA_WEB_TEST_TOKEN' })
    expect(context.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'drama_web_download', 'drama_web_library', 'drama_web_login',
    ]))

    const result = await context.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('library'), name: 'drama_web_library', arguments: '{"keyword":"示例"}' }],
      signal: new AbortController().signal,
    })
    expect(result.results[0]?.result).toMatchObject({
      isError: false,
      value: { ok: true, count: 1, items: [{ id: 7, title: '示例短剧' }] },
    })
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    await context.fiber.dispose()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
})
