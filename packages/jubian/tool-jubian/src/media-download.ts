/** Resume an exact media download from a verified local copy. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { downloadMedia, type MediaKind } from '@deepseek-ai/dsh-jubian-api'
import { z } from 'zod'

const receiptSchema = z.object({
  version: z.literal(1),
  source_sha256: z.hash('sha256'),
  kind: z.enum(['image', 'video']),
  path: z.string().min(1),
  media_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).refine(receipt => (receipt.kind === 'video') === (receipt.media_type === 'video/mp4'),
  'Downloaded media kind must match the decoded type')
type DownloadReceipt = z.infer<typeof receiptSchema>
const candidateLimit = 100

/**
 * Resolve the output extension proved by the media header.
 * @param requested - Absolute requested output path.
 * @param mediaType - Media type proved from decoded bytes.
 * @returns Output path with a compatible extension.
 */
export function downloadedMediaPath(requested: string, mediaType: string): string {
  const extension = extname(requested)
  const decoded = `.${mediaType.replace(/^[^/]+\//u, '')}`
  return extension.toLowerCase() === decoded || extension.toLowerCase() === '.jpg' && decoded === '.jpeg'
    ? requested : requested.slice(0, requested.length - extension.length) + decoded
}

function candidatePath(path: string, source: string, attempt: number): string {
  if (attempt === 0) return path
  const extension = extname(path)
  return `${path.slice(0, path.length - extension.length)}-resume-${source.slice(0, 12)}-${attempt}${extension}`
}

async function readReceipt(path: string): Promise<DownloadReceipt | undefined> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (_error) { return undefined }
  const parsed = receiptSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

async function validSavedMedia(receipt: DownloadReceipt, signal?: AbortSignal): Promise<boolean> {
  try {
    const info = await lstat(receipt.path)
    if (!info.isFile() || info.size !== receipt.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(receipt.path, signal ? { signal } : undefined)) digest.update(chunk as Buffer)
    return `sha256:${digest.digest('hex')}` === receipt.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function result(receipt: DownloadReceipt, receiptPath: string, reused: boolean): Record<string, unknown> {
  return { path: receipt.path, kind: receipt.kind, media_type: receipt.media_type,
    bytes: receipt.bytes, sha256: receipt.sha256, reused, download_receipt_path: receiptPath,
    source_sha256: receipt.source_sha256 }
}

/**
 * Download a missing or altered clip into a distinct path, keeping prior files.
 * @param source - Exact provider output URL.
 * @param kind - Media kind requested by the caller.
 * @param requested - Absolute target path of the original request.
 * @param signal - Caller cancellation.
 * @returns Verified local media receipt and whether a previous file was reused.
 */
export async function resumeMediaDownload(source: string, kind: MediaKind, requested: string,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const sourceDigest = createHash('sha256').update(source).digest('hex')
  const receiptPath = `${requested}.jubian-${kind}-${sourceDigest.slice(0, 16)}.json`
  await mkdir(dirname(requested), { recursive: true })
  return await withFileLock(receiptPath, async () => {
    signal?.throwIfAborted()
    const prior = await readReceipt(receiptPath)
    if (prior?.source_sha256 === sourceDigest && prior.kind === kind) {
      const target = downloadedMediaPath(requested, prior.media_type)
      for (let attempt = 0; attempt < candidateLimit; attempt++) {
        if (prior.path !== candidatePath(target, sourceDigest, attempt)) continue
        if (await validSavedMedia(prior, signal)) return result(prior, receiptPath, true)
        break
      }
    }
    const downloaded = await downloadMedia(source, { kind, ...(signal ? { signal } : {}) })
    const target = downloadedMediaPath(requested, downloaded.media_type)
    for (let attempt = 0; attempt < candidateLimit; attempt++) {
      signal?.throwIfAborted()
      const path = candidatePath(target, sourceDigest, attempt)
      try { await writeFile(path, downloaded.bytes, { flag: 'wx', ...(signal ? { signal } : {}) }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      const receipt = receiptSchema.parse({ version: 1, source_sha256: sourceDigest, kind, path,
        media_type: downloaded.media_type, bytes: downloaded.bytes.byteLength, sha256: downloaded.sha256 })
      await writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
      return result(receipt, receiptPath, false)
    }
    throw new Error(`找不到可用的下载候选路径：${target}`)
  })
}
