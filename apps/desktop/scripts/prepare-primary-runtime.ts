/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'
import { prepareMacMedia } from './prepare-macos-media.ts'
import { obtain, verifyMediaResource } from './media-resources.ts'
import { extractSubtitleFont, validateMediaLock, type MediaLock } from './prepare-media-runtime.ts'
import { prepareHongguoRuntime, validateHongguoRuntimeLock } from './prepare-hongguo-runtime.ts'
import { prepareCuaRuntime, validateCuaRuntimeLock } from './prepare-cua-runtime.ts'

/** Install the shared, hash-locked CJK fonts and their notices in a Mac media payload.
 * @param output - Desktop runtime media directory.
 * @param cache - Download cache for the locked public resources.
 * @param lock - Validated media resource identities.
 */
export async function prepareMacFonts(output: string, cache: string, lock: MediaLock): Promise<void> {
  const notices = ['LICENSE-NotoSansCJK.txt', 'LICENSE-ZhuqueFangsong.txt'].map((name) => {
    const notice = lock.notices.find(item => item.filename === name)
    if (notice === undefined) throw new Error(`Mac media: missing font license ${name}`)
    return notice
  })
  await mkdir(cache, { recursive: true })
  const [font, archive, ...licenses] = await Promise.all([lock.font, lock.subtitleFontArchive, ...notices]
    .map(resource => obtain(resource, cache)))
  const stage = await mkdtemp(join(tmpdir(), 'muse-mac-fonts-'))
  try {
    await mkdir(join(stage, 'fonts'))
    await cp(font!, join(stage, 'fonts', lock.font.filename))
    await extractSubtitleFont(archive!, stage, lock.subtitleFont)
    await verifyMediaResource(join(stage, 'fonts', lock.font.filename), lock.font)
    await mkdir(join(output, 'fonts'), { recursive: true })
    await mkdir(join(output, 'notices'), { recursive: true })
    await cp(join(stage, 'fonts'), join(output, 'fonts'), { recursive: true })
    for (const [index, notice] of notices.entries()) {
      await cp(licenses[index]!, join(output, 'notices', notice.filename))
      await verifyMediaResource(join(output, 'notices', notice.filename), notice)
    }
    await verifyMediaResource(join(output, 'fonts', lock.subtitleFont.filename), lock.subtitleFont)
  } finally { await rm(stage, { recursive: true, force: true }) }
}

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: { deferSmoke?: boolean } = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const target = resolveDesktopBuildTarget()
  await preparePayload({ target, output: paths.runtime, cache: paths.downloads, version })
  const platform = desktopTargetPlatform(target)
  if (platform.platform === 'darwin') {
    const media = join(paths.downloads, 'macos-media', platform.arch)
    await prepareMacMedia(media, paths.downloads, platform.arch)
    await cp(media, join(paths.runtime, 'media'), { recursive: true })
    const lock = validateMediaLock(JSON.parse(readFileSync(new URL('./media-runtime.lock.json', import.meta.url), 'utf8')))
    await prepareMacFonts(join(paths.runtime, 'media'), paths.downloads, lock)
  }
  const hongguoLock = validateHongguoRuntimeLock(JSON.parse(readFileSync(new URL('./hongguo-runtime.lock.json', import.meta.url), 'utf8')))
  await prepareHongguoRuntime({ output: join(paths.runtime, 'hongguo'), cache: paths.downloads, target, lock: hongguoLock })
  if (target === 'win-x64') {
    const cuaLock = validateCuaRuntimeLock(JSON.parse(readFileSync(new URL('./cua-runtime.lock.json', import.meta.url), 'utf8')))
    await prepareCuaRuntime({ output: join(paths.runtime, 'cua'), cache: paths.downloads, lock: cuaLock })
  }
  if (!options.deferSmoke) smokePrimaryRuntime(join(paths.runtime, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
