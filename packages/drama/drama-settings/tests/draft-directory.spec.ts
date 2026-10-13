import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import Tools from '../../../core/tools/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DramaSettingsSchema, apply } from '../src/index.ts'
import { draftDirectory } from '../src/draft-directory.ts'

const accessFailure = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: async (...args: Parameters<typeof actual.access>) => {
    if (args[0] === accessFailure.path) throw Object.assign(new Error('draft root access denied'), { code: 'EACCES' })
    await actual.access(...args)
  } }
})

afterEach(() => { accessFailure.path = '' })

async function bench() {
  return configurationFixture({ rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, drama: { Config: DramaSettingsSchema, apply } } })
}

it('reports an unconfigured draft root without inventing a machine path', async () => {
  const { ctx } = await bench()
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
})

it('validates, saves and rereads only the draft root while preserving other settings and drafts', async () => {
  const { ctx, home } = await bench()
  const root = join(home, 'editor drafts')
  mkdirSync(root)
  writeFileSync(join(root, 'existing.json'), 'keep')
  await ctx.settings.update('drama-settings', { bgmDir: 'keep-bgm' })
  expect(await draftDirectory(ctx.settings, root)).toEqual({ status: 'ready', path: root })
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'ready', path: root })
  expect(readFileSync(join(root, 'existing.json'), 'utf8')).toBe('keep')
  expect(ctx.settings.describe().find(row => row.ns === 'drama-settings')?.value).toMatchObject({ bgmDir: 'keep-bgm' })
})

it('normalizes a Chinese draft root and restores it after Settings restart without changing existing drafts', async () => {
  const { ctx, home, start } = await bench()
  const root = join(home, '剪映 草稿')
  mkdirSync(root)
  const existing = join(root, '已有草稿.json')
  writeFileSync(existing, 'keep-existing-draft')
  const supplied = `  ${root}${sep}..${sep}剪映 草稿${sep}.  `
  expect(await draftDirectory(ctx.settings, supplied)).toEqual({ status: 'ready', path: root })
  await ctx.fiber.dispose()
  const restored = await start()
  expect(await draftDirectory(restored.settings)).toEqual({ status: 'ready', path: root })
  expect(readFileSync(existing, 'utf8')).toBe('keep-existing-draft')
})

it('refuses relative, missing and file paths without saving them', async () => {
  const { ctx, home } = await bench()
  const file = join(home, 'file')
  writeFileSync(file, '')
  for (const path of ['', '   ', 'relative', join(home, 'missing'), file]) {
    await expect(draftDirectory(ctx.settings, path)).rejects.toThrow()
    expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
  }
})

it.runIf(process.platform === 'win32')('refuses drive-relative Windows roots without saving them', async () => {
  const { ctx } = await bench()
  for (const path of ['C:剪映草稿', 'D:草稿']) {
    await expect(draftDirectory(ctx.settings, path)).rejects.toThrow('existing absolute directory')
    expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
  }
})

it('preserves the saved root and profile when access to another root is denied', async () => {
  const { ctx, home, profile } = await bench()
  const saved = join(home, 'saved drafts')
  const denied = join(home, '拒绝的草稿目录')
  mkdirSync(saved)
  mkdirSync(denied)
  const existing = join(denied, 'existing.json')
  writeFileSync(existing, 'keep')
  await draftDirectory(ctx.settings, saved)
  const before = readFileSync(profile.patchPath, 'utf8')
  accessFailure.path = denied
  await expect(draftDirectory(ctx.settings, denied)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'ready', path: saved })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(existing, 'utf8')).toBe('keep')
})

it('exposes the draft-root tool through the Loader and removes it on unload', async () => {
  const { ctx } = await bench()
  const tool = ctx.tools.get('drama_draft_dir')
  expect(tool).toBeDefined()
  expect({ name: tool?.name, description: tool?.description, parameters: tool?.parameters }).toMatchSnapshot()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'drama-settings')
  await entry?.fiber?.dispose()
  expect(ctx.tools.get('drama_draft_dir')).toBeUndefined()
})

it('rejects a stale saved directory instead of returning a usable root', async () => {
  const { ctx, home } = await bench()
  await ctx.settings.update('drama-settings', { jianyingDraftDir: join(home, 'missing') })
  await expect(draftDirectory(ctx.settings)).rejects.toThrow()
})

it('reports a write that did not persist instead of returning a ready root', async () => {
  const { ctx, home } = await bench()
  vi.spyOn(ctx.settings, 'update').mockResolvedValue(undefined)
  await expect(draftDirectory(ctx.settings, home)).rejects.toThrow('was not saved')
})

it('saves the supplied root through the loaded tool and renders its actual readback', async () => {
  const { ctx, home } = await bench()
  const result = await ctx.tools.execute({ name: 'drama_draft_dir', callId: ToolCallId('save-draft-root'),
    arguments: { path: home }, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ status: 'ready', path: home }) }])
})

it('reports an unavailable owning Settings namespace after its plugin unloads', async () => {
  const { ctx } = await bench()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'drama-settings')
  await entry?.fiber?.dispose()
  await expect(draftDirectory(ctx.settings)).rejects.toThrow('Drama settings are unavailable')
})
