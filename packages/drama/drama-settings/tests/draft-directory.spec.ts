import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Tools from '../../../core/tools/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DramaSettingsSchema, apply } from '../src/index.ts'
import { draftDirectory } from '../src/draft-directory.ts'

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

it('refuses relative, missing and file paths without saving them', async () => {
  const { ctx, home } = await bench()
  const file = join(home, 'file')
  writeFileSync(file, '')
  for (const path of ['relative', join(home, 'missing'), file]) {
    await expect(draftDirectory(ctx.settings, path)).rejects.toThrow()
    expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
  }
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
