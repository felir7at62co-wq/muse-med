/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { desktopArtifactDirectory, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { resolveDesktopAppId } from './desktop-release-environment.mjs'
import { SUPERMUSE_WINDOWS_APP_ID, SUPERMUSE_WINDOWS_PRODUCT_NAME } from './supermuse-identity.mjs'
import { verifyMacOSAdHocSignature } from './verify-macos-signature.mjs'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const appId = process.env.DSH_DESKTOP_APP_ID?.trim()
const supermuse = windows && appId === SUPERMUSE_WINDOWS_APP_ID
const artifacts = desktopArtifactDirectory(target, values.unsigned === true, appId)
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'muse-med.app', 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const windowsExecutable = supermuse ? SUPERMUSE_WINDOWS_PRODUCT_NAME : 'muse-med'
const executable = windows ? join(application, windowsExecutable + '.exe') : join(application, 'MacOS', 'muse-med')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (supermuse && ['app-update.yml', 'muse-update-sources.json'].some(file => existsSync(join(resources, file)))) {
  throw new Error('Supermuse package contains Desktop updater configuration')
}
if (windows && !values.unsigned) await verifyWindowsCode(application)
if (!windows && values.unsigned) verifyMacOSAdHocSignature(join(application, '..'), resolveDesktopAppId(process.env))
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
