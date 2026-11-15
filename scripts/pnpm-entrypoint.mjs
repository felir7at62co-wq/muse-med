/** Resolve the installed pnpm package's JavaScript launcher for shell-free Node children. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

/**
 * Read pnpm's declared bin, retaining its Corepack launcher when that bin is native.
 * @param {string} manifestPath - Absolute path to the installed pnpm package.json.
 * @returns {string} Existing JavaScript entry to pass after the Node executable.
 */
export function resolvePnpmEntrypoint(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pnpm
  if (manifest.name !== 'pnpm' || typeof declared !== 'string' || !declared.trim()) {
    throw new Error('pnpm entrypoint: installed package must declare its pnpm bin')
  }
  const directory = realpathSync(dirname(manifestPath))
  const withinPackage = entry => {
    const path = relative(directory, entry)
    return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
  }
  if (isAbsolute(declared) || win32.isAbsolute(declared) || !withinPackage(resolve(directory, declared))) {
    throw new Error('pnpm entrypoint: declared bin must stay inside the installed package')
  }
  // pnpm 12 declares a native bin and retains bin/pnpm.mjs for Corepack's Node invocation.
  const candidates = /\.[cm]?js$/iu.test(declared) ? [declared] : ['bin/pnpm.mjs', 'bin/pnpm.cjs']
  for (const candidate of candidates) {
    const entry = resolve(directory, candidate)
    if (!existsSync(entry)) continue
    const target = realpathSync(entry)
    if (!withinPackage(target)) throw new Error('pnpm entrypoint: JavaScript launcher must stay inside the installed package')
    return target
  }
  throw new Error('pnpm entrypoint: installed package has no JavaScript launcher; reinstall workspace dependencies')
}
