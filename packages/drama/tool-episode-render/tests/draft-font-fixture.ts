import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

export async function draftFontFixture(root: string, draft = join(root, 'draft'), family = 'Zhuque Fangsong (technical preview)') {
  const fontsDir = join(root, 'runtime/fonts')
  const fontName = family === 'Noto Sans CJK SC' ? 'NotoSansCJKsc-Regular.otf' : 'ZhuqueFangsong-Regular.ttf'
  const licenseName = family === 'Noto Sans CJK SC' ? 'LICENSE-NotoSansCJK.txt' : 'LICENSE-ZhuqueFangsong.txt'
  const fontPath = join(draft, 'Resources/fonts', fontName), licensePath = join(draft, 'Resources/fonts', licenseName)
  const json = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value))
  }
  for (const path of [fontPath, licensePath, join(fontsDir, fontName), join(dirname(fontsDir), 'licenses', licenseName)]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, path.endsWith('.txt') ? 'font licence' : 'font bytes')
  }
  const font = { requested: family, resolved: family, binding: 'local_file', path: fontPath, sha256: sha('font bytes'),
    license_path: licensePath, license_sha256: sha('font licence'), status: 'localFileBound', binding_verified: true,
    delivery_ready: true, resource_id: null }
  const reviewPath = join(draft, 'muse-review.json')
  await json(reviewPath, { subtitle_font: font })
  const contentPath = join(draft, 'draft_content.json')
  const subtitle = { styles: [{ font: { id: '', path: fontPath } }] }
  const content = { materials: { texts: [{ id: 'dialogue', content: JSON.stringify(subtitle) },
    { id: 'watermark', content: '{}' }] }, tracks: [
    { type: 'video', segments: [{ material_id: 'picture' }] },
    { type: 'text', segments: [{ material_id: 'dialogue' }] },
    { type: 'text', name: 'AI内容标识', segments: [{ material_id: 'watermark' }] },
  ] }
  await json(contentPath, content)
  const manifest = { version: 1, files: [
    { path: `fonts/${fontName}`, bytes: 10, sha256: font.sha256 },
    { path: `licenses/${licenseName}`, bytes: 12, sha256: font.license_sha256 },
  ] }
  const manifestPath = join(dirname(fontsDir), 'media-runtime.json'); await json(manifestPath, manifest)
  const source = { subtitle_font: { ...font, review_path: reviewPath, review_sha256: sha(await readFile(reviewPath)) },
    materials: [{ path: fontPath, sha256: font.sha256 }, { path: licensePath, sha256: font.license_sha256 }],
    files: [{ path: 'muse-review.json', sha256: sha(await readFile(reviewPath)) },
      { path: 'draft_content.json', sha256: sha(await readFile(contentPath)) }] }
  const saveContent = async () => {
    await json(contentPath, content); source.files[1]!.sha256 = sha(await readFile(contentPath))
  }
  return { input: { draft, fontsDir, expectedFamily: family, subtitleCount: 1, source, read: readFile },
    source, font, content, subtitle, manifest, manifestPath, fontPath, contentPath, reviewPath, json, saveContent }
}
