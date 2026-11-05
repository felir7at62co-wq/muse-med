/** Product classification and Chinese recall against schemas registered by real tool plugins. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { beforeAll, expect, it } from 'vitest'
import { collectToolCatalog, type ToolCatalog } from '../../../scripts/gen-tool-catalog.ts'
import { Config } from '@deepseek-ai/dsh-tool-discovery'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import { capabilityMemberships } from '../../../packages/core/tool-discovery/src/capabilities.ts'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'
import * as Qimao from '../../../third_party/plugins/muse-qimao-data/src/index.js'
import { loadSourceResearchPlugin } from './fixtures/source-research-plugin.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as Douyin from '../../../third_party/plugins/muse-douyin-download/src/index.js'
import { registerLvpaopaoCatalog } from './fixtures/lvpaopao-catalog.mjs'

const patchPath = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))
const row = loadOverlayPatches('desktop-discovery-catalog', patchPath)
  .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
if (!row) throw new Error('Missing Desktop tool-discovery row')
const raw: unknown = row.config
if (!raw || typeof raw !== 'object' || !('alwaysLoad' in raw)
  || !Array.isArray(raw.alwaysLoad) || !raw.alwaysLoad.every((value: unknown): value is string => typeof value === 'string')) {
  throw new Error('Missing resident tool names')
}
const config = Config({ ...raw, alwaysLoad: raw.alwaysLoad })
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

it.each(['short-drama', 'standard', 'bot-coordinator'])('classifies every harvested nonresident tool declared by the %s composition', async (preset) => {
  const source = await readFile(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const packages = new Set(packagesFromRows(yaml.load(source, { schema: entryListSchema })))
  const defaultsPath = fileURLToPath(new URL('../config/defaults.cordis.patch.yml', import.meta.url))
  for (const patch of [...loadOverlayPatches('desktop-discovery-defaults', defaultsPath),
    ...loadOverlayPatches('desktop-discovery-catalog', patchPath)]) {
    for (const name of packagesFromRows(patch.insert)) packages.add(name)
  }
  const schemas = catalog.filter(entry => packages.has(entry.pkg)).flatMap(entry => entry.schemas)
  expect(schemas.length).toBeGreaterThan(40)
  const resident = new Set([...config.alwaysLoad, 'tool_search', 'tool_context'])
  const deferred = schemas.filter(schema => !resident.has(schema.name))
  expect(deferred.length).toBeGreaterThan(15)
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
  ['我要修改分镜卡', 'jubian_storyboard'],
  ['查角色素材', 'jubian_asset'],
  ['查视频任务查询', 'jubian_video'],
  ['找一下背景音乐', 'drama_bgm'],
])('finds %s from actual registered descriptions and configured aliases', (query, expected) => {
  const schemas = new Map(catalog.flatMap(entry => entry.schemas).map(schema => [schema.name, schema]))
  const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
    { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
  expect(index.search(query, config.maxResults ?? 8).map(result => result.name)).toContain(expected)
})

it('keeps native delivery, project and memory tools deferred while giving each a capability', () => {
  for (const name of ['drama_draft_dir', 'drama_project', 'jianying_draft', 'screenplay_export_docx',
    'load_workspace_dependencies', 'manuscript_revision', 'source_recover']) {
    expect(config.alwaysLoad).not.toContain(name)
    expect(capabilityMemberships(name, config.capabilities ?? []).length).toBeGreaterThan(0)
    expect(config.keywords?.[name]?.length).toBeGreaterThan(0)
  }
  expect(config.alwaysLoad).toContain('ask_user_question')
  expect(config.alwaysLoad).toContain('present')
})

it('recalls the registered Douyin task controls without making them resident', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    Douyin.apply(ctx, { pythonExecutable: null, ffprobeExecutable: null, ffmpegExecutable: null, settingsHome: null })
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...ctx.tools.schemas()].map(schema => [schema.name, schema]))
    const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] ?? [] })),
      { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    for (const [query, expected] of [['抖音后台下载', 'douyin_download'], ['恢复抖音下载', 'douyin_download_task']] as const) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain(expected)
      expect(config.alwaysLoad).not.toContain(expected)
      expect(capabilityMemberships(expected, config.capabilities ?? [])).toContain('data-sourcing')
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
  for (const name of ['list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_bot_models',
    'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'show_view', 'request_secret',
    'list_secrets', 'group_relay', 'read_own_chat', 'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
    'list_capabilities', 'save_capability', 'delete_capability', 'attach_capability', 'detach_capability']) {
    expect(config.alwaysLoad, name).not.toContain(name)
    expect(config.keywords?.[name], name).toBeUndefined()
    expect(capabilityMemberships(name, config.capabilities ?? []), name).toEqual([])
  }
  for (const name of ['ask_user_question', 'present', 'job_output', 'job_list', 'job_kill', 'subagent',
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

it('discovers source snapshot, report and work relation tools by Chinese requests while keeping them deferred', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(await loadSourceResearchPlugin(ctx))
    const researchSchemas = ctx.tools.schemas()
    expect(researchSchemas.map(schema => schema.name).sort()).toEqual(['source_report', 'source_snapshot', 'work_mapping'])
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...researchSchemas].map(schema => [schema.name, schema]))
    const index = new ToolSearchIndex([...schemas.values()].map(schema => ({
      ...schema, keywords: config.keywords?.[schema.name] ?? [],
    })), { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    for (const [query, name] of [['选材快照', 'source_snapshot'], ['快照对比', 'source_snapshot'], ['选材日报', 'source_report'], ['同名作品', 'work_mapping'], ['改编关系', 'work_mapping']] as const) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain(name)
      expect(config.alwaysLoad).not.toContain(name)
      expect(capabilityMemberships(name, config.capabilities ?? [])).toContain('data-sourcing')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
