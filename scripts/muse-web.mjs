/**
 * Start the Web GUI against the muse product home instead of the official dsh home.
 *
 * The launcher owns exactly one thing: `MUSE_HOME`. `dsh-home-paths` already prefers it
 * over `DSH_HOME`, so the CLI, the profile directory, settings, credentials, skills, and
 * the session store all resolve under one home without a second application or a change
 * to any composed default. Extra arguments are forwarded verbatim to the web app, so
 * `pnpm muse:web -- --port 327` serves on 327.
 *
 * @example
 * pnpm muse:web -- --port 327
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.MUSE_HOME ?? join(homedir(), '.muse')

// pnpm ≥11 forwards its own `--` separator verbatim; the web app must not receive it.
const forwarded = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--')
process.stdout.write(`muse-web: MUSE_HOME=${home}\n`)
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', join(ROOT, 'apps/cli/src/bin.ts'), 'web', ...forwarded],
  { cwd: ROOT, env: { ...process.env, MUSE_HOME: home }, stdio: 'inherit' },
)
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 0))
})
