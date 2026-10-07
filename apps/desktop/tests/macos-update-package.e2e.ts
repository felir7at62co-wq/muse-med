/** Real Apple tools qualify sealed DMGs and reject modified resources without starting Muse. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { verifyMacOSUpdateBytes, verifyMacOSUpdatePackage, type MacOSUpdatePackage } from '../src/macos-update-package.ts'
import { verifyMacOSAdHocSignature } from '../scripts/verify-macos-signature.mjs'

const execute = promisify(execFile)

it.runIf(process.platform === 'darwin')('verifies the exact ad-hoc application and refuses resource, identity, version and payload changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-macos-signature-e2e-'))
  const payload = join(root, 'payload')
  const application = join(payload, 'muse-med.app')
  const contents = join(application, 'Contents')
  const resource = join(contents, 'Resources', 'release.txt')
  try {
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await mkdir(join(contents, 'Resources'))
    const source = join(root, 'native.c')
    await writeFile(source, 'int main(void) { return 0; }\n')
    await execute('/usr/bin/clang', ['-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', source,
      '-o', join(contents, 'MacOS', 'muse-med')])
    await writeFile(resource, 'exact release bytes\n')
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.muse.med</string><key>CFBundleExecutable</key><string>muse-med</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.4</string><key>CFBundleVersion</key><string>1.0.4</string></dict></plist>\n`)
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', application])
    verifyMacOSAdHocSignature(application, 'cn.muse.med')
    async function image(name: string): Promise<MacOSUpdatePackage> {
      const path = join(root, `${name}.dmg`)
      await execute('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-format', 'UDZO', '-fs', 'HFS+', '-volname', 'Muse Verification', path])
      const bytes = await readFile(path)
      return { path, appId: 'cn.muse.med', version: '1.0.4', arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
    }
    const valid = await image('valid')
    await verifyMacOSUpdatePackage(valid)
    await expect(verifyMacOSUpdatePackage({ ...valid, appId: 'cn.other.app' })).rejects.toThrow('identity or version')
    await expect(verifyMacOSUpdatePackage({ ...valid, version: '1.0.5' })).rejects.toThrow('identity or version')
    await writeFile(resource, 'modified sealed resource\n')
    expect(() => { verifyMacOSAdHocSignature(application, 'cn.muse.med') }).toThrow('codesign exited')
    const changed = await image('changed-resource')
    await expect(verifyMacOSUpdatePackage(changed)).rejects.toThrow('codesign')
    await writeFile(resource, 'exact release bytes\n')
    const wrongExecutable = join(root, 'wrong-architecture')
    await execute('/usr/bin/clang', ['-arch', process.arch === 'arm64' ? 'x86_64' : 'arm64', source, '-o', wrongExecutable])
    await copyFile(wrongExecutable, join(contents, 'MacOS', 'muse-med'))
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', application])
    await expect(verifyMacOSUpdatePackage(await image('wrong-architecture'))).rejects.toThrow('lipo')
    await writeFile(valid.path, Buffer.alloc(valid.size))
    await expect(verifyMacOSUpdateBytes(valid)).rejects.toThrow('SHA-512')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
