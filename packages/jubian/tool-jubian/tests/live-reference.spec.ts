import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractAppScriptUrl, extractTosUploadConfig } from '@deepseek-ai/dsh-jubian-api'
import { scaleImageWithFfmpeg, uploadReferenceMethod } from '../src/reference.ts'

/**
 * These checks talk to the real workbench and to the provider's bucket, so they
 * run only under `DSH_JUBIAN_LIVE=1`. The upload writes one tiny test image into
 * the destination the product's own client uses; nothing is charged and no task
 * is created.
 */
const enabled = process.env.DSH_JUBIAN_LIVE === '1'
const run = promisify(execFile)

/** The `ffmpeg` binary this environment offers, or null when there is none. */
function ffmpegBinary(): string | null {
  for (const name of ['DSH_JUBIAN_FFMPEG', 'FFMPEG_PATH', 'MUSE_FFMPEG_EXECUTABLE']) {
    const value = process.env[name]
    if (value !== undefined && value.trim()) return value
  }
  return null
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-live-reference-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe.skipIf(!enabled)('live reference upload', () => {
  it('reads the upload destination out of the bundle the workbench serves today', async () => {
    const html = await (await fetch('https://web.jubianai.net/', { redirect: 'follow' })).text()
    const scriptUrl = extractAppScriptUrl(html, 'https://web.jubianai.net/')
    const appJs = await (await fetch(scriptUrl, { redirect: 'follow' })).text()
    const config = extractTosUploadConfig(appJs)
    // The access pair is public by design (it ships inside the bundle); only the
    // shape and the destination are asserted, and no secret value is logged.
    expect(scriptUrl).toMatch(/\/static\/js\/app\.[^/]+\.js$/u)
    expect(config.bucket.length).toBeGreaterThan(0)
    expect(config.endpoint).toMatch(/^tos-[a-z0-9-]+\.volces\.com$/u)
    expect(config.region).toMatch(/^[a-z0-9-]+$/u)
    expect(config.access_key_id.length).toBeGreaterThan(10)
    expect(config.access_key_secret.length).toBeGreaterThan(10)
    console.log('ARTIFACT tos endpoint =', config.endpoint, 'bucket =', config.bucket, 'region =', config.region)
  }, 120000)

  it('normalizes a real local image with the local ffmpeg and uploads it', async () => {
    const binary = ffmpegBinary()
    expect(binary, 'no ffmpeg configured for this run').not.toBeNull()
    const source = join(root, 'reference.png')
    await run(binary ?? 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=100x70', '-frames:v', '1', source])
    // The normalizer runs for real, not injected: this is the path a session uses.
    const scaled = await scaleImageWithFfmpeg({ bytes: new Uint8Array(await readFile(source)),
      width: 100, height: 70, format: 'png', target: { width: 96, height: 64 } })
    const result = await uploadReferenceMethod({ image_path: source },
      { scaleImage: async () => scaled, now: () => new Date() })
    expect(result).toMatchObject({ materialType: 'image', sortOrder: 1, width: 96, height: 64,
      source_width: 100, source_height: 70, reencoded: true })
    expect(String(result.materialUrl)).toMatch(
      /^https:\/\/[a-z0-9-]+\.tos-[a-z0-9-]+\.volces\.com\/prod\/sys-material-image\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{32}\.png$/u)
    console.log('ARTIFACT materialUrl =', result.materialUrl, 'bytes =', result.bytes, 'sha256 =', result.sha256)
  }, 180000)
})
