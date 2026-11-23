/** Product classification and Chinese recall against schemas registered by real tool plugins. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { beforeAll, expect, it } from 'vitest'
import { collectToolCatalog, type ToolCatalog } from '../../../scripts/gen-tool-catalog.ts'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import { capabilityMemberships } from '../../../packages/core/tool-discovery/src/capabilities.ts'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'
import * as Qimao from '../../../third_party/plugins/muse-qimao-data/src/index.js'
import * as HongguoSearch from '../../../third_party/plugins/muse-hongguo-search/src/index.js'
import { registerLvpaopaoCatalog } from './fixtures/lvpaopao-catalog.mjs'
import { config, patchPath } from './fixtures/discovery-config.ts'

let catalog: ToolCatalog

function packagesFromRows(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry)
      || ('disabled' in entry && entry.disabled === true)) return []
    return [
      ...typeof entry.name === 'string' ? [entry.name] : [],
      ...'config' in entry ? packagesFromRows(entry.config) : [],
    ]
  })
}

beforeAll(async () => { catalog = await collectToolCatalog() })

it('does not register or expose the removed daemon memory integration', () => {
  const plugins = loadOverlayPatches('desktop-memory-composition', patchPath)
    .flatMap(patch => packagesFromRows(patch.insert))
  expect(plugins).not.toContain('@deepseek-ai/dsh-desktop-host/hindsight')
  expect(catalog.flatMap(entry => entry.schemas).map(schema => schema.name)).not.toContain('hindsight_memory')
  const require = createRequire(new URL('../package.json', import.meta.url))
  expect(() => require.resolve('@deepseek-ai/dsh-desktop-host/hindsight'))
    .toThrow(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }))
})

it('keeps account feedback submission and receipt queries resident in ordinary conversations', () => {
  const account = loadOverlayPatches('desktop-feedback-composition', patchPath)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'muse-account')
  expect(account?.config).toHaveProperty('feedbackTools', true)
  const names = catalog.flatMap(entry => entry.schemas).map(schema => schema.name)
  for (const name of ['muse_feedback_submit', 'muse_feedback_status']) {
    expect(config.alwaysLoad).toContain(name)
    expect(names).toContain(name)
  }
})

it.each(['short-drama', 'short-drama-v2', 'standard', 'bot-coordinator'])('classifies every harvested nonresident tool declared by the %s composition', async (preset) => {
  const source = await readFile(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const packages = new Set(packagesFromRows(yaml.load(source, { schema: entryListSchema })))
  const defaultsPath = fileURLToPath(new URL('../config/defaults.cordis.patch.yml', import.meta.url))
  for (const patch of [...loadOverlayPatches('desktop-discovery-defaults', defaultsPath),
    ...loadOverlayPatches('desktop-discovery-catalog', patchPath)]) {
    for (const name of packagesFromRows(patch.insert)) packages.add(name)
  }
  const schemas = catalog.filter(entry => packages.has(entry.pkg)).flatMap(entry => entry.schemas)
  expect(schemas.length).toBeGreaterThan(30)
  const resident = new Set([...config.alwaysLoad, 'tool_search', 'tool_context'])
  // The catalog boots shot-script with its optional remote packaging writer; Desktop mounts its local checker only.
  const deferred = schemas.filter(schema => !resident.has(schema.name) && schema.name !== 'muse_production')
  expect(deferred.length).toBeGreaterThan(10)
  expect(deferred.filter(schema => capabilityMemberships(schema.name, config.capabilities ?? []).length === 0)
    .map(schema => schema.name)).toEqual([])
  for (const name of ['drama_draft_dir', 'drama_project', 'video_contact_sheet']) {
    expect(schemas.map(schema => schema.name)).toContain(name)
  }
})

it.each([
  ['请找一下剪映草稿目录', 'drama_draft_dir'],
  ['先读取项目圣经', 'drama_project'],
  ['核对人物关系', 'drama_project'],
  ['我要修改画幅', 'drama_project'],
  ['帮我抽帧看视频', 'video_inspect'],
  ['需要提取字幕', 'video_ocr'],
  ['把台词转写出来', 'audio_transcribe'],
  ['写镜头脚本', 'drama_shot'],
  ['镜流工作台', 'jingliu_workflows'],
  ['镜流执行', 'jingliu_run'],
  ['镜流解说剧', 'jingliu_narration'],
  ['搜索技能目录', 'skill_catalog'],
  ['查找技能目录', 'skill_catalog'],
  ['找一下背景音乐', 'drama_bgm'],
  ['搜索技能', 'skill_catalog'],
])('finds %s from actual registered descriptions and configured aliases', (query, expected) => {
  const schemas = new Map(catalog.flatMap(entry => entry.schemas).map(schema => [schema.name, schema]))
  const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
    { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
  expect(index.search(query, config.maxResults ?? 8).map(result => result.name)).toContain(expected)
})

it('keeps native delivery, project and memory tools deferred while giving each a capability', () => {
  for (const name of ['drama_draft_dir', 'drama_project', 'jianying_draft', 'screenplay_export_docx',
    'load_workspace_dependencies', 'manuscript_revision', 'source_recover', 'skill_catalog', 'jingliu_run']) {
    expect(config.alwaysLoad).not.toContain(name)
    expect(capabilityMemberships(name, config.capabilities ?? []).length).toBeGreaterThan(0)
    expect(config.keywords?.[name]?.length).toBeGreaterThan(0)
  }
  expect(config.alwaysLoad).toContain('ask_user_question')
  expect(config.alwaysLoad).toContain('present')
})

it('loads the Script Workshop 视频转剧本 tool on demand from the short-drama preset and recalls it in Chinese', async () => {
  const source = await readFile(new URL('../presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
  expect(packagesFromRows(yaml.load(source, { schema: entryListSchema }))).toContain('@deepseek-ai/dsh-tool-workshop')
  const connection = loadOverlayPatches('desktop-workshop-composition', patchPath)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'workshop-connection')
  expect(connection?.name).toBe('@deepseek-ai/dsh-workbench-connection')
  const schemas = new Map(catalog.flatMap(entry => entry.schemas).map(schema => [schema.name, schema]))
  expect(schemas.has('workshop_video_transcribe')).toBe(true)
  const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
    { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
  for (const query of ['剧本工坊视频转剧本', '开始批量转写', '停止转写任务', '看看转写进度', '工坊流水线']) {
    expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain('workshop_video_transcribe')
  }
  expect(config.alwaysLoad).not.toContain('workshop_video_transcribe')
  expect(capabilityMemberships('workshop_video_transcribe', config.capabilities ?? [])).toEqual(['script-workshop'])
  expect(schemas.has('workshop_script_editor')).toBe(true)
  for (const query of ['打开剧本草稿', '精修剧本', '按集改稿']) {
    expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain('workshop_script_editor')
  }
  expect(config.alwaysLoad).not.toContain('workshop_script_editor')
  expect(capabilityMemberships('workshop_script_editor', config.capabilities ?? [])).toEqual(['script-workshop'])
})

it('recalls the account data-station Douyin downloader without making it resident or keeping local task controls', () => {
  const account = loadOverlayPatches('desktop-douyin-composition', patchPath)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'muse-account')
  expect(account?.config).toHaveProperty('douyinDownloadTool', true)
  const schemas = new Map(catalog.flatMap(entry => entry.schemas).map(schema => [schema.name, schema]))
  expect(schemas.get('douyin_download')?.description).toContain('通过数据站下载抖音视频')
  const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
    { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
  for (const query of ['抖音下载', '下载抖音视频', '抖音合集下载', '抖音下载进度']) {
    expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain('douyin_download')
  }
  expect(config.alwaysLoad).not.toContain('douyin_download')
  expect(capabilityMemberships('douyin_download', config.capabilities ?? [])).toContain('data-sourcing')
  expect(capabilityMemberships('muse_media_data', config.capabilities ?? [])).toContain('data-sourcing')
  for (const retired of ['douyin_data', 'douyin_download_task']) expect(config.keywords).not.toHaveProperty(retired)
})

it('keeps the Hongguo downloader resident and recalls its title lookup for complete Douyin short dramas', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    await ctx.plugin(HongguoSearch)
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...ctx.tools.schemas()].map(schema => [schema.name, schema]))
    expect(schemas.has('hongguo_search')).toBe(true)
    const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
      { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    expect(config.alwaysLoad).toContain('hongguo_download')
    expect(capabilityMemberships('hongguo_download', config.capabilities ?? [])).toContain('data-sourcing')
    for (const query of ['按剧名找短剧', '抖音短剧剧名']) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain('hongguo_search')
    }
    for (const name of ['hongguo_search', 'hongguo_download_info', 'hongguo_download_task']) {
      expect(config.alwaysLoad, name).not.toContain(name)
      expect(capabilityMemberships(name, config.capabilities ?? []), name).toContain('data-sourcing')
      expect(config.keywords?.[name]?.length, name).toBeGreaterThan(0)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('recalls the registered Lvpaopao background controls without contacting the native bridge', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    registerLvpaopaoCatalog(ctx)
    const registered = ctx.tools.schemas()
    expect(registered.map(schema => schema.name)).toEqual(['lvpaopao'])
    const schema = registered[0]
    expect(schema?.parameters).toHaveProperty(['properties', 'action', 'enum'], expect.arrayContaining(['download_series', 'series_status', 'series_resume', 'series_cancel']))
    expect(schema?.parameters).toHaveProperty(['properties', 'mode', 'enum'], ['wait', 'background'])
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...registered].map(entry => [entry.name, entry]))
    const index = new ToolSearchIndex([...schemas.values()].map(entry => ({ ...entry, keywords: config.keywords?.[entry.name] ?? [] })),
      { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    for (const query of ['绿泡泡后台下载', '绿泡泡恢复下载', '绿泡泡下载进度', '绿泡泡取消下载']) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain('lvpaopao')
    }
    expect(config.alwaysLoad).not.toContain('lvpaopao')
    expect(capabilityMemberships('lvpaopao', config.capabilities ?? [])).toContain('data-sourcing')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('removes Bot-only tools from product discovery while retaining native questions and task controls', () => {
  expect(config.excludeFromSearch).toEqual(expect.arrayContaining(['ask_user_question', 'show_view', 'visualize']))
  for (const name of ['list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_bot_models',
    'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret',
    'list_secrets', 'group_relay', 'read_own_chat', 'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
    'list_capabilities', 'save_capability', 'delete_capability', 'attach_capability', 'detach_capability']) {
    expect(config.alwaysLoad, name).not.toContain(name)
    expect(config.keywords?.[name], name).toBeUndefined()
    expect(capabilityMemberships(name, config.capabilities ?? []), name).toEqual([])
  }
  for (const name of ['ask_user_question', 'show_view', 'visualize', 'present', 'job_output', 'job_list', 'job_kill', 'subagent',
    'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'web_search', 'web_fetch']) {
    expect(config.alwaysLoad, name).toContain(name)
    expect(capabilityMemberships(name, config.capabilities ?? []), name).not.toEqual([])
  }
  for (const name of ['mcp__muse-account__muse_kb_search', 'mcp__muse-account__muse_kb_wiki_read']) {
    expect(capabilityMemberships(name, config.capabilities ?? [])).toEqual([])
  }
  for (const name of ['source_recover', 'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']) {
    expect(capabilityMemberships(name, config.capabilities ?? [])).toContain('knowledge')
  }
})

it('discovers public Qimao data tools by Chinese requests while keeping them deferred', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Qimao)
    const qimaoSchemas = ctx.tools.schemas()
    expect(qimaoSchemas.map(schema => schema.name).sort()).toEqual(['qimao_detail', 'qimao_rankings', 'qimao_search'])
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...qimaoSchemas].map(schema => [schema.name, schema]))
    const index = new ToolSearchIndex([...schemas.values()].map(schema => ({
      ...schema, keywords: config.keywords?.[schema.name] ?? [],
    })), { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    for (const [query, name] of [['七猫榜单', 'qimao_rankings'], ['七猫搜书', 'qimao_search'], ['七猫详情', 'qimao_detail']] as const) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain(name)
      expect(config.alwaysLoad).not.toContain(name)
      expect(capabilityMemberships(name, config.capabilities ?? [])).toContain('data-sourcing')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
