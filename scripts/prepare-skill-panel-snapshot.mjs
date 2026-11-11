/** Build the pinned Skill/MCP panel before plain-Node Session snapshot replay. */
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = join(repository, '.artifacts')
const directory = join(artifacts, 'skill-panel-snapshot-artifact')
mkdirSync(directory, { recursive: true })
const withinArtifacts = relative(realpathSync(artifacts), realpathSync(directory))
if (lstatSync(directory).isSymbolicLink() || isAbsolute(withinArtifacts)
  || withinArtifacts === '..' || withinArtifacts.startsWith('..' + sep)) {
  throw new Error('Skill panel snapshot output must remain inside repository artifacts')
}
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
const result = spawnSync(process.execPath, [pnpm, '--dir', 'third_party/plugins/toolchain', 'run', 'build',
  '--only', 'dsh-skill-mcp-panel', '--out', directory], { cwd: repository, env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Skill panel snapshot: build failed (${String(result.status ?? result.signal)})`)
const target = resolve(directory, 'package')
if (relative(realpathSync(directory), target) !== 'package') throw new Error('Unexpected Skill panel extraction target')
rmSync(target, { recursive: true, force: true })
await x({ file: join(directory, 'dsh-skill-mcp-panel-2.3.5.tgz'), cwd: directory })
