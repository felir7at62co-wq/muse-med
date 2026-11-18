/** Build the patched Muse studio for an explicit URL base and verify its published resources. */
import { copyFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [source, flag, base, ...extra] = process.argv.slice(2)
if (!source || flag !== '--base' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/u.test(base ?? '') || extra.length) {
  throw new Error('Usage: node build-web.mjs <patched-checkout> --base / or --base /studio/')
}
const frontend = resolve(source, 'frontweb')
const vite = join(frontend, 'node_modules/vite/bin/vite.js')
const parser = createRequire(pathToFileURL(join(frontend, 'node_modules/vite/package.json'))).resolve('rollup/parseAst')
mkdirSync(join(frontend, 'public'), { recursive: true })
copyFileSync(new URL('./assets/favicon.svg', import.meta.url), join(frontend, 'public/favicon.svg'))
const built = spawnSync(process.execPath, [vite, 'build', '--base', base], { cwd: frontend, stdio: 'inherit' })
if (built.error) throw built.error
if (built.status !== 0 || built.signal) throw new Error('Muse studio build did not finish successfully')
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const verified = spawnSync(python, [fileURLToPath(new URL('./verify-web-build.py', import.meta.url)),
  join(frontend, 'dist'), '--base', base, '--parser-module', parser], { stdio: 'inherit' })
if (verified.error) throw verified.error
if (verified.status !== 0 || verified.signal) throw new Error('Muse studio artifact verification failed')
