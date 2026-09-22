/** User bans identify exact bytes and never stand in for source review. */
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, expect, it, vi } from 'vitest'
import * as Render from '../src/index.ts'
import { cleanup, runContext, tempProject, writePlaceholder } from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await cleanup(root)
})

async function fixture() {
  const project = await tempProject()
  roots.push(project)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Render)
  const tool = ctx.tools.get('drama_video')
  expect(tool).toBeDefined()
  if (tool === undefined) throw new Error('missing drama_video')
  const video = join(project, 'source.mp4')
  await writePlaceholder(video, 'video version one')
  const call = async (args: Record<string, unknown>) => await tool.execute({ project, ...args }, runContext())
  return { project, video, call, manifest: join(project, 'video-bans.json') }
}

it('requires at least one nonblank label and an existing video for ban', async () => {
  const f = await fixture()
  for (const labels of [undefined, [], [' '], ['ok', 1]]) {
    await expect(f.call({ method: 'ban', video: f.video, ...(labels === undefined ? {} : { labels }) })).rejects.toThrow('labels')
  }
  await expect(f.call({ method: 'ban', video: 'missing.mp4', labels: ['字幕错误'] })).rejects.toThrow()
  await expect(f.call({ method: 'ban', sha256: 'a'.repeat(64), labels: ['字幕错误'] })).rejects.toThrow('video')
})

it('persists labels and reason without evidence, shares bans across copies, and leaves new bytes usable', async () => {
  const f = await fixture()
  const copy = join(f.project, 'copy.mp4')
  await copyFile(f.video, copy)
  const banned = await f.call({ method: 'ban', video: f.video, labels: ['人物对调', '字幕错误'], reason: '用户指定' })
  expect(banned).toMatchObject({ banned: true, labels: ['人物对调', '字幕错误'], reason: '用户指定', review_status: 'not_assessed' })
  expect(await f.call({ method: 'inspect', video: copy })).toMatchObject({ banned: true, reason: '用户指定' })
  const stored = JSON.parse(await readFile(f.manifest, 'utf8')) as { videos: [{ sha256: string }] }
  expect(stored).toMatchObject({ version: 1, videos: [{ banned: true, labels: ['人物对调', '字幕错误'], reason: '用户指定' }] })
  await writeFile(f.video, 'new generation')
  expect(await f.call({ method: 'inspect', video: f.video })).toMatchObject({ banned: false, review_status: 'not_assessed' })
  expect(await f.call({ method: 'list' })).toMatchObject({ videos: stored.videos })
  await rm(copy)
  expect(await f.call({ method: 'unban', sha256: stored.videos[0].sha256 })).toMatchObject({
    banned: false, labels: ['人物对调', '字幕错误'], reason: '用户指定', review_status: 'not_assessed',
  })
  expect(await f.call({ method: 'inspect', sha256: stored.videos[0].sha256 })).toMatchObject({ banned: false })
})

it('rejects malformed manifests without replacing them', async () => {
  const f = await fixture()
  for (const text of ['broken', '{}', '{"version":2,"videos":[]}', '{"version":1,"videos":[{}]}']) {
    await writeFile(f.manifest, text)
    await expect(f.call({ method: 'list' })).rejects.toThrow('禁用清单')
    await expect(f.call({ method: 'ban', video: f.video, labels: ['字幕错误'] })).rejects.toThrow('禁用清单')
    expect(await readFile(f.manifest, 'utf8')).toBe(text)
  }
})

it('keeps the previous decision when atomic replacement fails and releases the writer lock', async () => {
  const f = await fixture()
  await f.call({ method: 'ban', video: f.video, labels: ['人物对调'] })
  const previous = await readFile(f.manifest, 'utf8')
  vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('atomic replacement failed'))
  await expect(f.call({ method: 'unban', video: f.video })).rejects.toThrow('atomic replacement failed')
  expect(await readFile(f.manifest, 'utf8')).toBe(previous)
  expect(await f.call({ method: 'unban', video: f.video })).toMatchObject({ banned: false })
})

it('serializes concurrent changes without losing either version', async () => {
  const f = await fixture()
  const other = join(f.project, 'other.mp4')
  await writeFile(other, 'other bytes')
  await Promise.all([
    f.call({ method: 'ban', video: f.video, labels: ['人物对调'] }),
    f.call({ method: 'ban', video: other, labels: ['字幕错误'] }),
  ])
  const stored = JSON.parse(await readFile(f.manifest, 'utf8')) as { videos: unknown[] }
  expect(stored.videos).toHaveLength(2)
})
