/** Build the reviewed MCP panel source, including local repairs, before plain-Node snapshot replay. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
const directory = join(repository, '.artifacts/mcp-panel-snapshot-artifact')
mkdirSync(directory, { recursive: true })
const output = realpathSync(directory)
const outputRelative = relative(repository, output)
if (outputRelative.startsWith('..') || isAbsolute(outputRelative)) throw new Error('MCP panel snapshot output escaped the repository')
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
const result = spawnSync(process.execPath, [pnpm, '--dir', 'third_party/plugins/toolchain', 'run', 'build',
  '--only', 'dsh-skill-mcp-panel', '--out', output], { cwd: repository, env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`MCP panel snapshot: build failed (${String(result.status ?? result.signal)})`)

const pins = JSON.parse(readFileSync(join(repository, 'third_party/plugins/sources.json'), 'utf8'))
const pin = pins['dsh-skill-mcp-panel']
const packageDirectory = join(output, 'package')
if (existsSync(packageDirectory)) {
  if (lstatSync(packageDirectory).isSymbolicLink() || relative(output, realpathSync(packageDirectory)) !== 'package') {
    throw new Error('MCP panel snapshot package escaped its owned artifact directory')
  }
  rmSync(packageDirectory, { recursive: true, force: true })
}
await x({ file: join(output, `dsh-skill-mcp-panel-${pin.version}.tgz`), cwd: output })
const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
const receipt = JSON.parse(readFileSync(join(packageDirectory, 'SOURCE.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-skill-mcp-panel')
assert.equal(manifest.version, pin.version)
assert.deepEqual(receipt.upstream, pin)
for (const file of ['lib/index.js', 'lib/mcp/gateway.js', 'lib/oauth.js', 'lib/skill-import.js']) {
  if (!lstatSync(join(packageDirectory, file)).isFile()) throw new Error(`MCP panel snapshot: missing built ${file}`)
}
