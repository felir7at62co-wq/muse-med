import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { commitDraft, fill, installDraft } from '../src/delivery.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

afterEach(() => {
  vi.mocked(rename).mockReset()
  vi.restoreAllMocks()
})

const name = '首集'
const prefix = `pack/drafts/${name}/`
const manifestPath = 'pack/manifest.json'
const contentPath = `${prefix}draft_content.json`
const metadataPath = `${prefix}draft_meta_info.json`
const url = '/fw/media/exports/sample.zip'
const clip = '/fwp/media/rendered/shot.mp4'
const exportResult = { url, shots: 1, materials: 1, materials_bytes: 3 }
const manifest = {
  drafts: [{ name }], materials: [{ name: 'shot.mp4', url: `/jingliu${clip}`, size: 3 }],
  mat_token: '__SFMAT__', draft_token: '__SFDRAFT__', root_token: '__SFROOT__',
}
const content = { tracks: [{ type: 'video', segments: [{ id: 'shot' }] }, { segments: null }],
  materials: { videos: [{ path: '__SFMAT__/shot.mp4' }] } }
const json = (value: object | null) => strToU8(JSON.stringify(value))
const entries = (): Record<string, Uint8Array> => ({
  [manifestPath]: json(manifest), [contentPath]: json(content), [metadataPath]: json({ draft_fold_path: '__SFDRAFT__' }),
})

async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'jingliu-archive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

function studio(files = entries(), body: string | null = 'mp4') {
  const bytes = zipSync(files)
  const media = vi.fn<NonNullable<JingliuSession['media']>>(async (path, _signal, consume) => {
    expect([url, clip]).toContain(path)
    await consume(new Response(path === url ? new Uint8Array(bytes) : body))
  })
  const session = { identity: 'alice', request: vi.fn<JingliuSession['request']>(), media }
  return { session, media }
}

it('installs the optional cover, ignores unrelated entries and replays an existing draft without replacing edits', async () => {
  const root = await rootDirectory()
  const { session, media } = studio({ ...entries(), [`${prefix}draft_cover.jpg`]: strToU8('jpeg'),
    'pack/notes/': new Uint8Array(), 'pack/notes/extra.txt': strToU8('ignore') })
  const signal = new AbortController().signal
  const expected = { shots: 1, materials: 1, bytes: 3, tracks: [{ type: 'video', segments: 1 }, { type: null, segments: 0 }] }
  const receipt = await installDraft(session, exportResult, root, 'session:call', signal)
  expect(receipt).toMatchObject(expected)
  const path = receipt.path
  if (typeof path !== 'string') throw new Error('Draft has no path')
  expect(await readFile(join(path, 'draft_cover.jpg'), 'utf8')).toBe('jpeg')
  expect(await readFile(join(path, 'media', 'shot.mp4'), 'utf8')).toBe('mp4')
  expect(await readdir(path)).not.toContain('notes')
  await writeFile(join(path, 'draft_content.json'), 'local edit')
  await expect(installDraft(session, exportResult, root, 'session:call', signal)).resolves.toEqual(receipt)
  expect(await readFile(join(path, 'draft_content.json'), 'utf8')).toBe('local edit')
  expect(media.mock.calls.map(([address]) => address)).toEqual([url, clip, url])
})

it('refuses a missing archive download or a summary that does not describe a draft', async () => {
  const root = await rootDirectory()
  const { session, media } = studio()
  const signal = new AbortController().signal
  for (const result of [{ ...exportResult, shots: 0 }, { ...exportResult, url: '/studio/sample.zip' },
    { ...exportResult, url: `${url}?file=ignored.zip` }]) {
    await expect(installDraft(session, result, root, 'session:call', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  }
  expect(media).not.toHaveBeenCalled()
  media.mockResolvedValueOnce(undefined)
  await expect(installDraft(session, exportResult, root, 'session:call', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(await readdir(root)).toEqual([])
})

const invalidArchives: { name: string; adjust: (files: Map<string, Uint8Array>) => void }[] = [
  { name: 'a reserved filename', adjust: (files) => { files.set('pack/CON.txt', strToU8('unused')) } },
  { name: 'too many file entries', adjust: (files) => {
    for (let index = 0; index < 8_193; index++) files.set(`pack/notes/extra-${index}.txt`, new Uint8Array())
  } },
  { name: 'no manifest', adjust: (files) => { files.delete(manifestPath) } },
  { name: 'two manifests', adjust: (files) => { files.set('second/manifest.json', json(manifest)) } },
  { name: 'an unsupported placeholder', adjust: (files) => {
    files.set(manifestPath, json({ ...manifest, mat_token: 'unsupported' }))
  } },
  { name: 'no draft metadata', adjust: (files) => { files.delete(metadataPath) } },
  { name: 'non-object draft metadata', adjust: (files) => { files.set(metadataPath, json(null)) } },
  { name: 'a timeline without a video segment', adjust: (files) => {
    files.set(contentPath, json({ tracks: [{ type: 'audio', segments: [{}] }] }))
  } },
  { name: 'a material with no declared bytes', adjust: (files) => {
    files.set(manifestPath, json({ ...manifest, materials: [{ ...manifest.materials[0], size: 0 }] }))
  } },
]

it.each(invalidArchives)('rejects an archive with $name without publishing a draft', async ({ adjust }) => {
  const root = await rootDirectory()
  const files = new Map(Object.entries(entries()))
  adjust(files)
  const { session, media } = studio(Object.fromEntries(files))
  await expect(installDraft(session, exportResult, root, 'session:call', new AbortController().signal))
    .rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(media.mock.calls.map(([address]) => address)).toEqual([url])
  expect(await readdir(root)).toEqual([])
})

it.each([
  { name: 'no body', body: null },
  { name: 'too many bytes', body: 'larger' },
  { name: 'too few bytes', body: 'ab' },
])('removes partially written files when the media stream contains $name', async ({ body }) => {
  const root = await rootDirectory()
  const { session, media } = studio(entries(), body)
  await expect(installDraft(session, exportResult, root, 'session:call', new AbortController().signal))
    .rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(media.mock.calls.map(([address]) => address)).toEqual([url, clip])
  expect(await readdir(root)).toEqual([])
})

it('rejects a draft when the total verified media bytes differ from the export summary', async () => {
  const root = await rootDirectory()
  const { session } = studio()
  await expect(installDraft(session, { ...exportResult, materials_bytes: 4 }, root, 'session:call', new AbortController().signal))
    .rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(await readdir(root)).toEqual([])
})

it('preserves a local draft whose receipt no longer identifies the same export', async () => {
  const root = await rootDirectory()
  const { session, media } = studio()
  const signal = new AbortController().signal
  const receipt = await installDraft(session, exportResult, root, 'session:call', signal)
  if (typeof receipt.path !== 'string') throw new Error('Draft has no path')
  const path = join(receipt.path, '.muse-jingliu.json')
  await writeFile(path, JSON.stringify({ ...receipt, fingerprint: 'other-export' }))
  await expect(installDraft(session, exportResult, root, 'session:call', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ fingerprint: 'other-export' })
  expect(media.mock.calls.map(([address]) => address)).toEqual([url, clip, url])
})

it('retains unresolved draft placeholders when only some local paths are supplied', () => {
  expect(fill({ paths: ['__SFMAT__/shot.mp4', '__SFROOT__'], number: 1 }, { __SFMAT__: 'draft/media' }))
    .toEqual({ paths: ['draft/media/shot.mp4', '__SFROOT__'], number: 1 })
})

it('publishes the complete staged draft after a transient Windows rename error', async () => {
  const root = await rootDirectory()
  const destination = join(root, 'draft')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Draft temporarily busy'), { code: 'EPERM' }))
  await expect(commitDraft(root, destination, async (stage) => {
    await writeFile(join(stage, 'draft_content.json'), 'complete')
    return { path: destination }
  }, new AbortController().signal)).resolves.toEqual({ path: destination })
  expect(vi.mocked(rename).mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(await readFile(join(destination, 'draft_content.json'), 'utf8')).toBe('complete')
  expect(await readdir(root)).toEqual(['draft'])
})

it('keeps the cancellation reason and removes the stage if cancelled after a Windows rename error', async () => {
  const root = await rootDirectory()
  const destination = join(root, 'draft')
  const controller = new AbortController()
  const cancelled = new Error('Publish cancelled')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(rename).mockImplementationOnce(async () => {
    controller.abort(cancelled)
    throw Object.assign(new Error('Draft temporarily busy'), { code: 'EPERM' })
  })
  await expect(commitDraft(root, destination, async () => ({ path: destination }), controller.signal)).rejects.toBe(cancelled)
  expect(rename).toHaveBeenCalledTimes(1)
  expect(await readdir(root)).toEqual([])
})

it('returns a permanent rename failure unchanged and removes the stage', async () => {
  const root = await rootDirectory()
  const destination = join(root, 'draft')
  const renameError = Object.assign(new Error('Draft storage cannot make the rename'), { code: 'EXDEV' })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(rename).mockRejectedValueOnce(renameError)
  await expect(commitDraft(root, destination, async () => ({ path: destination }), new AbortController().signal)).rejects.toBe(renameError)
  expect(rename).toHaveBeenCalledTimes(1)
  expect(await readdir(root)).toEqual([])
})

it('preserves a destination draft whose files already exist', async () => {
  const root = await rootDirectory()
  const destination = join(root, 'draft')
  await mkdir(destination)
  const prior = join(destination, 'original.txt')
  await writeFile(prior, 'existing edit')
  await expect(commitDraft(root, destination, async () => ({ path: destination }), new AbortController().signal)).rejects.toThrow()
  expect(await readFile(prior, 'utf8')).toBe('existing edit')
  expect(await readdir(root)).toEqual(['draft'])
})
