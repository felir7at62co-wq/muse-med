import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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
  const changes = { title: 'Loader project' }
  const preview = await execute({ action: 'preview', changes, reason: 'creation' })
  expect((await execute({ action: 'update', changes, reason: 'creation',
    expected_revision: preview.expected_revision, preview_fingerprint: preview.preview_fingerprint })).status).toBe('ready')
  expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8'))).toMatchObject({
    project_bible: { title: 'Loader project', revision: 1 },
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
  const changes = { characters: [{ character_id: 'lead-1', name: '苏晚', voice_profile: { description: '清亮温柔',
    reference_audio: 'https://assets.example/voice.wav', reference_audio_asset_id: 142686,
    reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 15 } }] }
  const bind = await execute({ action: 'preview', changes, reason: '认可声线' })
  await execute({ action: 'update', changes, reason: '认可声线', expected_revision: bind.expected_revision,
    preview_fingerprint: bind.preview_fingerprint })
  const clear = { characters: [{ character_id: 'lead-1', voice_profile: { reference_audio: null } }] }
  const preview = await execute({ action: 'preview', changes: clear, reason: '解除音频引用' })
  const updated = await execute({ action: 'update', changes: clear, reason: '解除音频引用',
    expected_revision: preview.expected_revision, preview_fingerprint: preview.preview_fingerprint })
  expect(updated.config).toMatchObject({ project_bible: { characters: [{ voice_profile: { description: '清亮温柔' } }] } })
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
