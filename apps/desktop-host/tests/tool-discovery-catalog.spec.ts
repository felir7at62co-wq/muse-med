/** Product classification and Chinese recall against schemas registered by real tool plugins. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { beforeAll, expect, it } from 'vitest'
import { collectToolCatalog, type ToolCatalog } from '../../../scripts/gen-tool-catalog.ts'
import { Config } from '@deepseek-ai/dsh-tool-discovery'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import * as BotTools from '../../desktop/tests/fixtures/resident-bot-questions.mjs'
import { capabilityMemberships } from '../../../packages/core/tool-discovery/src/capabilities.ts'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'

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

it.each(['short-drama', 'bot-coordinator'])('classifies every harvested nonresident tool declared by the %s product composition', async (preset) => {
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
  const index = new ToolSearchIndex([...schemas.values()].map(schema => ({ ...schema, keywords: config.keywords?.[schema.name] })),
    { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
  expect(index.search(query, config.maxResults ?? 8).map(result => result.name)).toContain(expected)
})

it('keeps native delivery, project and memory tools deferred while giving each a capability', () => {
  for (const name of ['drama_draft_dir', 'drama_project', 'jianying_draft', 'screenplay_export_docx',
    'load_workspace_dependencies', 'manuscript_revision', 'hindsight_memory']) {
    expect(config.alwaysLoad).not.toContain(name)
    expect(capabilityMemberships(name, config.capabilities ?? []).length).toBeGreaterThan(0)
    expect(config.keywords?.[name]?.length).toBeGreaterThan(0)
  }
  expect(config.alwaysLoad).toContain('ask_user_question')
  expect(config.alwaysLoad).toContain('ask_user')
})

it('classifies the actual Bot team tool registrations without changing their permissions', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(Agents)
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    await ctx.plugin(BotTools)
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('create_group')
    expect(names).toContain('attach_capability')
    const resident = new Set([...config.alwaysLoad, 'tool_search', 'tool_context'])
    expect(names.filter(name => !resident.has(name) && !capabilityMemberships(name, config.capabilities ?? []).length)).toEqual([])
    expect(config.alwaysLoad).not.toContain('create_group')
  } finally { await ctx.fiber.dispose() }
})
