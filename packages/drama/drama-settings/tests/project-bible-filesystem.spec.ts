/** Project writes report file access failures, preserve existing outputs, and release their writer lock. */
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Tools from '../../../core/tools/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DramaSettingsSchema, apply } from '../src/index.ts'
import { previewProjectBible, readProjectBible, updateProjectBible } from '../src/project-bible.ts'

const failures = vi.hoisted(() => ({ lstat: '', readFile: '', open: '', rename: '', unlinkTemporary: false, movingRoot: '', rootMoves: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error('project file access denied'), { code: 'EACCES' })
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      if (path === failures.lstat) throw denied()
      const value = await actual.lstat(...args)
      if (path === failures.movingRoot) {
        failures.movingRoot = ''
        await actual.rename(path, path + '.retained')
        failures.rootMoves++
        await actual.writeFile(path, 'moved directory')
      }
      return value
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === failures.readFile) throw denied()
      return await actual.readFile(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === failures.open) throw denied()
      return await actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === failures.rename) throw denied()
      await actual.rename(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (failures.unlinkTemporary && String(args[0]).endsWith('.tmp')) throw denied()
      await actual.unlink(...args)
    },
  }
})

afterEach(() => {
  failures.lstat = ''; failures.readFile = ''; failures.open = ''; failures.rename = ''
  failures.unlinkTemporary = false; failures.movingRoot = ''; failures.rootMoves = 0
})

async function fixture() {
  return await configurationFixture({ rows: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, drama: { Config: DramaSettingsSchema, apply } } })
}

it.each(['lstat', 'readFile'] as const)('retains authoritative bytes when %s access is refused', async (operation) => {
  const { ctx, home } = await fixture()
  const file = join(home, 'project_config.json')
  await writeFile(file, '{}')
  failures[operation] = file
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('project file access denied')
  failures[operation] = ''
  expect(await readFile(file, 'utf8')).toBe('{}')
})

it('refuses a directory in place of the authoritative config without deleting it', async () => {
  const { ctx, home } = await fixture()
  const directory = join(home, 'project_config.json')
  await mkdir(directory)
  await writeFile(join(directory, 'retained.txt'), 'keep')
  await expect(readProjectBible(ctx.settings, home)).rejects.toThrow('regular file')
  expect(await readFile(join(directory, 'retained.txt'), 'utf8')).toBe('keep')
})

it('rejects a project directory replaced between ancestor inspection and the final directory check', async () => {
  const { ctx, home, profile } = await fixture()
  const project = await realpath(await mkdtemp(join(home, 'moving-project-')))
  failures.movingRoot = project
  try {
    await expect(readProjectBible(ctx.settings, project)).rejects.toThrow('Project path must be a directory')
    expect(failures.rootMoves).toBe(1)
    expect(await readFile(project, 'utf8')).toBe('moved directory')
  } finally {
    if (failures.rootMoves > 0) {
      await rm(project, { force: true }); await rename(project + '.retained', project)
    }
  }
  expect((await readFile(join(profile.dir, 'cordis.yml'), 'utf8')).length).toBeGreaterThan(0)
})

it('reports inability to acquire the writer lock without creating project data', async () => {
  const { ctx, home } = await fixture()
  const changes = { title: 'Project' }, preview = await previewProjectBible(ctx.settings, home, changes, 'create')
  failures.open = join(home, '.project-bible.lock')
  await expect(updateProjectBible(ctx.settings, home, changes, 'create', preview.expected_revision, preview.preview_fingerprint))
    .rejects.toThrow('project file access denied')
  await expect(readFile(join(home, 'project_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports the committed JSON revision when the derived Markdown cannot be replaced', async () => {
  const { ctx, home } = await fixture()
  const changes = { title: 'Project' }, preview = await previewProjectBible(ctx.settings, home, changes, 'create')
  const bible = join(home, 'project-bible.md')
  await writeFile(bible, 'retained Markdown')
  failures.rename = bible
  await expect(updateProjectBible(ctx.settings, home, changes, 'create', preview.expected_revision, preview.preview_fingerprint))
    .rejects.toThrow('JSON committed at revision')
  expect(await readFile(bible, 'utf8')).toBe('retained Markdown')
  expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8'))).toMatchObject({ project_bible: { title: 'Project' } })
  await expect(readFile(join(home, '.project-bible.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('surfaces a temporary cleanup access failure after an atomic JSON commit and releases the writer lock', async () => {
  const { ctx, home } = await fixture()
  const changes = { title: 'Project' }, preview = await previewProjectBible(ctx.settings, home, changes, 'create')
  failures.unlinkTemporary = true
  await expect(updateProjectBible(ctx.settings, home, changes, 'create', preview.expected_revision, preview.preview_fingerprint))
    .rejects.toThrow('project file access denied')
  expect(JSON.parse(await readFile(join(home, 'project_config.json'), 'utf8'))).toMatchObject({ project_bible: { title: 'Project' } })
  await expect(readFile(join(home, '.project-bible.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})
