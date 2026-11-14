/** Build pinned community runtimes before plain-Node Session snapshot replay. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
for (const [name, artifact] of [
  ['dsh-plugin-subscriptions', 'subscriptions-snapshot-artifact'],
  ['dsh-skill-mcp-panel', 'skill-panel-snapshot-artifact'],
]) {
  const directory = join(repository, '.artifacts', artifact)
  mkdirSync(directory, { recursive: true })
  const result = spawnSync(process.execPath, [pnpm, '--dir', 'third_party/plugins/toolchain', 'run', 'build',
    '--only', name, '--out', directory], { cwd: repository, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${name} snapshot: build failed (${String(result.status ?? result.signal)})`)
  const manifest = JSON.parse(readFileSync(join(repository, 'third_party/plugins', name, 'package.json'), 'utf8'))
  rmSync(join(directory, 'package'), { recursive: true, force: true })
  await x({ file: join(directory, `${name}-${manifest.version}.tgz`), cwd: directory })
}
