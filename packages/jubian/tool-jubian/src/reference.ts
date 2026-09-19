/**
 * Local reference-image upload: read a file, align it, and put it where the
 * workbench puts its own references.
 *
 * `gpt-image-2` accepts references as HTTPS URLs only, and the URL that works is
 * one the provider's own bucket serves. The destination is therefore read from
 * the public frontend bundle at call time rather than stored, and the upload is
 * signed with the object-storage scheme that bundle uses.
 *
 * Alignment is the one step this package cannot do itself: both edges must be
 * multiples of 16, and Node ships no image codec while this package adds no
 * runtime dependency. An already-aligned file is uploaded byte for byte; an
 * unaligned one is handed to the local `ffmpeg` binary when one can be found,
 * and otherwise the call fails with the exact size the caller must produce. It
 * never uploads an unaligned file silently — that would be a different request
 * from the one the provider's own client makes.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import {
  alignedReferenceSize, buildReferenceObjectKey, extractAppScriptUrl, extractTosUploadConfig,
  readReferenceImage, referenceMaterialItem, signTosObjectPut,
} from '@deepseek-ai/dsh-jubian-api'
import type { ReferenceFormat, ReferenceImage, TosUploadConfig } from '@deepseek-ai/dsh-jubian-api'

const run = promisify(execFile)

/** The workbench origin whose bundle carries the upload destination. */
const FRONTEND_URL = 'https://web.jubianai.net/'

/** One re-encode request, as the seam receives it. */
export interface ScaleRequest {
  /** The original file bytes. */
  bytes: Uint8Array
  /** The size the file actually has. */
  width: number
  height: number
  format: ReferenceFormat
  /** The size the provider's pipeline requires. */
  target: { width: number; height: number }
}

/** Everything the upload path takes from the outside world, injectable for tests. */
export interface ReferenceUploadDeps {
  /** Transport for the frontend bundle and the object upload. */
  fetch?: typeof fetch
  /** Re-encode step; defaults to a local `ffmpeg` run. */
  scaleImage?: (request: ScaleRequest) => Promise<Uint8Array>
  /** Clock used for the object key and the signature. */
  now?: () => Date
  /** Explicit `ffmpeg` path, taking precedence over the environment. */
  ffmpegPath?: string
}

/** Where a local `ffmpeg` may be found, in resolution order. */
const FFMPEG_ENV = ['DSH_JUBIAN_FFMPEG', 'FFMPEG_PATH', 'MUSE_FFMPEG_EXECUTABLE'] as const

/** The file extension one detected container format uses. */
const EXTENSIONS: Record<ReferenceFormat, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' }

function fail(code: 'CONTRACT_CHANGED' | 'NETWORK_ERROR' = 'CONTRACT_CHANGED'): never {
  throw new JubianError(code)
}

/** Resolve the `ffmpeg` binary this call will use, or null when none is configured. */
function ffmpegBinary(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim()) return explicit
  for (const name of FFMPEG_ENV) {
    const value = process.env[name]
    if (value !== undefined && value.trim()) return value
  }
  return 'ffmpeg'
}

/**
 * Re-encode one image to the required size with a local `ffmpeg`.
 *
 * The scale filter is the only transformation: the provider's rule is about the
 * frame's edges, not about its content, and re-encoding at all is what makes the
 * new size true of the pixels rather than only of a header.
 * @param request - Source bytes, detected format and target size.
 * @param explicitPath - Configured binary path, or undefined to use the environment.
 * @returns The normalized file's bytes, in the source's own container format.
 * @throws {JubianError} `CONTRACT_CHANGED` when no usable `ffmpeg` produced a readable result.
 */
export async function scaleImageWithFfmpeg(request: ScaleRequest, explicitPath?: string): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'jubian-reference-'))
  const extension = EXTENSIONS[request.format]
  const source = join(directory, `source${extension}`)
  const target = join(directory, `prepared${extension}`)
  try {
    await writeFile(source, request.bytes)
    try {
      await run(ffmpegBinary(explicitPath),
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', source,
          '-vf', `scale=${request.target.width}:${request.target.height}`, '-frames:v', '1', target],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    } catch {
      return fail()
    }
    const bytes = await readFile(target)
    const normalized = readReferenceImage(bytes)
    if (normalized.width !== request.target.width || normalized.height !== request.target.height) return fail()
    return bytes
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Read the upload destination from the live frontend bundle. */
async function loadTosConfig(transport: typeof fetch): Promise<TosUploadConfig> {
  let html: string
  let appJs: string
  try {
    const page = await transport(FRONTEND_URL, { redirect: 'follow' })
    if (!page.ok) return fail('NETWORK_ERROR')
    html = await page.text()
    const script = await transport(extractAppScriptUrl(html, FRONTEND_URL), { redirect: 'follow' })
    if (!script.ok) return fail('NETWORK_ERROR')
    appJs = await script.text()
  } catch (error) {
    if (error instanceof JubianError) throw error
    return fail('NETWORK_ERROR')
  }
  return extractTosUploadConfig(appJs)
}

/** Copy bytes into a plain `ArrayBuffer`-backed view, the shape a fetch body accepts. */
function asBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

/** Put one object and confirm the provider accepted it. */
async function putObject(transport: typeof fetch, url: string, headers: Record<string, string>,
  payload: Uint8Array): Promise<void> {
  let response: Response
  try {
    response = await transport(url, { method: 'PUT', headers, body: asBody(payload) })
  } catch { return fail('NETWORK_ERROR') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return fail('NETWORK_ERROR')
  }
}

/** The refusal a caller gets when an unaligned image cannot be re-encoded locally. */
function alignmentRefusal(image: ReferenceImage, size: { width: number; height: number }): Record<string, unknown> {
  return {
    uploaded: false,
    status: 'alignment_required',
    source_width: image.width,
    source_height: image.height,
    required_width: size.width,
    required_height: size.height,
    guidance: `参考图 ${image.width}×${image.height} 的两条边必须是 16 的倍数（应为 ${size.width}×${size.height}）。`
      + '本机找不到可用的 ffmpeg，插件不会把不合规的图片上传上去。'
      + `请先把文件改成 ${size.width}×${size.height}`
      + `（例如 ffmpeg -i in -vf scale=${size.width}:${size.height} out），`
      + '或把 DSH_JUBIAN_FFMPEG 指向 ffmpeg 可执行文件（也可用 FFMPEG_PATH）后重试。',
  }
}

/**
 * Upload one local reference image and return the material item that names it.
 *
 * The returned `material_url` is what an asset request's `materialList` or a
 * generation's `references` must use. The call is free and creates no task, but
 * it does write one object into the provider's bucket, so a caller that only
 * needs a URL it already has should not call it.
 * @param args - `image_path`, the local file to upload.
 * @param deps - Optional transport, re-encode, clock and `ffmpeg` path overrides.
 * @returns The uploaded URL and its material item, or an `alignment_required` refusal.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file, its format or the bundle layout cannot be used,
 *   or `NETWORK_ERROR` when the frontend or the bucket could not be reached.
 */
export async function uploadReferenceMethod(args: { image_path?: string | undefined },
  deps: ReferenceUploadDeps = {}): Promise<Record<string, unknown>> {
  const path = args.image_path
  if (path === undefined || !path.trim()) fail()
  const source = resolve(path)
  let bytes: Uint8Array
  try {
    bytes = await readFile(source)
  } catch { return fail() }
  const image: ReferenceImage = readReferenceImage(bytes)
  const size = alignedReferenceSize(image)
  const transport = deps.fetch ?? fetch
  const now = deps.now?.() ?? new Date()
  let payload = bytes
  if (!size.aligned) {
    const scaler = deps.scaleImage ?? (async (request: ScaleRequest) =>
      await scaleImageWithFfmpeg(request, deps.ffmpegPath))
    try {
      payload = await scaler({ bytes, width: image.width, height: image.height, format: image.format,
        target: { width: size.width, height: size.height } })
    } catch {
      return alignmentRefusal(image, size)
    }
  }
  const key = buildReferenceObjectKey(now, randomBytes(16).toString('hex'), image.extension)
  const config = await loadTosConfig(transport)
  const signed = signTosObjectPut({ config, key, payload, content_type: image.content_type, now })
  await putObject(transport, signed.url, signed.headers, payload)
  return { ...referenceMaterialItem(signed.url, 1),
    format: image.format,
    source_width: image.width,
    source_height: image.height,
    width: size.width,
    height: size.height,
    reencoded: !size.aligned,
    bytes: payload.byteLength,
    sha256: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    next: '把这个 material_url 作为 gpt-image-2 的参考图 URL 使用（image_generate 的 references），'
      + '或放进资产的 materialList。上传本身免费、不创建任务。' }
}
