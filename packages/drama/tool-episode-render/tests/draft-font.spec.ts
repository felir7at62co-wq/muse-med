import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyDraftSubtitleFont } from '../src/draft-font.ts'
import { draftFontFixture } from './draft-font-fixture.ts'

const roots: string[] = []
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(family = 'Zhuque Fangsong (technical preview)') {
  const root = await mkdtemp(join(tmpdir(), 'draft-font-')); roots.push(root)
  return await draftFontFixture(root, undefined, family)
}

it.each(['Zhuque Fangsong (technical preview)', 'Noto Sans CJK SC', '朱雀仿宋'])(
  'verifies retained %s bytes and every real subtitle span without OS font installation', async (family) => {
    const f = await fixture(family)
    const files = await verifyDraftSubtitleFont(f.input)
    expect(files.map(file => file.path)).toContain(f.fontPath)
    expect(files.map(file => file.path)).toContain(f.contentPath)
    expect(files.map(file => file.path)).toContain(f.reviewPath)
  })

it('uses exact path case on Unix for actual saved font references', async () => {
  const f = await fixture(); vi.stubGlobal('process', { ...process, platform: 'linux' })
  await expect(verifyDraftSubtitleFont(f.input)).resolves.toHaveLength(7)
  f.subtitle.styles[0]!.font.path += 'wrong'; f.content.materials.texts[0]!.content = JSON.stringify(f.subtitle)
  await f.saveContent()
  await expect(verifyDraftSubtitleFont(f.input)).rejects.toThrow('系统字体')
})

it.each(['missing proof', 'unmanaged family', 'requested', 'resolved', 'font path', 'licence path', 'review path'])(
  'rejects %s even if the review says delivery_ready', async (kind) => {
    const f = await fixture()
    if (kind === 'missing proof') await expect(verifyDraftSubtitleFont({ ...f.input, source: {} })).rejects.toThrow('系统字体')
    else if (kind === 'unmanaged family') await expect(verifyDraftSubtitleFont({ ...f.input, expectedFamily: 'Arial' })).rejects.toThrow('系统字体')
    else {
      const key = { requested: 'requested', resolved: 'resolved', 'font path': 'path', 'licence path': 'license_path', 'review path': 'review_path' }[kind]!
      Object.assign(f.source.subtitle_font, { [key]: 'wrong' })
      await expect(verifyDraftSubtitleFont(f.input)).rejects.toThrow('系统字体')
    }
  })

it.each(['manifest missing font', 'manifest duplicate font', 'manifest hash', 'manifest bytes', 'retained not recorded',
  'bundled modified', 'retained modified', 'review unbound', 'review changed', 'review lies', 'native unbound'])(
  'rejects %s with exact bytes and source receipt binding', async (kind) => {
    const f = await fixture()
    if (kind === 'manifest missing font') f.manifest.files.shift()
    if (kind === 'manifest duplicate font') f.manifest.files.push(f.manifest.files[0]!)
    if (kind === 'manifest hash') f.manifest.files[0]!.sha256 = 'f'.repeat(64)
    if (kind === 'manifest bytes') f.manifest.files[0]!.bytes++
    if (kind.startsWith('manifest')) await f.json(f.manifestPath, f.manifest)
    if (kind === 'retained not recorded') f.source.materials.shift()
    if (kind === 'bundled modified') await writeFile(join(f.input.fontsDir, 'ZhuqueFangsong-Regular.ttf'), 'different')
    if (kind === 'retained modified') await writeFile(f.fontPath, 'different')
    if (kind === 'review unbound') f.source.files[0]!.sha256 = 'f'.repeat(64)
    if (kind === 'review changed') await f.json(f.reviewPath, {})
    if (kind === 'review lies') {
      await f.json(f.reviewPath, { subtitle_font: { ...f.font, resolved: 'Arial' } })
      f.source.files[0]!.sha256 = f.source.subtitle_font.review_sha256 = sha(await readFile(f.reviewPath))
    }
    if (kind === 'native unbound') f.source.files.pop()
    await expect(verifyDraftSubtitleFont(f.input)).rejects.toThrow('系统字体')
  })

it.each(['missing material', 'duplicate material', 'wrong span', 'second span wrong', 'missing span', 'missing subtitle', 'extra subtitle'])(
  'rejects %s instead of accepting only a top-level font name', async (kind) => {
    const f = await fixture()
    if (kind === 'missing material') f.content.materials.texts.shift()
    if (kind === 'duplicate material') f.content.materials.texts.push(f.content.materials.texts[0]!)
    if (kind === 'wrong span') f.subtitle.styles[0]!.font.path += 'wrong'
    if (kind === 'second span wrong') f.subtitle.styles.push({ font: { id: '', path: 'Arial' } })
    if (kind === 'missing span') f.subtitle.styles = []
    if (kind.includes('span')) f.content.materials.texts[0]!.content = JSON.stringify(f.subtitle)
    if (kind === 'missing subtitle') f.content.tracks.splice(1, 1)
    if (kind === 'extra subtitle') f.content.tracks[1]!.segments.push({ material_id: 'dialogue' })
    await f.saveContent()
    await expect(verifyDraftSubtitleFont(f.input)).rejects.toThrow()
  })

it('does not exempt dialogue whose literal text is the watermark wording', async () => {
  const f = await fixture()
  f.content.materials.texts[0]!.content = JSON.stringify({ text: '内容由AI生成', styles: [{ font: { id: 'default', path: '' } }] })
  await f.saveContent()
  await expect(verifyDraftSubtitleFont(f.input)).rejects.toThrow()
})

it('checks a hash-bound original snapshot after the user changes the live editable draft', async () => {
  const f = await fixture(), snapshot = join(f.input.draft, 'muse-original-draft-content.json')
  await copyFile(f.contentPath, snapshot)
  await writeFile(f.contentPath, 'editor-owned later save')
  const result = await verifyDraftSubtitleFont({ ...f.input, contentPath: snapshot })
  expect(result.map(file => file.path)).toContain(snapshot)
  expect(result.map(file => file.path)).not.toContain(f.contentPath)
  await writeFile(snapshot, 'replacement snapshot')
  await expect(verifyDraftSubtitleFont({ ...f.input, contentPath: snapshot })).rejects.toThrow('系统字体')
})
