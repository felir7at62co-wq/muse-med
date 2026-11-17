/** Build the reviewed Deep View plugin and unpack it where the muse-session-views replay installs it. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
const archives = join(repository, '.artifacts/snapshot-community')
const unpacked = join(repository, '.artifacts/snapshot-deep-view')
for (const directory of [archives, unpacked]) {
  mkdirSync(directory, { recursive: true })
  const path = relative(repository, realpathSync(directory))
  assert.ok(path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path),
    'Deep View snapshot output must stay inside the repository')
}
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
const result = spawnSync(process.execPath, [pnpm, '--dir', 'third_party/plugins/toolchain', 'run', 'build', '--only', 'deep-view', '--out', archives],
  { cwd: repository, env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
assert.equal(result.status, 0, `Deep View snapshot preparation failed (${String(result.status ?? result.signal)})`)
const pin = JSON.parse(readFileSync(join(repository, 'third_party/plugins/sources.json'), 'utf8'))['deep-view']
const packageDirectory = join(unpacked, 'package')
rmSync(packageDirectory, { recursive: true, force: true })
await x({ file: join(archives, `deep-view-${pin.version}.tgz`), cwd: unpacked })
const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'deep-view')
assert.equal(manifest.version, pin.version)
assert.ok(lstatSync(join(packageDirectory, 'package.json')).isFile())
