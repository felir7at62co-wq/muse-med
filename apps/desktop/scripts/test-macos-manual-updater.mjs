/** Qualify actual Electron DMG download and verification without replacing or starting an installed Muse. */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

if (process.platform !== 'darwin') throw new Error('Manual DMG updater qualification requires macOS')
const execute = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'muse-manual-update-live-'))
const electron = process.env.DSH_DESKTOP_TEST_ELECTRON
  ?? join(desktopTargetBuildPaths(process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64').electron, 'Electron.app', 'Contents', 'MacOS', 'Electron')
let child
let timedOut = false
try {
  const payload = join(root, 'payload')
  const application = join(payload, 'muse-med.app')
  const contents = join(application, 'Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(join(contents, 'Resources'))
  const source = join(root, 'native.c')
  await writeFile(source, 'int main(void) { return 0; }\n')
  await execute('/usr/bin/clang', ['-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', source,
    '-o', join(contents, 'MacOS', 'muse-med')])
  await writeFile(join(contents, 'Resources', 'release.txt'), 'qualified release\n')
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.muse.med</string><key>CFBundleExecutable</key><string>muse-med</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.4</string><key>CFBundleVersion</key><string>1.0.4</string></dict></plist>\n`)
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', application])
  await execute('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-format', 'UDZO', '-fs', 'HFS+', '-volname', 'Muse Verification', join(root, 'valid.dmg')])
  await writeFile(join(contents, 'Resources', 'release.txt'), 'modified resource\n')
  await execute('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-format', 'UDZO', '-fs', 'HFS+', '-volname', 'Muse Verification', join(root, 'invalid.dmg')])
  await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'certificate.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
  child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/macos-manual-updater.mjs', import.meta.url))], {
    env: { ...environment, DSH_MACOS_MANUAL_UPDATE_ROOT: root }, stdio: 'inherit',
  })
  const timeout = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    if (timedOut || result.code !== 0 || result.signal !== null) throw new Error(`Manual DMG updater qualification failed: timeout=${timedOut} exit=${result.code} signal=${result.signal}`)
    const evidenceRoot = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
    await mkdir(evidenceRoot, { recursive: true })
    const evidence = await mkdtemp(join(evidenceRoot, 'macos-manual-updater-'))
    await copyFile(join(root, 'result.json'), join(evidence, 'result.json'))
    if (!JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8')).pass) throw new Error('Manual updater did not report acceptance')
    console.log(`Manual macOS updater evidence: ${evidence}`)
  } finally { clearTimeout(timeout) }
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill()
    await new Promise(resolve => child.once('close', resolve))
  }
  await rm(root, { recursive: true, force: true })
}
