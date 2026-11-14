/** Verify saved native subtitle spans against the product's retained font bytes. */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const file = z.object({ path: z.string(), sha256: digest })
const proofSchema = z.object({
  requested: z.string(), resolved: z.string(), binding: z.literal('local_file'),
  path: z.string(), sha256: digest, license_path: z.string(), license_sha256: digest,
  status: z.literal('localFileBound'), binding_verified: z.literal(true), delivery_ready: z.literal(true),
  resource_id: z.null(), review_path: z.string(), review_sha256: digest,
})
const sourceSchema = z.object({ subtitle_font: proofSchema, files: z.array(file), materials: z.array(file) })
const contentSchema = z.object({ materials: z.object({ texts: z.array(z.object({ id: z.string(), content: z.string() })) }),
  tracks: z.array(z.object({ type: z.string(), name: z.string().optional(),
    segments: z.array(z.object({ material_id: z.string() })) })) })
const textSchema = z.object({ styles: z.array(z.object({ font: z.object({ id: z.literal(''), path: z.string() }) })).min(1) })
const manifestSchema = z.object({ version: z.literal(1), files: z.array(z.object({
  path: z.string(), bytes: z.number().int().positive(), sha256: digest,
})) })
const families = new Map<string, readonly [string, string]>([
  ['Zhuque Fangsong (technical preview)', ['ZhuqueFangsong-Regular.ttf', 'LICENSE-ZhuqueFangsong.txt']],
  ['朱雀仿宋', ['ZhuqueFangsong-Regular.ttf', 'LICENSE-ZhuqueFangsong.txt']],
  ['Noto Sans CJK SC', ['NotoSansCJKsc-Regular.otf', 'LICENSE-NotoSansCJK.txt']],
])

function fail(): never { throw Error('剪映草稿缺少与成片一致的本地字体文件、许可证或逐字幕字体引用证据。请重新生成草稿；不能交付系统字体替代品。') }
const equalPath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

/** Verify an explicit product font without consulting the machine's installed fonts.
 * @param input - Current saved draft, managed resources and bounded regular-file reader.
 * @returns Exact files that must remain unchanged through final staging.
 */
export async function verifyDraftSubtitleFont(input: {
  readonly draft: string
  readonly fontsDir: string
  readonly expectedFamily: string
  readonly subtitleCount: number
  readonly source: unknown
  /** Stage-owned original native JSON; later user edits do not replace the initial font evidence. */
  readonly contentPath?: string
  readonly read: (path: string) => Promise<Buffer>
}): Promise<readonly { readonly path: string; readonly sha256: string }[]> {
  const parsed = sourceSchema.safeParse(input.source), names = families.get(input.expectedFamily)
  if (!parsed.success || names === undefined) fail()
  const source = parsed.data, proof = source.subtitle_font, [fontName, licenseName] = names
  if (proof.requested !== input.expectedFamily || proof.resolved !== input.expectedFamily
    || !equalPath(proof.path, resolve(input.draft, 'Resources/fonts', fontName))
    || !equalPath(proof.license_path, resolve(input.draft, 'Resources/fonts', licenseName))
    || !equalPath(proof.review_path, resolve(input.draft, 'muse-review.json'))) fail()
  const checked: { path: string; sha256: string }[] = []
  const read = async (path: string, expected?: string) => {
    const bytes = await input.read(path), sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expected !== undefined && expected !== sha256) fail()
    checked.push({ path, sha256 }); return bytes
  }
  const manifest = manifestSchema.parse(JSON.parse((await read(resolve(dirname(input.fontsDir), 'media-runtime.json'))).toString('utf8')))
  for (const [retained, sha256, relativeName] of [[proof.path, proof.sha256, `fonts/${fontName}`],
    [proof.license_path, proof.license_sha256, `licenses/${licenseName}`]] as const) {
    const [declared, ...duplicates] = manifest.files.filter(row => row.path === relativeName)
    if (declared === undefined || duplicates.length > 0 || declared.sha256 !== sha256
      || !source.materials.some(row => equalPath(row.path, retained) && row.sha256 === sha256)) fail()
    const bundled = await read(resolve(dirname(input.fontsDir), relativeName), sha256)
    if (bundled.length !== declared.bytes) fail()
    await read(retained, sha256)
  }
  if (!source.files.some(row => row.path === 'muse-review.json' && row.sha256 === proof.review_sha256)) fail()
  const review: unknown = JSON.parse((await read(proof.review_path, proof.review_sha256)).toString('utf8'))
  const reviewProof = z.object({ subtitle_font: proofSchema.omit({ review_path: true, review_sha256: true }) }).parse(review).subtitle_font
  if (Object.entries(reviewProof).some(([key, value]) => proof[key as keyof typeof proof] !== value)) fail()
  const contentFile = source.files.find(row => row.path === 'draft_content.json')
  if (contentFile === undefined) fail()
  const native = input.contentPath ?? resolve(input.draft, contentFile.path)
  const content = contentSchema.parse(JSON.parse((await read(native, contentFile.sha256)).toString('utf8')))
  const subtitles = content.tracks.filter(track => track.type === 'text' && track.name !== 'AI内容标识').flatMap(track => track.segments)
  if (subtitles.length !== input.subtitleCount || subtitles.length === 0) fail()
  for (const segment of subtitles) {
    const [material, ...duplicates] = content.materials.texts.filter(row => row.id === segment.material_id)
    if (material === undefined || duplicates.length > 0) fail()
    const text = textSchema.parse(JSON.parse(material.content))
    if (text.styles.some(style => !equalPath(style.font.path, proof.path))) fail()
  }
  return checked
}
