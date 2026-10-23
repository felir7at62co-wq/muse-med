import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Tools from '../../../core/tools/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DramaSettingsSchema, apply } from '../src/index.ts'
import { readProjectBible, previewProjectBible, updateProjectBible } from '../src/project-bible.ts'

async function bench() {
  return configurationFixture({ rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, drama: { Config: DramaSettingsSchema, apply } } })
}

it('exposes project bible reads, previews and guarded updates through the real Loader', async () => {
  const { ctx, home } = await bench()
  const tool = ctx.tools.get('drama_project')
  expect(tool).toBeDefined()
  const execute = async (args: object) => {
    const outcome = await ctx.tools.execute({ name: 'drama_project', callId: ToolCallId('bible'),
      arguments: { project_dir: home, ...args }, signal: new AbortController().signal })
    expect(outcome.isError).toBe(false)
    const rendered = outcome.content[0]
    if (rendered?.type !== 'text') throw new Error('Expected project bible JSON')
    return JSON.parse(rendered.text) as { expected_revision: string; preview_fingerprint: string; status: string }
  }
  expect((await execute({ action: 'read' })).status).toBe('unconfigured')
  const draft_style = { watermark: { font_size_ui: 7 }, subtitle: { font_family: '山海经', font_size_ui: 11,
    border_width_ui: 20, transform_y: -0.465625 } }
  const changes = { title: 'Loader project', delivery: { draft_style } }
  const preview = await execute({ action: 'preview', changes, reason: 'creation' })
  expect((await execute({ action: 'update', changes, reason: 'creation',
    expected_revision: preview.expected_revision, preview_fingerprint: preview.preview_fingerprint })).status).toBe('ready')
  expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8'))).toMatchObject({
    project_bible: { title: 'Loader project', revision: 1, delivery: { draft_style } },
  })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'drama-settings')
  await entry?.fiber?.dispose()
  expect(ctx.tools.get('drama_project')).toBeUndefined()
})

it('returns Settings defaults for an unconfigured project without creating files', async () => {
  const { ctx, home } = await bench()
  const result = await readProjectBible(ctx.settings, home)
  expect(result).toMatchObject({ status: 'unconfigured', expected_revision: 'missing', defaults: {
    initial_budget_cents: 400000, delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
  } })
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('replaces the entire draft-style section while unrelated updates preserve it', async () => {
  const { ctx, home } = await bench()
  const style = { watermark: { font_size_ui: 7 }, subtitle: { font_family: '山海经', font_size_ui: 11,
    border_width_ui: 20, transform_y: -0.465625 } }
  for (const [changes, expected] of [
    [{ delivery: { draft_style: style } }, style],
    [{ title: 'same typography' }, style],
    [{ delivery: { draft_style: {} } }, {}],
    [{ delivery: { draft_style: { watermark: {}, subtitle: { border_width_ui: 0, transform_y: 1 } } } },
      { watermark: {}, subtitle: { border_width_ui: 0, transform_y: 1 } }],
  ] as const) {
    const preview = await previewProjectBible(ctx.settings, home, changes, 'approved editor typography')
    await updateProjectBible(ctx.settings, home, changes, 'approved editor typography',
      preview.expected_revision, preview.preview_fingerprint)
    expect((await readProjectBible(ctx.settings, home)).config)
      .toMatchObject({ project_bible: { delivery: { draft_style: expected } } })
    expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8')))
      .toMatchObject({ project_bible: { delivery: { draft_style: expected } } })
  }
})

it.each([null, [], 'style', { watermark: null }, { watermark: [] }, { subtitle: null }, { subtitle: [] },
  { watermark: { font_size_ui: 0 } }, { watermark: { font_size_ui: 101 } },
  { subtitle: { font_size_ui: true } }, { subtitle: { font_size_ui: NaN } },
  { subtitle: { font_size_ui: Infinity } }, { subtitle: { font_size_ui: -1 } },
  { subtitle: { border_width_ui: -1 } }, { subtitle: { border_width_ui: 101 } },
  { subtitle: { border_width_ui: null } }, { subtitle: { transform_y: -1.1 } },
  { subtitle: { transform_y: 1.1 } }, { subtitle: { transform_y: '0' } },
  { subtitle: { font_family: null } }, { subtitle: { font_family: '' } },
  { subtitle: { font_family: ' ' } }, { subtitle: { font_family: 'a'.repeat(129) } },
  { subtitle: { font_family: 'line\nbreak' } }, { subtitle: { font_family: 'control\u0085' } },
].map(draft_style => ({ draft_style })))('refuses invalid draft typography without writing project data: %j', async ({ draft_style }) => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { delivery: { draft_style } }, 'invalid editor typography'))
    .rejects.toThrow('draft_style')
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('validates persisted draft typography instead of hiding invalid values during read', async () => {
  const { ctx, home } = await bench()
  const changes = { delivery: { draft_style: { watermark: { font_size_ui: 100 },
    subtitle: { font_family: ' 字体 ', font_size_ui: 0.01, border_width_ui: 100, transform_y: -1 } } } }
  const preview = await previewProjectBible(ctx.settings, home, changes, 'finite UI endpoints')
  await updateProjectBible(ctx.settings, home, changes, 'finite UI endpoints',
    preview.expected_revision, preview.preview_fingerprint)
  const document = JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8')) as {
    project_bible: { delivery: { draft_style: object } }
  }
  document.project_bible.delivery.draft_style = { subtitle: { font_size_ui: 0 } }
  await writeFile(join(home, 'project_config.json'), JSON.stringify(document))
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('draft_style')
})

it('previews and persists one authoritative bible with a readable derived document', async () => {
  const { ctx, home } = await bench()
  const changes = { title: '山海', style: '写实古装', aspect_ratio: '9:16', jubian_script_id: 2708,
    video: { model_id: 'doubao-seedance-2-5-260628', platform_id: 'FANG_ZHOU', resolution: '720p', generation_type: 3 },
    episode_plan: { mode: 'flexible', outline: '重逢后解决误会', target_seconds: 90 } }
  const preview = await previewProjectBible(ctx.settings, home, changes, '创建项目')
  expect(preview).toMatchObject({ status: 'preview', expected_revision: 'missing', proposed: {
    jubian_script_id: 2708, project_bible: { schema_version: 1, revision: 1, title: '山海', initial_budget_cents: 400000 },
  } })
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const updated = await updateProjectBible(ctx.settings, home, changes, '创建项目', 'missing', preview.preview_fingerprint)
  expect(updated.status).toBe('ready')
  const stored = JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8')) as {
    project_bible: { video: { resolution: string }; delivery: { width: number }; episode_plan: { mode: string } }
  }
  expect(stored.project_bible.video.resolution).toBe('720p')
  expect(stored.project_bible.delivery.width).toBe(1440)
  expect(stored.project_bible.episode_plan.mode).toBe('flexible')
  const markdown = await readFile(join(home, 'project-bible.md'), 'utf8')
  expect(markdown).toContain('山海')
  expect(markdown).toContain('720p')
  expect(markdown).toContain('1440 × 2560')
  expect(markdown).toContain('重逢后解决误会')
})

it.each(['仿真人', '3D', '二维水墨动画，低饱和色彩'])('persists the confirmed visual style verbatim: %s', async (style) => {
  const { ctx, home } = await bench()
  const changes = { style, aspect_ratio: '9:16',
    video: { model_id: 'doubao-seedance-2-5-260628', platform_id: 'FANG_ZHOU', resolution: '720p' },
    delivery: { width: 1440, height: 2560 } }
  const preview = await previewProjectBible(ctx.settings, home, changes, '确认项目风格')
  await updateProjectBible(ctx.settings, home, changes, '确认项目风格', preview.expected_revision, preview.preview_fingerprint)
  const result = await readProjectBible(ctx.settings, home)
  expect(result.config).toMatchObject({ project_bible: { style, aspect_ratio: '9:16',
    video: { model_id: 'doubao-seedance-2-5-260628', resolution: '720p' }, delivery: { width: 1440, height: 2560 } } })
  expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8'))).toMatchObject({ project_bible: { style } })
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toContain(`风格：${style}`)
})

it.each(['animation_3d', 'photorealistic'])('persists explicit delivery medium independently of style and ratio: %s', async (visual_medium) => {
  const { ctx, home } = await bench()
  const style = '写实 3D，电影级 PBR 材质'
  const changes = { style, visual_medium, aspect_ratio: '16:9' }
  const preview = await previewProjectBible(ctx.settings, home, changes, '确认交付类型')
  expect(preview.changed_fields).toContain('visual_medium')
  expect(preview.affected_stages).toEqual(['asset_prompts', 'shots_and_matches', 'video_tasks', 'draft', 'export'])
  await updateProjectBible(ctx.settings, home, changes, '确认交付类型', preview.expected_revision, preview.preview_fingerprint)
  const result = await readProjectBible(ctx.settings, home)
  expect(result.config).toMatchObject({ project_bible: { style, visual_medium, aspect_ratio: '16:9', revision: 1 } })
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toContain(`交付类型：${visual_medium}`)
  const later = { title: '新增标题' }
  const next = await previewProjectBible(ctx.settings, home, later, '只更新标题')
  expect(next.proposed).toMatchObject({ project_bible: { style, visual_medium, revision: 2 } })
  expect(next.changed_fields).toEqual(['title'])
})

it('never infers medium from legacy style or aspect ratio and labels the legacy delivery', async () => {
  const { ctx, home } = await bench()
  const preview = await previewProjectBible(ctx.settings, home, { style: '写实 3D', aspect_ratio: '16:9' }, '保留旧项目')
  expect(preview.proposed.project_bible).not.toHaveProperty('visual_medium')
  expect(preview.markdown).toContain('未确认；沿用旧版片尾与 AI 水印')
})

it.each(['3d', '写实3D', 'unknown', '', null, 1])('rejects an invalid explicit delivery medium: %s', async (visual_medium) => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { visual_medium }, '无效类型')).rejects.toThrow('visual_medium')
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('records medium changes in revision history without replacing completed work', async () => {
  const { ctx, home } = await bench()
  const first = { visual_medium: 'photorealistic', style: '古装风格', completed_tasks: [{ task_id: 'finished-1', kind: 'video' }] }
  const preview = await previewProjectBible(ctx.settings, home, first, '初建')
  await updateProjectBible(ctx.settings, home, first, '初建', preview.expected_revision, preview.preview_fingerprint)
  const change = { visual_medium: 'animation_3d' }
  const next = await previewProjectBible(ctx.settings, home, change, '确认 3D 交付')
  const saved = await updateProjectBible(ctx.settings, home, change, '确认 3D 交付', next.expected_revision, next.preview_fingerprint)
  expect(saved.config).toMatchObject({ project_bible: { visual_medium: 'animation_3d', style: '古装风格', revision: 2,
    completed_tasks: first.completed_tasks, history: [{ revision: 1 }, { revision: 2, changed_fields: ['visual_medium'], affected_stages: ['asset_prompts', 'shots_and_matches', 'video_tasks', 'draft', 'export'] }] } })
})

it('preserves legacy requirements, stable package bindings, completed tasks and prior revisions', async () => {
  const { ctx, home } = await bench()
  await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708,
    delivery: { max_effective_chars_per_shot: 18 }, custom: { keep: true } }))
  const firstChanges = { title: '山海', package_bindings: [{ package_id: 'ep1-pkg1', storyboard_id: 7 }],
    completed_tasks: [{ task_id: 'task-1', kind: 'video', package_id: 'ep1-pkg1' }] }
  const first = await previewProjectBible(ctx.settings, home, firstChanges, '建立圣经')
  await updateProjectBible(ctx.settings, home, firstChanges, '建立圣经', first.expected_revision, first.preview_fingerprint)
  const changes = { style: '新的服装要求' }
  const preview = await previewProjectBible(ctx.settings, home, changes, '修改风格')
  expect(preview.affected_stages).toContain('asset_prompts')
  const result = await updateProjectBible(ctx.settings, home, changes, '修改风格', preview.expected_revision, preview.preview_fingerprint)
  expect(result.config).toMatchObject({ jubian_script_id: 2708, delivery: { max_effective_chars_per_shot: 18 },
    custom: { keep: true }, project_bible: { revision: 2,
      package_bindings: [{ package_id: 'ep1-pkg1', storyboard_id: 7 }],
      completed_tasks: [{ task_id: 'task-1', kind: 'video', package_id: 'ep1-pkg1' }],
      history: [{ revision: 1 }, { revision: 2 }],
    } })
  const conflict = { package_bindings: [{ package_id: 'ep1-pkg1', storyboard_id: 99 }] }
  await expect(previewProjectBible(ctx.settings, home, conflict, '修改绑定')).rejects.toThrow('already bound')
  await expect(previewProjectBible(ctx.settings, home, { jubian_script_id: 99 }, '修改项目')).rejects.toThrow('already bound')
})

it('rejects stale file revisions and altered previews before changing either output', async () => {
  const { ctx, home } = await bench()
  const changes = { title: '山海' }
  const preview = await previewProjectBible(ctx.settings, home, changes, '创建')
  await expect(updateProjectBible(ctx.settings, home, { title: '别的标题' }, '创建', 'missing', preview.preview_fingerprint))
    .rejects.toThrow('Preview changed')
  await writeFile(join(home, 'project_config.json'), '{"jubian_script_id":2708}\n')
  await expect(updateProjectBible(ctx.settings, home, changes, '创建', 'missing', preview.preview_fingerprint))
    .rejects.toThrow('revision changed')
  expect(await readFile(join(home, 'project_config.json'), 'utf8')).toBe('{"jubian_script_id":2708}\n')
  await expect(readFile(join(home, 'project-bible.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('allows only one writer to commit a shared expected revision', async () => {
  const { ctx, home } = await bench()
  const changes = { title: '山海' }
  const preview = await previewProjectBible(ctx.settings, home, changes, '创建')
  const outcomes = await Promise.allSettled([1, 2].map(() => updateProjectBible(ctx.settings, home,
    changes, '创建', preview.expected_revision, preview.preview_fingerprint)))
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const result = await readProjectBible(ctx.settings, home)
  expect(result.config).toMatchObject({ project_bible: { revision: 1, history: [{ revision: 1 }] } })
})

it('rejects invalid persisted data, incomplete video selections and unsafe numeric settings', async () => {
  const { ctx, home } = await bench()
  for (const changes of [{ video: { model_id: 'SD2.5' } }, { budget_cents: -1 },
    { delivery: { width: 0 } }, { episode_plan: { mode: 'fixed', episode_count: 0 } }]) {
    await expect(previewProjectBible(ctx.settings, home, changes, '无效')).rejects.toThrow()
  }
  await writeFile(join(home, 'project_config.json'), '[]')
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('JSON object')
  await writeFile(join(home, 'project_config.json'), '{"project_bible":{"schema_version":2}}')
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('schema_version')
})

it.each(['constructor', 'toString', '__proto__'])('rejects an inherited object key as a project change: %s', async (key) => {
  const { ctx, home } = await bench()
  const changes = Object.fromEntries([[key, { ignored: true }]])
  await expect(previewProjectBible(ctx.settings, home, changes, '无效字段')).rejects.toThrow(`Unsupported project change: ${key}`)
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a project budget override because paid calls use Settings and ledger authorization', async () => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { budget_cents: 1 }, '修改预算')).rejects.toThrow('Unsupported project change: budget_cents')
  await expect(previewProjectBible(ctx.settings, home, { initial_budget_cents: 1 }, '修改初始记录')).rejects.toThrow('Unsupported project change: initial_budget_cents')
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves the initial budget snapshot while reporting the current Settings default', async () => {
  const { ctx, home } = await bench()
  const changes = { title: '山海' }
  const first = await previewProjectBible(ctx.settings, home, changes, '创建')
  await updateProjectBible(ctx.settings, home, changes, '创建', first.expected_revision, first.preview_fingerprint)
  await ctx.settings.update('drama-settings', { seriesBudgetCents: 100000 })
  const edit = { style: '古装' }
  const preview = await previewProjectBible(ctx.settings, home, edit, '修改风格')
  const updated = await updateProjectBible(ctx.settings, home, edit, '修改风格', preview.expected_revision, preview.preview_fingerprint)
  expect(updated).toMatchObject({ current_settings_budget_cents: 100000,
    config: { project_bible: { initial_budget_cents: 400000 } } })
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toContain('预算初始记录：¥4000.00')
})

it('refuses held writer locks and non-directory project paths', async () => {
  const { ctx, home } = await bench()
  const changes = { title: '山海' }
  const preview = await previewProjectBible(ctx.settings, home, changes, '创建')
  await writeFile(join(home, '.project-bible.lock'), 'held')
  await expect(updateProjectBible(ctx.settings, home, changes, '创建', 'missing', preview.preview_fingerprint))
    .rejects.toThrow('Another project bible update')
  const file = join(home, 'file')
  await writeFile(file, '')
  await expect(readProjectBible(ctx.settings, file)).rejects.toThrow('directory')
  await expect(readProjectBible(ctx.settings, 'relative')).rejects.toThrow('absolute')
  const missing = join(home, 'missing')
  await expect(readProjectBible(ctx.settings, missing)).rejects.toThrow()
  await mkdir(missing)
  expect((await readProjectBible(ctx.settings, missing)).status).toBe('unconfigured')
})
it('preserves character identity and approved voice guidance through later package edits', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', aliases: ['阿晚'], asset_id: 12,
    voice_profile: { speaker_id: 'su-wan', description: '青年女性，清亮温柔，普通话', reference_audio: 'audio/su-wan.wav' } }] }
  const first = await previewProjectBible(ctx.settings, home, changes, '固定角色和声音')
  await updateProjectBible(ctx.settings, home, changes, '固定角色和声音', first.expected_revision, first.preview_fingerprint)
  const edit = { characters: [{ character_id: 'lead-1', name: '苏晚', aliases: ['阿晚', '晚晚'] }] }
  const preview = await previewProjectBible(ctx.settings, home, edit, '补充称呼')
  const updated = await updateProjectBible(ctx.settings, home, edit, '补充称呼', preview.expected_revision, preview.preview_fingerprint)
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ character_id: 'lead-1', asset_id: 12,
    aliases: ['阿晚', '晚晚'], voice_profile: { speaker_id: 'su-wan', description: '青年女性，清亮温柔，普通话', reference_audio: 'audio/su-wan.wav' } }] } })
  expect(preview.affected_stages).toContain('shots_and_matches')
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-2', name: '阿晚' }] }, '歧义称呼'))
    .rejects.toThrow('ambiguous')
})

it('persists project-owned role importance without inferring it from catalog metadata', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [
    { character_id: 'lead-1', name: '苏晚', role_class: 'lead' },
    { character_id: 'support-1', name: '同事', role_class: 'support' },
  ] }
  const preview = await previewProjectBible(ctx.settings, home, changes, '确认角色重要性')
  const updated = await updateProjectBible(ctx.settings, home, changes, '确认角色重要性',
    preview.expected_revision, preview.preview_fingerprint)
  expect(updated.config).toMatchObject({ project_bible: { characters: changes.characters } })
  await expect(previewProjectBible(ctx.settings, home, {
    characters: [{ character_id: 'extra-1', name: '路人', role_class: 'catalog_default' }],
  }, '无效角色类型')).rejects.toThrow('characters.role_class')
})

it('stores a measured remote voice asset on the stable character through costume changes', async () => {
  const { ctx, home } = await bench()
  const voice = { description: '青年女性，清亮温柔，普通话',
    reference_audio: 'https://assets.example/su-wan-v1.wav', reference_audio_asset_id: 142686,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2.01 }
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', asset_id: 12, voice_profile: voice }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '认可第一版声线')
  await updateProjectBible(ctx.settings, home, changes, '认可第一版声线', initial.expected_revision, initial.preview_fingerprint)
  const edit = { characters: [{ character_id: 'lead-1', asset_id: 18 }] }
  const preview = await previewProjectBible(ctx.settings, home, edit, '更换服装资产')
  const updated = await updateProjectBible(ctx.settings, home, edit, '更换服装资产', preview.expected_revision, preview.preview_fingerprint)
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ character_id: 'lead-1', asset_id: 18,
    voice_profile: voice }] } })
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toContain('reference_audio_asset_id')
})

it('keeps child and adult voices of one character independent through costume and period edits', async () => {
  const { ctx, home } = await bench()
  const child = { voice_period_id: 'child', label: '童年', description: '儿童声线',
    reference_audio: 'https://assets.example/child.wav', reference_audio_asset_id: 10,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 }
  const adult = { voice_period_id: 'adult', description: '成年声线' }
  const legacy = { description: '旧默认声线', reference_audio: 'audio/legacy.wav' }
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', asset_id: 12,
    voice_profile: legacy, voice_profiles: [child, adult] }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '记录童年与成年声线')
  await updateProjectBible(ctx.settings, home, changes, '记录童年与成年声线', initial.expected_revision, initial.preview_fingerprint)
  const edit = { characters: [{ character_id: 'lead-1', asset_id: 18, voice_profiles: [{ voice_period_id: 'adult',
    label: '成年', reference_audio: 'https://assets.example/adult.wav', reference_audio_asset_id: 20,
    reference_audio_sha256: 'b'.repeat(64), reference_audio_duration_seconds: 2 }] }] }
  const preview = await previewProjectBible(ctx.settings, home, edit, '换服装并认可成年声线')
  const updated = await updateProjectBible(ctx.settings, home, edit, '换服装并认可成年声线', preview.expected_revision, preview.preview_fingerprint)
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ character_id: 'lead-1', asset_id: 18,
    voice_profile: legacy, voice_profiles: [child, { ...adult, label: '成年', reference_audio_asset_id: 20 }] }] } })
  const clear = { characters: [{ character_id: 'lead-1', voice_profiles: [{ voice_period_id: 'child', reference_audio: null }] }] }
  const removal = await previewProjectBible(ctx.settings, home, clear, '解除童年参考')
  await updateProjectBible(ctx.settings, home, clear, '解除童年参考', removal.expected_revision, removal.preview_fingerprint)
  const stored = await readProjectBible(ctx.settings, home)
  expect(stored.config).toMatchObject({ project_bible: { characters: [{ voice_profile: legacy, voice_profiles: [
    { voice_period_id: 'child', label: '童年', description: '儿童声线' }, { voice_period_id: 'adult', reference_audio_asset_id: 20 },
  ] }] } })
  const serialized = JSON.stringify(stored.config)
  expect(serialized).not.toContain('https://assets.example/child.wav')
  expect(serialized).not.toContain('reference_audio":null')
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toContain('voice_period_id')
  const empty = await previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1', voice_profiles: [] }] }, '保留已有时期')
  expect(empty.changed_fields).toEqual([])
  expect(empty.proposed).toMatchObject({ project_bible: { characters: [{ voice_profiles: [
    { voice_period_id: 'child' }, { voice_period_id: 'adult', reference_audio_asset_id: 20 },
  ] }] } })
})

it('appends a new voice period without discarding existing periods or the legacy default', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '旧声线' } }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '记录角色')
  await updateProjectBible(ctx.settings, home, changes, '记录角色', initial.expected_revision, initial.preview_fingerprint)
  for (const voice_period_id of ['child', 'adult']) {
    const edit = { characters: [{ character_id: 'lead-1', voice_profiles: [{ voice_period_id, description: `${voice_period_id}声线` }] }] }
    const preview = await previewProjectBible(ctx.settings, home, edit, '增加时期')
    await updateProjectBible(ctx.settings, home, edit, '增加时期', preview.expected_revision, preview.preview_fingerprint)
  }
  expect((await readProjectBible(ctx.settings, home)).config).toMatchObject({ project_bible: { characters: [{
    voice_profile: { description: '旧声线' }, voice_profiles: [
      { voice_period_id: 'child', description: 'child声线' }, { voice_period_id: 'adult', description: 'adult声线' },
    ],
  }] } })
})

it.each([
  [null, 'voice_profiles must be an array'],
  [{}, 'voice_profiles must be an array'],
  [[null], 'voice_profiles must be a JSON object'],
  [[{ description: '儿童声线' }], 'voice_period_id must be nonempty'],
  [[{ voice_period_id: ' ', description: '儿童声线' }], 'voice_period_id must be nonempty'],
  [[{ voice_period_id: 'child', description: '儿童声线' }, { voice_period_id: 'child', description: '另一声线' }], 'unique voice_period_id'],
  [[{ voice_period_id: 'child' }], 'voice_profile.description'],
  [[{ voice_period_id: 'child', description: '儿童声线', label: '' }], 'voice_profiles.label'],
])('refuses invalid voice period input without creating project files: %j', async (voice_profiles, message) => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profiles }] }, '记录时期'))
    .rejects.toThrow(message)
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses duplicate periods in persisted project data and partial bound-period replacements', async () => {
  const { ctx, home } = await bench()
  const child = { voice_period_id: 'child', description: '儿童声线',
    reference_audio: 'https://assets.example/child.wav', reference_audio_asset_id: 10,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 }
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profiles: [child] }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '记录时期')
  const saved = await updateProjectBible(ctx.settings, home, changes, '记录时期', initial.expected_revision, initial.preview_fingerprint)
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1', voice_profiles: [
    { voice_period_id: 'child', reference_audio: 'https://assets.example/changed.wav' },
  ] }] }, '换参考')).rejects.toThrow('reference_audio_asset_id')
  const invalid = { ...saved.config, project_bible: { ...saved.config.project_bible as object,
    characters: [{ character_id: 'lead-1', name: '苏晚', voice_profiles: [child, child] }] } }
  await writeFile(join(home, 'project_config.json'), JSON.stringify(invalid))
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('unique voice_period_id')
})

it('clears a current voice asset explicitly while preserving character and voice guidance', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', asset_id: 12,
    voice_profile: { description: '清亮温柔', speaker_id: 'su-wan', reference_audio: 'https://assets.example/voice.wav',
      reference_audio_asset_id: 142686, reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 } }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '认可声线')
  await updateProjectBible(ctx.settings, home, changes, '认可声线', initial.expected_revision, initial.preview_fingerprint)
  const clear = { characters: [{ character_id: 'lead-1', voice_profile: { reference_audio: null } }] }
  const preview = await previewProjectBible(ctx.settings, home, clear, '删除前解除角色声线引用')
  expect(preview.affected_stages).toContain('video_tasks')
  const updated = await updateProjectBible(ctx.settings, home, clear, '删除前解除角色声线引用',
    preview.expected_revision, preview.preview_fingerprint)
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ character_id: 'lead-1', name: '苏晚', asset_id: 12,
    voice_profile: { description: '清亮温柔', speaker_id: 'su-wan' } }] } })
  const contents = await readFile(join(home, 'project_config.json'), 'utf8')
  for (const key of ['reference_audio', 'reference_audio_asset_id', 'reference_audio_sha256', 'reference_audio_duration_seconds']) {
    expect(contents).not.toContain(`"${key}"`)
  }
})

it('rejects malformed voice asset identifiers, hashes and reference durations before persistence', async () => {
  const { ctx, home } = await bench()
  for (const field of [{ reference_audio_asset_id: 0 }, { reference_audio_asset_id: '142686' },
    { reference_audio_sha256: 'not-a-sha256' }, { reference_audio_duration_seconds: 0 },
    { reference_audio_duration_seconds: 15.01 }]) {
    await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1', name: '苏晚',
      voice_profile: { description: '清亮温柔', ...field } }] }, '绑定声线')).rejects.toThrow('voice_profile.reference_audio')
  }
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires a measured HTTPS reference when binding a remote audio asset', async () => {
  const { ctx, home } = await bench()
  for (const field of [{ reference_audio: 'audio/su-wan.wav' }, { reference_audio: 'https://assets.example/voice.wav' },
    { reference_audio: 'https://assets.example/voice.wav', reference_audio_sha256: 'a'.repeat(64) }]) {
    await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1', name: '苏晚',
      voice_profile: { description: '清亮温柔', reference_audio_asset_id: 142686, ...field } }] }, '绑定声线'))
      .rejects.toThrow('voice_profile.reference_audio')
  }
})

it('refuses to reuse old measurements when a bound voice URL changes', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '清亮温柔',
    reference_audio: 'https://assets.example/v1.wav', reference_audio_asset_id: 142686,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 } }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '认可声线')
  await updateProjectBible(ctx.settings, home, changes, '认可声线', initial.expected_revision, initial.preview_fingerprint)
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'lead-1',
    voice_profile: { reference_audio: 'https://assets.example/v2.wav' } }] }, '换参考'))
    .rejects.toThrow('reference_audio_asset_id')
})

it('accepts a remote voice binding and explicit reference removal through the loaded project tool', async () => {
  const { ctx, home } = await bench()
  const execute = async (args: object) => {
    const outcome = await ctx.tools.execute({ name: 'drama_project', callId: ToolCallId('voice-bible'),
      arguments: { project_dir: home, ...args }, signal: new AbortController().signal })
    expect(outcome.isError).toBe(false)
    const rendered = outcome.content[0]
    if (rendered?.type !== 'text') throw new Error('Expected project bible JSON')
    return JSON.parse(rendered.text) as { expected_revision: string; preview_fingerprint: string; config: object }
  }
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profiles: [
    { voice_period_id: 'child', label: '童年', description: '儿童声线', reference_audio: 'https://assets.example/child.wav',
      reference_audio_asset_id: 10, reference_audio_sha256: 'b'.repeat(64), reference_audio_duration_seconds: 2 },
  ], voice_profile: { description: '清亮温柔',
    reference_audio: 'https://assets.example/voice.wav', reference_audio_asset_id: 142686,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 15 } }] }
  const bind = await execute({ action: 'preview', changes, reason: '认可声线' })
  await execute({ action: 'update', changes, reason: '认可声线', expected_revision: bind.expected_revision,
    preview_fingerprint: bind.preview_fingerprint })
  const clear = { characters: [{ character_id: 'lead-1', voice_profile: { reference_audio: null },
    voice_profiles: [{ voice_period_id: 'child', reference_audio: null }] }] }
  const preview = await execute({ action: 'preview', changes: clear, reason: '解除音频引用' })
  const updated = await execute({ action: 'update', changes: clear, reason: '解除音频引用',
    expected_revision: preview.expected_revision, preview_fingerprint: preview.preview_fingerprint })
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ voice_profile: { description: '清亮温柔' },
    voice_profiles: [{ voice_period_id: 'child', label: '童年', description: '儿童声线' }] }] } })
  expect(JSON.stringify(updated.config)).not.toContain('reference_audio')
})

it('refuses malformed persisted voice metadata on read', async () => {
  const { ctx, home } = await bench()
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '清亮温柔' } }] }
  const initial = await previewProjectBible(ctx.settings, home, changes, '认可声线')
  const saved = await updateProjectBible(ctx.settings, home, changes, '认可声线', initial.expected_revision, initial.preview_fingerprint)
  const invalid = { ...saved.config, project_bible: { ...saved.config.project_bible as object,
    characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '清亮温柔',
      reference_audio_duration_seconds: 16 } }] } }
  await writeFile(join(home, 'project_config.json'), JSON.stringify(invalid))
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('reference_audio_duration_seconds')
})

it.each([
  [{ schema_version: 2 }, 'schema_version'], [{ revision: 0 }, 'revision'],
  [{ initial_budget_cents: -1 }, 'initial_budget_cents'],
  [{ delivery: { width: 1440, height: 2560, fps: 241, min_bitrate_mbps: 4.6 } }, 'fps'],
  [{ delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 0 } }, 'min_bitrate_mbps'],
  [{ video: { model_id: 'model', platform_id: 'platform', resolution: '720p', generation_type: 0 } }, 'generation_type'],
  [{ episode_plan: { mode: 'unknown' } }, 'episode_plan.mode'],
  [{ episode_plan: { mode: 'fixed', episode_count: 0 } }, 'episode_count'],
  [{ episode_plan: { mode: 'fixed', target_seconds: 0 } }, 'target_seconds'],
  [{ package_bindings: [{ package_id: 'a', storyboard_id: 1 }, { package_id: 'a', storyboard_id: 2 }] }, 'unique package'],
  [{ package_bindings: [{ package_id: 'a', storyboard_id: 1, episode_id: 0 }] }, 'episode_id'],
  [{ characters: [{ character_id: 'a', name: 'Alice' }, { character_id: 'a', name: 'Other' }] }, 'unique character'],
  [{ characters: [{ character_id: 'a', name: 'Alice', aliases: {} }] }, 'aliases'],
  [{ characters: [{ character_id: 'a', name: 'Alice' }] }, ''],
  [{ completed_tasks: [{ task_id: 'a', kind: 'video' }, { task_id: 'a', kind: 'video' }] }, 'unique task'],
  [{ history: [{ revision: 1, reason: 'edited', changed_fields: 'title', affected_stages: [] }] }, 'changed_fields'],
  [{ characters: {} }, 'must be an array'],
  [{ characters: [{ character_id: 'a', name: 'Alice', voice_profile: { description: 'Warm', reference_audio: 'voice.wav',
    reference_audio_asset_id: 1, reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 } }] }, 'HTTPS URL'],
  [{ characters: [{ character_id: 'a', name: 'Alice', voice_profile: { description: 'Warm',
    reference_audio: 'https://assets.example/voice.wav', reference_audio_asset_id: 1 } }] }, 'requires measured'],
] as const)('reads durable bible fields without accepting invalid data: %s', async (patch, message) => {
  const { ctx, home } = await bench()
  const preview = await previewProjectBible(ctx.settings, home, { title: 'Project' }, 'create')
  const config = { ...preview.proposed, project_bible: { ...preview.proposed.project_bible as object, ...patch } }
  const content = JSON.stringify(config)
  await writeFile(join(home, 'project_config.json'), content)
  if (message) await expect(readProjectBible(ctx.settings, home)).rejects.toThrow(message)
  else expect((await readProjectBible(ctx.settings, home)).status).toBe('ready')
  expect(await readFile(join(home, 'project_config.json'), 'utf8')).toBe(content)
})

it.each(['http://assets.example/voice.wav', 'https://alice@assets.example/voice.wav', 'https://alice:secret@assets.example/voice.wav'])('refuses an unapproved remote voice URL %s', async (reference_audio) => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'a', name: 'Alice',
    voice_profile: { description: 'Warm', reference_audio, reference_audio_asset_id: 1,
      reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 } }] }, 'approve voice')).rejects.toThrow('HTTPS URL')
})

it('rejects clearing a voice reference and supplying a new asset binding together', async () => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { characters: [{ character_id: 'a', name: 'Alice',
    voice_profile: { description: 'Warm', reference_audio: null, reference_audio_asset_id: 1 } }] }, 'clear reference')).rejects.toThrow('cannot be combined')
})

it('requires a reason and resolves an omitted initial episode mode to flexible', async () => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { title: 'Project' }, ' ')).rejects.toThrow('reason is required')
  const first = await previewProjectBible(ctx.settings, home, { episode_plan: { outline: 'First act' } }, 'outline')
  expect(first.proposed).toMatchObject({ project_bible: { episode_plan: { mode: 'flexible', outline: 'First act' } } })
  await updateProjectBible(ctx.settings, home, { episode_plan: { outline: 'First act' } }, 'outline', first.expected_revision, first.preview_fingerprint)
  const updated = await previewProjectBible(ctx.settings, home, { episode_plan: { outline: 'New act' } }, 'edit outline')
  expect(updated.proposed).toMatchObject({ project_bible: { episode_plan: { mode: 'flexible', outline: 'New act' } } })
})

it('retains unchanged immutable records without appending copies', async () => {
  const { ctx, home } = await bench()
  const changes = { package_bindings: [{ package_id: 'a', storyboard_id: 1 }], completed_tasks: [{ task_id: 'a', kind: 'video' }] }
  const preview = await previewProjectBible(ctx.settings, home, changes, 'bind')
  await updateProjectBible(ctx.settings, home, changes, 'bind', preview.expected_revision, preview.preview_fingerprint)
  const duplicate = await previewProjectBible(ctx.settings, home, changes, 'retain')
  expect(duplicate.proposed).toMatchObject({ project_bible: {
    package_bindings: changes.package_bindings, completed_tasks: changes.completed_tasks,
  } })
  expect(duplicate.changed_fields).toEqual([])
})

it.each([null, 50_000])('reads actual budget authorization %s without changing the project or default', async (limit_cents) => {
  const { ctx, home } = await bench()
  const reader = { read: async (script_id: number) => ({ script_id, limit_cents, unit: 'CNY', source: 'project' as const,
    settled_cents: 1_000, reserved_cents: 500, remaining_cents: limit_cents === null ? null : limit_cents - 1_500,
    revision: 'budget-revision', authorization_path: join(home, 'budget.json'), note: '', accounting_complete: true }) }
  const preview = await previewProjectBible(ctx.settings, home, { jubian_script_id: 2708 }, 'bind', reader)
  expect(preview.budget).toMatchObject({ status: 'ready', limit_cents, settled_cents: 1_000, reserved_cents: 500 })
  if (typeof preview.markdown !== 'string') throw new Error('missing project markdown')
  expect(preview.markdown).toContain(limit_cents === null ? '未授权' : '¥500.00 CNY')
  await writeFile(join(home, 'project_config.json'), '{"jubian_script_id":2708}')
  const legacy = await readProjectBible(ctx.settings, home, reader)
  expect(legacy.budget).toMatchObject({ status: 'ready', limit_cents })
  expect(legacy).not.toHaveProperty('markdown')
  expect(await readFile(join(home, 'project_config.json'), 'utf8')).toBe('{"jubian_script_id":2708}')
})

it('rejects incomplete loaded project-tool mutations before writing', async () => {
  const { ctx, home } = await bench()
  for (const arguments_ of [
    { action: 'preview', project_dir: home },
    { action: 'update', project_dir: home, changes: { title: 'Project' }, reason: 'create' },
  ]) {
    const outcome = await ctx.tools.execute({ name: 'drama_project', callId: ToolCallId('incomplete-bible'),
      arguments: arguments_, signal: new AbortController().signal })
    expect(outcome.isError).toBe(true)
  }
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports absent Settings defaults after the owning row unloads', async () => {
  const { ctx, home } = await bench()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'drama-settings')
  await entry?.fiber?.dispose()
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('Drama settings are unavailable')
})

const bgmFeedback = {
  feedback_id: 'user-feedback-1', track_id: 'catalogue-track-1', source_sha256: 'a'.repeat(64),
  decision: 'reject', context_tags: ['轻喜剧对白', '轻柔配器'], reason: '用户认为此段压过对白',
  recorded_at: '2026-10-22T14:30:00+08:00', episode: 24, user_quote: '这段不要用这个音乐',
}

it('saves explicit BGM feedback through the loaded tool and rereads only the owning project', async () => {
  const { ctx, home } = await bench()
  const project = join(home, 'project'), other = join(home, 'other')
  await mkdir(project)
  await mkdir(other)
  const legacy = { jubian_script_id: 2708, delivery: { max_effective_chars_per_shot: 18 }, custom: { keep: true } }
  await writeFile(join(project, 'project_config.json'), JSON.stringify(legacy))
  const changes = { bgm_feedback: [bgmFeedback], completed_tasks: [{ task_id: 'finished-1', kind: 'video' }],
    characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '已认可声线' } }] }
  const preview = await previewProjectBible(ctx.settings, project, changes, '记录用户配乐反馈')
  expect(preview.affected_stages).toEqual(['draft', 'export', 'asset_prompts', 'shots_and_matches', 'video_tasks'])
  const outcome = await ctx.tools.execute({ name: 'drama_project', callId: ToolCallId('bgm-feedback'),
    arguments: { action: 'update', project_dir: project, changes, reason: '记录用户配乐反馈',
      expected_revision: preview.expected_revision, preview_fingerprint: preview.preview_fingerprint },
    signal: new AbortController().signal })
  expect(outcome.isError).toBe(false)
  const reread = await readProjectBible(ctx.settings, project)
  expect(reread.config).toMatchObject({ ...legacy, project_bible: {
    bgm_feedback: [bgmFeedback], completed_tasks: changes.completed_tasks, characters: changes.characters,
  } })
  expect(JSON.parse(await readFile(join(project, 'project_config.json'), 'utf8'))).toEqual(reread.config)
  expect(await readFile(join(project, 'project-bible.md'), 'utf8')).toContain('配乐用户反馈')
  expect(await readFile(join(project, 'project-bible.md'), 'utf8')).toContain(bgmFeedback.user_quote)
  expect((await readProjectBible(ctx.settings, other)).config).toEqual({})
  await expect(readFile(join(other, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('appends a later explicit change of mind without rewriting feedback or unrelated project data', async () => {
  const { ctx, home } = await bench()
  const first = { title: 'Project', bgm_feedback: [bgmFeedback], package_bindings: [{ package_id: 'ep24-1', storyboard_id: 7 }],
    completed_tasks: [{ task_id: 'finished-1', kind: 'video' }], characters: [{ character_id: 'lead', name: '苏晚' }] }
  const preview = await previewProjectBible(ctx.settings, home, first, '记录拒绝')
  await updateProjectBible(ctx.settings, home, first, '记录拒绝', preview.expected_revision, preview.preview_fingerprint)
  const accepted = { ...bgmFeedback, feedback_id: 'user-feedback-2', decision: 'accept',
    recorded_at: '2026-10-22T07:00:00Z', reason: '用户在试听新对白混音后改为认可', user_quote: '现在这版可以了' }
  const changes = { bgm_feedback: [accepted] }
  const next = await previewProjectBible(ctx.settings, home, changes, '用户明确改口')
  expect(next.affected_stages).toEqual(['draft', 'export'])
  await updateProjectBible(ctx.settings, home, changes, '用户明确改口', next.expected_revision, next.preview_fingerprint)
  expect((await readProjectBible(ctx.settings, home)).config).toMatchObject({ project_bible: {
    title: first.title, bgm_feedback: [bgmFeedback, accepted], package_bindings: first.package_bindings,
    completed_tasks: first.completed_tasks, characters: first.characters,
    history: [{ revision: 1 }, { revision: 2, reason: '用户明确改口', changed_fields: ['bgm_feedback'], affected_stages: ['draft', 'export'] }],
  } })
  const retained = await previewProjectBible(ctx.settings, home, { bgm_feedback: [accepted] }, '重读后重传同一记录')
  expect(retained.changed_fields).toEqual([])
  expect(retained.proposed).toMatchObject({ project_bible: { bgm_feedback: [bgmFeedback, accepted] } })
  for (const omitted of [{}, { bgm_feedback: [] }]) {
    expect((await previewProjectBible(ctx.settings, home, omitted, '保留反馈')).proposed)
      .toMatchObject({ project_bible: { bgm_feedback: [bgmFeedback, accepted] } })
  }
  await expect(previewProjectBible(ctx.settings, home, { bgm_feedback: [{ ...bgmFeedback, decision: 'accept' }] }, '覆盖原记录'))
    .rejects.toThrow('already bound; preserve its original record')
})

it('keeps older configs without BGM feedback valid and preserves them during a later unrelated update', async () => {
  const { ctx, home } = await bench()
  const first = { title: 'Legacy', completed_tasks: [{ task_id: 'finished-1', kind: 'video' }] }
  const preview = await previewProjectBible(ctx.settings, home, first, '旧项目')
  await updateProjectBible(ctx.settings, home, first, '旧项目', preview.expected_revision, preview.preview_fingerprint)
  expect((await readProjectBible(ctx.settings, home)).config.project_bible).not.toHaveProperty('bgm_feedback')
  const edit = await previewProjectBible(ctx.settings, home, { title: 'Legacy updated' }, '改标题')
  expect(edit.proposed.project_bible).not.toHaveProperty('bgm_feedback')
})

it('rejects stale or altered BGM feedback previews without changing either durable output', async () => {
  const { ctx, home } = await bench()
  const changes = { bgm_feedback: [bgmFeedback] }
  const first = await previewProjectBible(ctx.settings, home, changes, '用户反馈')
  await expect(updateProjectBible(ctx.settings, home, { bgm_feedback: [{ ...bgmFeedback, reason: '另一个理由' }] },
    '用户反馈', first.expected_revision, first.preview_fingerprint)).rejects.toThrow('Preview changed')
  await updateProjectBible(ctx.settings, home, changes, '用户反馈', first.expected_revision, first.preview_fingerprint)
  const json = await readFile(join(home, 'project_config.json'), 'utf8')
  const markdown = await readFile(join(home, 'project-bible.md'), 'utf8')
  const next = { bgm_feedback: [{ ...bgmFeedback, feedback_id: 'user-feedback-2', decision: 'accept' }] }
  await expect(updateProjectBible(ctx.settings, home, next, '用户改口', first.expected_revision, first.preview_fingerprint))
    .rejects.toThrow('revision changed')
  expect(await readFile(join(home, 'project_config.json'), 'utf8')).toBe(json)
  expect(await readFile(join(home, 'project-bible.md'), 'utf8')).toBe(markdown)
})

it.each([
  [{ track_id: 'track-only', source_sha256: undefined }],
  [{ track_id: undefined, source_sha256: 'b'.repeat(64) }],
  [{ track_id: undefined, source_sha256: `sha256:${'B'.repeat(64)}` }],
  [{ track_id: undefined, source_sha256: `SHA256:${'a'.repeat(64)}` }],
  [{ context_tags: Array.from({ length: 33 }, (_, index) => `scene-${index}`) }],
])('preserves known track identities and explicit context tags without manufacturing fields: %j', async (patch) => {
  const { ctx, home } = await bench()
  const row: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries({ ...bgmFeedback, ...patch })) if (value !== undefined) row[key] = value
  const preview = await previewProjectBible(ctx.settings, home, { bgm_feedback: [row] }, '用户反馈')
  await updateProjectBible(ctx.settings, home, { bgm_feedback: [row] }, '用户反馈', preview.expected_revision, preview.preview_fingerprint)
  expect((await readProjectBible(ctx.settings, home)).config).toMatchObject({ project_bible: { bgm_feedback: [row] } })
})

it.each<[Record<string, JsonValue>, string]>([
  [{ feedback_id: '' }, 'feedback_id'], [{ feedback_id: ' ' }, 'feedback_id'],
  [{ track_id: '', source_sha256: 'a'.repeat(64) }, 'track_id'],
  [{ source_sha256: 'wrong' }, 'source_sha256'], [{ source_sha256: null }, 'source_sha256'],
  [{ decision: 'maybe' }, 'decision'], [{ decision: null }, 'decision'],
  [{ context_tags: [] }, 'context_tags'], [{ context_tags: [' '] }, 'context_tags'],
  [{ context_tags: [1] }, 'context_tags'], [{ context_tags: '轻喜剧' }, 'context_tags'],
  [{ reason: '' }, 'reason'], [{ recorded_at: '2026-10-22T14:30:00' }, 'recorded_at'],
  [{ recorded_at: '2026-02-30T14:30:00+08:00' }, 'recorded_at'],
  [{ recorded_at: '2026-10-22' }, 'recorded_at'], [{ recorded_at: '2026-10-22T24:30:00Z' }, 'recorded_at'],
  [{ episode: 0 }, 'episode'], [{ episode: 1.5 }, 'episode'], [{ episode: Number.MAX_SAFE_INTEGER + 1 }, 'episode'],
  [{ user_quote: ' ' }, 'user_quote'],
])('refuses invalid explicit BGM feedback on input and durable read: %j', async (patch, message) => {
  const { ctx, home } = await bench()
  const bgm_feedback = [{ ...bgmFeedback, ...patch }]
  await expect(previewProjectBible(ctx.settings, home, { bgm_feedback }, '用户反馈')).rejects.toThrow(message)
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const content = JSON.stringify({ project_bible: { schema_version: 1, revision: 1, initial_budget_cents: 400000,
    delivery: { width: 480, height: 854, fps: 30, min_bitrate_mbps: 4.6 }, bgm_feedback } })
  await writeFile(join(home, 'project_config.json'), content)
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow(message)
  expect(await readFile(join(home, 'project_config.json'), 'utf8')).toBe(content)
})

it.each<{ bgm_feedback: JsonValue }>([
  { bgm_feedback: null }, { bgm_feedback: {} }, { bgm_feedback: [null] },
  { bgm_feedback: [{ feedback_id: 'missing-identity', decision: 'reject', context_tags: ['轻喜剧'],
    reason: '用户明确拒绝', recorded_at: '2026-10-22T07:00:00Z' }] },
  { bgm_feedback: [bgmFeedback, bgmFeedback] },
])('rejects malformed BGM feedback arrays, missing identity and duplicate IDs: %j', async ({ bgm_feedback }) => {
  const { ctx, home } = await bench()
  await expect(previewProjectBible(ctx.settings, home, { bgm_feedback }, '用户反馈')).rejects.toThrow('bgm_feedback')
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
