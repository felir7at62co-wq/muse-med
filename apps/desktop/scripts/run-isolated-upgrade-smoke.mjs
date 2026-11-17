/** Run NSIS directory and path guards in uniquely allocated temporary directories on Windows CI. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Upgrade safety smoke requires Windows')
const require = createRequire(import.meta.url)
require('app-builder-lib')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js')
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const compiler = await getMakeNsisPath()
const sevenZip = await getPath7za()
const script = fileURLToPath(new URL('./smoke-installer-directories.ps1', import.meta.url))
const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script,
  '-Makensis', compiler.path, '-SevenZip', sevenZip], {
  env: { ...process.env, ...compiler.env }, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
if (result.signal !== null || result.status !== 0) throw new Error(`Upgrade safety smoke failed: ${result.signal ?? result.status}`)
