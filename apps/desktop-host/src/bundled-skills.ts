/** Filesystem paths passed to Python must not depend on Electron's ASAR filesystem. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate bundled skills for the controlled Desktop runtime installation.
 * @param runtimeDir - Runtime root supplied by the Desktop launcher.
 * @returns The native filesystem directory usable by external processes.
 * @throws When the bundled skills directory is missing.
 */
export function bundledSkillDirectory(runtimeDir: string): string {
  const path = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills')
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  if (!existsSync(path)) throw new Error(`muse-med: bundled skills are missing at ${path}`)
  return path
}
