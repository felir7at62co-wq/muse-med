/** Install a native Jingliu editing package and its declared media into a fresh Jianying draft. */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { unzipSync } from 'fflate'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { boundedBytes, mediaPath } from '@deepseek-ai/dsh-jingliu-connection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'

/**
 * The failure of an incomplete draft package or material list.
 * @returns A coded error.
 */
export const invalid = (): HarnessError => new HarnessError('镜流草稿包或素材清单不完整，请检查云项目和导出结果。', 'JINGLIU_INVALID_DRAFT')
/**
 * Whether a value is a file name valid on every platform.
 * @param v - Candidate name.
 * @returns Whether it is a non-empty name without separators, reserved characters or a trailing dot or space.
 */
export const leaf = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 180 && !/[\\/:*?"<>|\x00-\x1f]/u.test(v) && !/[. ]$/u.test(v) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(v)

function nativeMedia(input: string): string {
  const url = new URL(input, 'https://studio.invalid')
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash) throw invalid()
  const path = url.pathname.replace(/^\/jingliu\//u, '/')
  if (!/^\/fwp?\/media\//u.test(path)) throw invalid()
  return path
}

/**
 * Replace the studio's draft placeholders in every string of a draft document.
 * @param value - Draft document or one of its values.
 * @param paths - Local path of each placeholder.
 * @returns The document with local paths.
 */
export function fill(value: JsonValue, paths: Record<string, string>): JsonValue {
  if (typeof value === 'string') return value.replace(/__SFMAT__|__SFDRAFT__|__SFROOT__/gu, token => paths[token] ?? token)
  if (Array.isArray(value)) return value.map(v => fill(v, paths))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, fill(v, paths)]))
  return value
}

/**
 * Install an exported production in the user’s local Jianying draft folder. With a media folder and a session that
 * downloads to local files, materials are downloaded once into that folder, shared by every draft of the production,
 * and linked or copied into the draft; otherwise each material is streamed into the draft.
 * @param session - Same studio owner that exported the project.
 * @param result - Native export result.
 * @param root - User's configured draft root.
 * @param receipt - Stable Session and call identifiers.
 * @param signal - Cancellation.
 * @param mediaFolder - The production's local media folder, `<workspace>/jingliu/<project>`.
 * @returns Local draft, counts and verified material bytes.
 */
export async function installDraft(
  session: JingliuSession, result: Record<string, JsonValue>, root: string, receipt: string, signal: AbortSignal, mediaFolder?: string,
): Promise<Record<string, JsonValue>> {
  if (!session.media || typeof result.url !== 'string' || !result.url.endsWith('.zip') || typeof result.shots !== 'number' || result.shots < 1) throw invalid()
  let archive: Buffer | undefined
  await session.media(nativeMedia(result.url), signal, async (response) => { archive = await boundedBytes(response, 64 * 1024 * 1024) })
  if (!archive) throw invalid()
  let expanded = 0
  const seen = new Set<string>()
  const files = unzipSync(archive, { filter: (entry) => {
    const parts = entry.name.split('/')
    if (entry.name.endsWith('/')) return false
    if (!parts.every(leaf) || seen.has(entry.name)) throw invalid()
    seen.add(entry.name)
    const keep = (parts.length === 2 && parts[1] === 'manifest.json') || (parts.length === 4 && parts[1] === 'drafts' &&
      ['draft_content.json','draft_info.json','draft_meta_info.json','draft_cover.jpg'].includes(parts[3] ?? ''))
    if (keep) expanded += entry.originalSize
    if (expanded > 128 * 1024 * 1024 || seen.size > 8192) throw invalid()
    return keep
  } })
  const entries = Object.keys(files)
  const manifests = entries.filter(p => p.endsWith('/manifest.json'))
  const [manifestPath] = manifests
  if (!manifestPath || manifests.length !== 1) throw invalid()
  const json = (path: string): Record<string, JsonValue> => {
    const bytes = files[path]
    if (!bytes) throw invalid()
    const v: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (!isFields(v)) throw invalid()
    return v
  }
  const manifest = json(manifestPath)
  if (!Array.isArray(manifest.drafts) || manifest.drafts.length !== 1 || !isFields(manifest.drafts[0]) || !leaf(manifest.drafts[0].name) ||
      !Array.isArray(manifest.materials) || !manifest.materials.length || manifest.materials.length !== result.materials ||
      manifest.mat_token !== '__SFMAT__' || manifest.draft_token !== '__SFDRAFT__' || manifest.root_token !== '__SFROOT__') throw invalid()
  const name = manifest.drafts[0].name
  const prefix = manifestPath.slice(0,-'manifest.json'.length) + 'drafts/' + name + '/'
  const content = json(prefix + 'draft_content.json')
  const metadata = json(prefix + 'draft_meta_info.json')
  if (!Array.isArray(content.tracks) || !content.tracks.some(t => isFields(t) && t.type === 'video' && Array.isArray(t.segments) && t.segments.length)) throw invalid()
  const fingerprint = createHash('sha256').update(session.identity + ':' + receipt).digest('hex')
  const directory = join(resolve(root), name.slice(0,90) + ' - Muse ' + fingerprint.slice(0,10))
  const old = await installedDraft(directory, fingerprint)
  if (old) return old
  const declared = manifest.materials, shots = result.shots
  const media = session.media, download = session.download, place = session.place
  return await commitDraft(root, directory, async (stage) => {
    const mediaDir = join(stage, 'media')
    await mkdir(mediaDir)
    const names = new Set<string>()
    const materials = declared.map((file) => {
      if (!isFields(file) || !leaf(file.name) || typeof file.url !== 'string' || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) ||
          file.size < 1 || names.has(file.name.toLowerCase())) throw invalid()
      names.add(file.name.toLowerCase())
      return { target: join(mediaDir, file.name), path: nativeMedia(file.url), size: file.size }
    })
    if (mediaFolder !== undefined && download && place) {
      const local = await download(materials.map(m => m.path), mediaFolder, signal)
      for (const material of materials) {
        const file = local.get(mediaPath(material.path).path)
        if (file === undefined || file.size !== material.size) throw invalid()
        await place(file, material.target)
      }
    } else {
      for (const { target, path, size } of materials) {
        await media(path, signal, async (response) => {
          if (!response.body) throw invalid()
          let received = 0
          const meter = new Transform({ transform(chunk: Buffer, _encoding, next) {
            received += chunk.length
            if (received > size) next(invalid()); else next(null, chunk)
          } })
          await pipeline(Readable.from(response.body), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
          if (received !== size) throw invalid()
        })
      }
    }
    let bytes = 0
    for (const { target } of materials) bytes += (await stat(target)).size
    const paths = placeholderPaths(root, directory)
    content.name = basename(directory)
    metadata.draft_name = basename(directory)
    metadata.draft_id = randomUUID().toUpperCase()
    const serialized = JSON.stringify(fill(content, paths))
    for (const path of ['draft_content.json','draft_info.json']) await writeFile(join(stage,path), serialized)
    await writeFile(join(stage,'draft_meta_info.json'), JSON.stringify(fill(metadata, paths)))
    const cover = files[prefix + 'draft_cover.jpg']
    if (cover) await writeFile(join(stage,'draft_cover.jpg'), cover)
    if (typeof result.materials_bytes === 'number' && bytes !== result.materials_bytes) throw invalid()
    return { fingerprint, path: directory, name: basename(directory), shots, materials: names.size, bytes,
      tracks: trackCounts(content) }
  }, signal)
}

/**
 * Local paths of the studio's draft placeholders, with forward slashes on every platform.
 * @param root - User's draft root.
 * @param directory - Final draft directory.
 * @returns Path of the material folder, the draft and the root by placeholder.
 */
export function placeholderPaths(root: string, directory: string): Record<string, string> {
  return { __SFMAT__: join(directory, 'media').split(sep).join('/'), __SFDRAFT__: directory.split(sep).join('/'),
    __SFROOT__: resolve(root).split(sep).join('/') }
}

/** File inside an installed draft that records which export it came from. */
const RECEIPT_FILE = '.muse-jingliu.json'

/**
 * Read the receipt of a draft this installer already wrote.
 * @param directory - Final draft directory.
 * @param fingerprint - Identity of the export the caller is about to install.
 * @returns The receipt, or undefined when the directory does not exist.
 */
export async function installedDraft(directory: string, fingerprint: string): Promise<Record<string, JsonValue> | undefined> {
  try {
    const old: unknown = JSON.parse(await readFile(join(directory, RECEIPT_FILE), 'utf8'))
    if (!isFields(old) || old.fingerprint !== fingerprint || old.path !== directory) throw invalid()
    return old
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

/**
 * Track types and segment counts of a draft, as receipts report them.
 * @param content - Draft content document.
 * @returns One row per track.
 */
export function trackCounts(content: Record<string, JsonValue>): JsonValue[] {
  return Array.isArray(content.tracks) ? content.tracks.filter(isFields).map(t => ({
    type: t.type ?? null, segments: Array.isArray(t.segments) ? t.segments.length : 0,
  })) : []
}

/**
 * Write a draft in a hidden stage directory under the draft root and rename it into place with its receipt, so a
 * cancelled or failed install leaves no partial draft.
 * @param root - User's draft root.
 * @param directory - Final draft directory; it must not exist.
 * @param write - Fills the stage directory and returns the receipt fields.
 * @param signal - Cancellation, checked before the rename.
 * @returns The receipt.
 */
export async function commitDraft(root: string, directory: string,
  write: (stage: string) => Promise<Record<string, JsonValue>>, signal: AbortSignal): Promise<Record<string, JsonValue>> {
  const stage = await mkdtemp(join(resolve(root), '.muse-draft-'))
  try {
    const receipt = await write(stage)
    await writeFile(join(stage, RECEIPT_FILE), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    await rename(stage, directory)
    return receipt
  } finally { await rm(stage, { recursive: true, force: true }) }
}
