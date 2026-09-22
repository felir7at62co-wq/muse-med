import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareBgmPublication } from '../scripts/bgm-publication.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bgm-publish-'))
  roots.push(root)
  const audio = join(root, '情绪曲目.mp3')
  const bytes = Buffer.from('owned audio fixture')
  await writeFile(audio, bytes)
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const index = join(root, 'index.json')
  const track = { path: audio, sha256, bytes: bytes.length, modified_ms: 1, valence: 5, arousal: 6, moods: ['dramatic'] }
  await writeFile(index, JSON.stringify([track]))
  return { root, audio, index, track }
}

it('prepares content-addressed public tracks without machine paths', async () => {
  const f = await fixture()
  const plan = await prepareBgmPublication(f.index, f.root, 'https://muse.tos-cn-beijing.volces.com')
  expect(plan.manifest).toEqual({ version: 1, tracks: [{
    id: f.track.sha256, name: '情绪曲目.mp3', sha256: f.track.sha256, bytes: f.track.bytes,
    url: `https://muse.tos-cn-beijing.volces.com/bgm/tracks/${f.track.sha256.slice(7)}.mp3`,
    valence: 5, arousal: 6, moods: ['dramatic'],
  }] })
  expect(JSON.stringify(plan.manifest)).not.toContain(f.root)
  expect(plan.artifacts[0]?.source).toBe(f.audio)
  expect(plan.artifacts[0]?.key).toBe(`bgm/tracks/${f.track.sha256.slice(7)}.mp3`)
  expect(await readFile(f.audio, 'utf8')).toBe('owned audio fixture')
})

it('rejects changed audio before planning any upload', async () => {
  const f = await fixture()
  await writeFile(f.audio, 'different bytes')
  await expect(prepareBgmPublication(f.index, f.root, 'https://music.example')).rejects.toThrow(/size|hash/)
})

it('rejects index paths outside the declared music library', async () => {
  const f = await fixture()
  const other = await fixture()
  await writeFile(f.index, JSON.stringify([other.track]))
  await expect(prepareBgmPublication(f.index, f.root, 'https://music.example')).rejects.toThrow(/outside/)
})

it.each([NaN, 0, 10, '5'])('rejects invalid emotion values %s', async (value) => {
  const f = await fixture()
  await writeFile(f.index, JSON.stringify([{ ...f.track, valence: value }]))
  await expect(prepareBgmPublication(f.index, f.root, 'https://music.example')).rejects.toThrow(/valence/)
})

it('rejects duplicate track identity and an empty index', async () => {
  const f = await fixture()
  await writeFile(f.index, JSON.stringify([f.track, f.track]))
  await expect(prepareBgmPublication(f.index, f.root, 'https://music.example')).rejects.toThrow(/duplicate/)
  await writeFile(f.index, '[]')
  await expect(prepareBgmPublication(f.index, f.root, 'https://music.example')).rejects.toThrow(/empty/)
})

it.each(['http://music.example', 'https://user:pass@music.example', 'https://music.example/subdir', 'https://music.example/?token=x'])('rejects a non-origin public URL %s', async (origin) => {
  const f = await fixture()
  await expect(prepareBgmPublication(f.index, f.root, origin)).rejects.toThrow(/origin/)
})
