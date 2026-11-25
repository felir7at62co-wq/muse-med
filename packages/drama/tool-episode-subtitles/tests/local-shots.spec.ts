import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { HashCache } from '../src/hash-cache.ts'
import { localShotManifestPath, localSource, resolveLocalEpisode } from '../src/shots.ts'
import { project, toolkit } from './fixture.ts'

async function fixture(count = 1) {
  const value = await project(count)
  onTestFinished(() => rm(value.root, { recursive: true, force: true }))
  return { ...value, plan: join(value.root, 'episode_packages', '01', 'package.json'),
    review: (pack: number) => join(value.root, 'reviews', `ep01-p${String(pack).padStart(2, '0')}.json`),
    read: async () => resolveLocalEpisode(value.root, 1, await HashCache.load(value.root), toolkit) }
}

it('distinguishes a missing or empty package plan from malformed content and filesystem errors', async () => {
  const f = await fixture()
  await rm(f.plan)
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'package_missing' })
  await writeFile(f.plan, JSON.stringify({ shots: [] }))
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'package_missing' })
  await writeFile(f.plan, '{}')
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'package_missing' })
  await writeFile(f.plan, '[]')
  await expect(f.read()).rejects.toThrow('不是 JSON 对象')
  await rm(f.plan)
  await mkdir(f.plan)
  await expect(f.read()).rejects.toMatchObject({ code: 'EISDIR' })
})

it('blocks a changed plan, missing media and changed selected bytes with the relevant package numbers', async () => {
  const f = await fixture()
  const path = f.review(1)
  const reviewed = JSON.parse(await readFile(path, 'utf8')) as { video_path: string; audio_path: string; package_sha256: string }
  await writeFile(path, JSON.stringify({ ...reviewed, package_sha256: '0'.repeat(64) }))
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'package_changed', shots: [1] })
  await writeFile(path, JSON.stringify({ ...reviewed, video_path: '' }))
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'selection_missing', shots: [1] })
  await writeFile(path, JSON.stringify(reviewed))
  const hash = await HashCache.load(f.root)
  const unreadable = Object.assign(new Error('Project media cannot be read'), { code: 'EACCES' })
  vi.spyOn(hash, 'sha256').mockRejectedValueOnce(unreadable)
  await expect(resolveLocalEpisode(f.root, 1, hash, toolkit)).rejects.toBe(unreadable)
  await writeFile(join(f.root, reviewed.video_path), 'VIDEO:3:changed')
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'selection_changed', shots: [1] })
  await rm(join(f.root, reviewed.audio_path))
  await expect(f.read()).resolves.toMatchObject({ kind: 'blocked', reason: 'selection_changed', shots: [1] })
  await expect(readFile(localShotManifestPath(f.root, '01'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('collects only assigned spoken lines and names from the plan, and keeps media and manifest paths usable', async () => {
  const f = await fixture(2)
  const bytes = '\uFEFF' + JSON.stringify({ video_tasks: [{ shots: [1, 2, 3, 4] }, null], shots: [
    { shot: 1, voice_type: 'dialogue', text: '青禾回来了。', speaker: ' 青禾 ', characters: ['阿兰', 3, ' '] },
    { shot: 2, voice_type: 'vo', text: '天色渐暗。' },
    { shot: 3, voice_type: 'music', text: '纯音乐' },
    { shot: 4, voice_type: 'dialogue', text: ' ' },
    { shot: 5, voice_type: 'dialogue', text: '另一个分包' },
    null,
  ] })
  const packageSha = createHash('sha256').update(bytes).digest('hex')
  await writeFile(f.plan, bytes)
  const draft = join(f.root, 'project_config.json')
  await writeFile(draft, JSON.stringify({ project_bible: { characters: [null, { name: '阿兰', aliases: ['兰姐', 3] }, { name: '小宁' }] } }))
  for (const pack of [1, 2]) {
    const video = join(f.root, 'media', '01', `p${String(pack)}-v${String(pack)}.mp4`)
    const digest = createHash('sha256').update(await readFile(video)).digest('hex')
    await writeFile(f.review(pack), JSON.stringify({ status: 'approved', package_sha256: packageSha, video_path: video, audio_path: ' ',
      ...(pack === 1 ? { video_sha256: digest } : {}) }))
  }
  const source = localSource(f.root, 'production/', await HashCache.load(f.root), toolkit)
  expect(source.filesPattern).toBe('production/editing/NN.srt')
  const [episode, missing] = await source.resolve([1, 2])
  expect(episode).toMatchObject({ kind: 'ok', names: ['兰姐', '小宁', '阿兰', '青禾'],
    shots: [{ shot: 1, lines: ['青禾回来了。', '天色渐暗。'] }, { shot: 2, lines: [] }] })
  expect(missing).toMatchObject({ kind: 'blocked', reason: 'package_missing', episode: 2 })
  expect(await f.read()).toEqual(episode)
  await writeFile(draft, JSON.stringify({ project_bible: { characters: {} } }))
  await expect(f.read()).resolves.toMatchObject({ kind: 'ok', names: ['阿兰', '青禾'] })
  const failedMedia = { ...toolkit, channel: { run: async () => ({ code: 1, stdout: '', stderr: 'Media probe failed' }) } }
  await expect(resolveLocalEpisode(f.root, 1, await HashCache.load(f.root), failedMedia))
    .resolves.toMatchObject({ kind: 'blocked', reason: 'media_unreadable', shots: [1, 2] })
})
