import { mkdtemp, rm } from 'node:fs/promises'
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

it('keeps project defaults distinct from category selections and shows the supported resolutions', () => {
  const image = { by_kind: { character: 'ink' }, project_model: 'gpt-image-2', models: [{ id: 'ink', label: 'Ink' }] }
  const video = { resolution: '720p', tiers: ['480p','720p','1080p'], supported: ['720p','1080p'] }
  expect(options('film', { ...image, project_model: null }, video).projectModel).toBe('')
  expect(options('film', image, video)).toMatchObject({ character: 'ink', location: '', prop: '', projectModel: 'gpt-image-2', resolutions: ['720p','1080p'] })
})
