/** Opt-in installed-client downloads with independent file validation and private, joined cleanup. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { mountPackagedRuntime } from './hongguo-runtime-smoke.mjs'

/**
 * Validate explicit live acceptance settings before allocating resources or making requests.
 * @param environment Opt-in flag and comma-separated series IDs.
 * @returns Validated series IDs, or null when live acceptance is disabled.
 */
export function hongguoLiveSeries(environment) {
  const required = environment.MUSE_HONGGUO_LIVE_REQUIRED
  if (required === undefined || required === '0') return null
  assert.ok(required === '1', 'Hongguo live acceptance flag must be 0 or 1')
  const ids = (environment.MUSE_HONGGUO_LIVE_IDS ?? '').split(',').map(value => value.trim())
  assert.ok(ids.length >= 2 && ids.length <= 10 && new Set(ids).size === ids.length
    && ids.every(value => /^\d{10,25}$/u.test(value)), 'Hongguo live acceptance requires 2–10 distinct series IDs')
  return ids
}

/** Check a downloaded regular file without following a link outside the private workspace. */
async function checkedFile(workspace, path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Hongguo live file requires an absolute path')
  const info = await lstat(path)
  const resolved = await realpath(path)
  const name = relative(workspace, resolved)
  assert.ok(info.isFile() && !info.isSymbolicLink() && name !== '' && !isAbsolute(name)
    && name !== '..' && !name.startsWith(`..${sep}`), 'Hongguo live file escaped its private workspace')
  return info
}

/**
 * Download complete test series using only the installed plugin and its prepared native resources.
 * @param root Installed dependency root; no workspace package resolution is used by the default mount.
 * @param resourcesRuntime Installed external runtimes.
 * @param environment Explicit opt-in settings and prepared private source paths.
 * @param mount Owned runtime factory; only tests substitute it.
 * @returns Secret-free counts and digests after client/context disposal and removal of private media.
 */
export async function checkHongguoLive(root, resourcesRuntime, environment = process.env, mount = mountPackagedRuntime) {
  const ids = hongguoLiveSeries(environment)
  if (ids === null) return { required: false }
  const paths = { app: environment.MUSE_HONGGUO_LEGACY_APP_DIR, java: environment.MUSE_HONGGUO_JAVA_PATH,
    python: environment.MUSE_HONGGUO_PYTHON_PATH,
    ffmpeg: join(resourcesRuntime, 'media', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ffprobe: join(resourcesRuntime, 'media', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') }
  assert.ok(environment.MUSE_HONGGUO_BOOTSTRAP_DEVICES === '1'
    && [paths.app, paths.java, paths.python].every(value => typeof value === 'string' && isAbsolute(value)),
  'Hongguo live acceptance requires prepared private paths')
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'muse-hongguo-live-')))
  let runtime, receipt, stage = 'mount'
  try {
    try {
      await chmod(workspace, 0o700)
      runtime = await mount(root, paths, true)
      stage = 'download'
      const result = await runtime.client.download({ seriesIds: ids }, AbortSignal.timeout(1_200_000), workspace)
      assert.ok(result.ok === true && result.complete === true && result.fullDecodeChecked === true,
        'Hongguo live series did not complete')
      stage = 'files'
      assert.ok(Array.isArray(result.items) && result.items.length === ids.length
        && new Set(result.items.map(item => item.seriesId)).size === ids.length
        && result.items.every(item => ids.includes(item.seriesId)), 'Hongguo live series coverage differs')
      const seen = new Set(), series = []
      let bytes = 0, episodes = 0
      for (const item of result.items) {
        assert.ok(item.complete === true && Number.isSafeInteger(item.episodeCount) && item.episodeCount > 0
          && item.downloadedEpisodeCount === item.episodeCount && Array.isArray(item.episodes)
          && item.episodes.length === item.episodeCount, 'Hongguo live episode coverage differs')
        const digests = []
        for (const [offset, episode] of item.episodes.entries()) {
          assert.ok(episode.index === offset + 1 && episode.fullDecodeChecked === true
            && episode.validationLevel === 'ffprobe-full-decode-sha256' && !seen.has(episode.path),
          'Hongguo live episode validation is incomplete')
          seen.add(episode.path)
          const info = await checkedFile(workspace, episode.path)
          assert.ok(info.size > 0 && info.size === episode.bytes, 'Hongguo live file size differs')
          const hash = createHash('sha256')
          for await (const chunk of createReadStream(episode.path)) hash.update(chunk)
          const digest = hash.digest('hex')
          assert.ok(digest === episode.sha256, 'Hongguo live file hash differs')
          digests.push(digest)
          bytes += info.size
          episodes++
        }
        series.push({ seriesId: item.seriesId, episodes: item.episodeCount, sha256: digests })
      }
      assert.ok(bytes === result.validatedBytes, 'Hongguo live total bytes differ')
      const manifestPath = join(result.path, 'download-manifest.json')
      await checkedFile(workspace, manifestPath)
      const manifestBytes = await readFile(manifestPath)
      assert.deepEqual(JSON.parse(manifestBytes.toString('utf8')), result, 'Hongguo live manifest differs')
      receipt = { required: true, complete: true, fullDecodeChecked: true, independentlyHashed: true,
        episodes, bytes, series, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') }
    } finally {
      stage = stage === 'files' && receipt ? 'cleanup' : stage
      try { await runtime?.client.dispose() }
      finally {
        try { await runtime?.disposeContext() }
        finally { await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
      }
    }
  } catch (error) {
    // Source errors can contain identity or signed URLs; only the fixed acceptance stage crosses this process.
    throw new Error(`Hongguo live installed acceptance failed (stage=${stage})`)
  }
  return { ...receipt, cleanup: true }
}
