/** Build the reviewed visualization plugin and pack its missing Client peer for private-profile replay. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t, x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
const directory = join(repository, '.artifacts/visualize-snapshot-artifact')
mkdirSync(directory, { recursive: true })
const output = realpathSync(directory)
const within = (parent, child) => {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path)
}
assert.ok(within(repository, output), 'Visualization snapshot output must stay inside the repository')
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Visualization snapshot preparation failed (${String(result.status ?? result.signal)})`)
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const hooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack']
const noLifecycle = manifest => {
  for (const hook of hooks) assert.equal(manifest.scripts?.[hook], undefined, `${manifest.name} must not run ${hook} in the snapshot profile`)
}
const packedManifest = async file => {
  let contents = '', manifests = 0
  await t({ file, onReadEntry(entry) {
    assert.ok(entry.path.startsWith('package/') && !entry.path.split('/').includes('..'), 'Packed files must stay in package/')
    assert.ok(entry.type === 'File' || entry.type === 'Directory', 'Private snapshot artifacts must contain ordinary files and directories')
    if (entry.path === 'package/package.json') {
      manifests++
      entry.on('data', bytes => { contents += bytes.toString('utf8') })
    }
  } })
  assert.equal(manifests, 1)
  const manifest = JSON.parse(contents)
  noLifecycle(manifest)
  return manifest
}

run(['--dir', 'third_party/plugins/toolchain', 'run', 'build', '--only', 'dsh-visualize', '--out', output], repository)
const pin = readJson(join(repository, 'third_party/plugins/sources.json'))['dsh-visualize']
const pluginFile = `nagi-ovo-dsh-visualize-${pin.version}.tgz`
await packedManifest(join(output, pluginFile))
const packageDirectory = join(output, 'package')
if (existsSync(packageDirectory)) {
  assert.ok(!lstatSync(packageDirectory).isSymbolicLink() && relative(output, realpathSync(packageDirectory)) === 'package',
    'Visualization snapshot package must stay inside its owned artifact directory')
  rmSync(packageDirectory, { recursive: true, force: true })
}
await x({ file: join(output, pluginFile), cwd: output })
const manifest = readJson(join(packageDirectory, 'package.json'))
assert.equal(manifest.name, '@nagi-ovo/dsh-visualize')
assert.equal(manifest.version, pin.version)
assert.deepEqual(readJson(join(packageDirectory, 'SOURCE.json')).upstream, pin)
assert.deepEqual(manifest.dependencies ?? {}, {}, 'New plugin dependencies need an explicitly reviewed private installation closure')
noLifecycle(manifest)
for (const file of ['lib/index.js', 'lib/client.js', 'src/index.ts', 'assets/visualize-skill.md', 'LICENSE', 'SOURCE.json']) {
  assert.ok(lstatSync(join(packageDirectory, file)).isFile(), `Missing visualization package file ${file}`)
}
const packages = [{ name: manifest.name, version: manifest.version, file: pluginFile, sha256: digest(join(output, pluginFile)) }]
const toolchain = join(repository, 'third_party/plugins/toolchain/package.json')
const tools = readJson(toolchain)
const queue = [{ name: 'react', anchor: toolchain }]
const visited = new Set()
for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
  if (visited.has(next.name)) continue
  visited.add(next.name)
  const path = realpathSync(createRequire(next.anchor).resolve(`${next.name}/package.json`))
  const dependency = readJson(path)
  assert.equal(dependency.name, next.name)
  if (next.name === 'react') assert.equal(dependency.version, tools.dependencies.react)
  assert.ok(within(join(repository, 'third_party/plugins/toolchain/node_modules'), path), 'Client peer must come from the pinned toolchain installation')
  noLifecycle(dependency)
  assert.equal(dependency.license, 'MIT', 'Review newly introduced Client dependency licenses')
  assert.deepEqual(dependency.optionalDependencies ?? {}, {}, 'Review newly introduced optional Client dependencies')
  assert.deepEqual(dependency.peerDependencies ?? {}, {}, 'Review newly introduced Client peer dependencies')
  const file = `${dependency.name.replace('@', '').replace('/', '-')}-${dependency.version}.tgz`
  run(['--ignore-workspace', 'pack', '--pack-destination', output], dirname(path))
  const packed = await packedManifest(join(output, file))
  // Normal pnpm packing expands the legacy repository shorthand without changing dependency declarations.
  const publishedRepository = typeof dependency.repository === 'string'
    ? { type: 'git', url: dependency.repository } : dependency.repository
  assert.deepEqual(packed, { ...dependency, repository: publishedRepository })
  packages.push({ name: dependency.name, version: dependency.version, file, sha256: digest(join(output, file)) })
  for (const name of Object.keys(dependency.dependencies ?? {})) queue.push({ name, anchor: path })
}
assert.deepEqual(packages.map(pkg => pkg.name), ['@nagi-ovo/dsh-visualize', 'react', 'loose-envify', 'js-tokens'],
  'Review any change to the private visualization package closure')
writeFileSync(join(output, 'installation.json'), JSON.stringify({
  packages, toolchainLockSha256: digest(join(dirname(toolchain), 'pnpm-lock.yaml')),
}, null, 2) + '\n')
