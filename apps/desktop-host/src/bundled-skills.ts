/** Filesystem paths passed to Python must not depend on Electron's ASAR filesystem. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function nativeSkillDirectory(path: string, label: string): string {
  const native = path.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  if (!existsSync(native)) throw new Error(`muse-med: ${label} skills are missing at ${native}`)
  return native
}

/**
 * Locate bundled skills for the controlled Desktop runtime installation.
 * @param runtimeDir - Runtime root supplied by the Desktop launcher.
 * @returns The native filesystem directory usable by external processes.
 * @throws When the bundled skills directory is missing.
 */
export function bundledSkillDirectory(runtimeDir: string): string {
  return nativeSkillDirectory(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills'), 'bundled')
}

/**
 * Locate product skills where external Python can read their scripts.
 * @param packageDir - Installed Desktop Host package directory.
 * @returns The native filesystem directory usable by external processes.
 * @throws When the unpacked product skills directory is missing.
 */
export function productSkillDirectory(packageDir: string): string {
  return nativeSkillDirectory(join(packageDir, 'skills'), 'product')
}
