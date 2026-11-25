import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import JingliuConnection from '../src/index.ts'
import { readSelection, storeSelection } from '../src/project-selection.ts'
import { options } from '../src/browser.ts'

it('restores the confirmed project only for its own conversation and studio identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-project-'))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
  await ctx.plugin(class Commands extends Service { constructor(scope: Context) { super(scope, 'commands') } }).await()
  await ctx.plugin(JingliuConnection, {}).await()
  const film = { id: 'film-1', title: '雨夜' }
  await storeSelection('router', 'me', film)
  expect(await readSelection('router')).toEqual({ ...film, owner: 'me' })
  expect(await ctx.jingliuConnection.selected('router', 'me')).toEqual(film)
  expect(await ctx.jingliuConnection.selected('router', 'other')).toBeNull()
  expect(await ctx.jingliuConnection.selected('new-folder', 'me')).toBeNull()
})

it('rejects an invalid stored selection and propagates filesystem failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-project-'))
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

  const film = { id: 'film-1', title: '雨夜' }
  await storeSelection('router', 'me', film)
  const directory = join(home, 'jingliu', 'sessions')
  const [name] = await readdir(directory)
  if (name === undefined) throw new Error('Stored selection file is missing')
  const file = join(directory, name)
  const selection = { ...film, version: 1, session: 'router', owner: 'me' }
  for (const stored of [
    null,
    { ...selection, version: 2 },
    { ...selection, session: 'other' },
    { ...selection, owner: 42 },
    { ...selection, owner: '' },
    { ...selection, id: 42 },
    { ...selection, id: '../film-1' },
    { ...selection, title: null },
  ]) {
    await writeFile(file, JSON.stringify(stored))
    await expect(readSelection('router')).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  }

  await unlink(file)
  await mkdir(file)
  await expect(readSelection('router')).rejects.toMatchObject({ code: 'EISDIR' })
})

it('keeps project defaults distinct from category selections and shows the supported resolutions', () => {
  const image = { by_kind: { character: 'ink' }, project_model: 'gpt-image-2', models: [{ id: 'ink', label: 'Ink' }] }
  const video = { resolution: '720p', tiers: ['480p','720p','1080p'], supported: ['720p','1080p'] }
  expect(options('film', { ...image, project_model: null }, video).projectModel).toBe('')
  expect(options('film', image, video)).toMatchObject({ character: 'ink', location: '', prop: '', projectModel: 'gpt-image-2', resolutions: ['720p','1080p'] })
})
