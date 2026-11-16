/** Build the pinned subscription runtime before plain-Node Session snapshot replay. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tar'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const directory = join(repository, '.artifacts/subscriptions-snapshot-artifact')
mkdirSync(directory, { recursive: true })
const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
const result = spawnSync(process.execPath, [pnpm, '--dir', 'third_party/plugins/toolchain', 'run', 'build',
  '--only', 'dsh-plugin-subscriptions', '--out', directory], { cwd: repository, env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`subscriptions snapshot: build failed (${String(result.status ?? result.signal)})`)
rmSync(join(directory, 'package'), { recursive: true, force: true })
await x({ file: join(directory, 'dsh-plugin-subscriptions-0.9.12.tgz'), cwd: directory })
