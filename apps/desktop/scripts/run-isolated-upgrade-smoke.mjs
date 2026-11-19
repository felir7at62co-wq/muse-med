/** Run NSIS directory and path guards in uniquely allocated temporary directories on Windows CI. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directoryInstallerInit } from './windows-directory-installer.mjs'

if (process.platform !== 'win32') throw new Error('Upgrade safety smoke requires Windows')
const require = createRequire(import.meta.url)
require('app-builder-lib')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js')
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const compiler = await getMakeNsisPath()
const sevenZip = await getPath7za()
// Execute the real pinned initialization prefix without loading the product UI.
// The old prefix is a negative control: it creates the selected directory early.
const scratch = await mkdtemp(join(tmpdir(), 'muse-init-smoke-'))
try {
  const upstream = await readFile(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/installer.nsi'), 'utf8')
  for (const [name, text, expected] of [['fixed', directoryInstallerInit(upstream), 0], ['negative', upstream.replaceAll('\r\n', '\n'), 2]]) {
    const start = text.indexOf('Function .onInit\n')
    const end = text.indexOf('  \u0024{LogSet} on', start)
    if (start < 0 || end < start) throw new Error('Pinned installer initialization boundary changed')
    const source = join(scratch, `${name}.nsi`)
    const executable = join(scratch, `${name}.exe`)
    await writeFile(source, `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Muse initialization probe"
OutFile "${executable}"
InstallDir "${join(scratch, `${name}-target`)}"
Function setInstallSectionSpaceRequired
FunctionEnd
${text.slice(start, end)}
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  StrCmp $0 -1 +3
    SetErrorLevel 2
    Quit
  StrCmp $OUTDIR $PLUGINSDIR +3
    SetErrorLevel 3
    Quit
FunctionEnd
Section
  SetErrorLevel 0
SectionEnd
`)
    for (const [command, args, exit] of [[compiler.path, ['/V2', '/WX', source], 0], [executable, ['/S'], expected]]) {
      const probe = spawnSync(command, args, { env: { ...process.env, ...compiler.env }, stdio: 'inherit', windowsHide: true, timeout: 30000 })
      if (probe.error) throw probe.error
      if (probe.signal !== null || probe.status !== exit) throw new Error(`Installer initialization ${name} failed: ${probe.signal ?? probe.status}, expected ${exit}`)
    }
  }
} finally {
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !scratch.includes('muse-init-smoke-')) throw new Error('Unsafe initialization probe cleanup path')
  await rm(scratch, { recursive: true, force: true })
}
const script = fileURLToPath(new URL('./smoke-installer-directories.ps1', import.meta.url))
const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script,
  '-Makensis', compiler.path, '-SevenZip', sevenZip], {
  env: { ...process.env, ...compiler.env }, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
if (result.signal !== null || result.status !== 0) throw new Error(`Upgrade safety smoke failed: ${result.signal ?? result.status}`)
