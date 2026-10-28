/** Filesystem paths passed to Python must not depend on Electron's ASAR filesystem. */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

interface SkillDirectoryExpression { __jsExpr: string }
type SkillDirectoryConfig = Array<string | SkillDirectoryExpression> | SkillDirectoryExpression

/** Recognize serialized Loader expressions without evaluating profile code at startup. */
function isExpression(value: unknown): value is SkillDirectoryExpression {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && '__jsExpr' in value && typeof value.__jsExpr === 'string'
}

/** Validate literal or deferred directory entries at the profile parser boundary. */
function isDirectory(value: unknown): value is string | SkillDirectoryExpression {
  return isExpression(value) || typeof value === 'string' && value.trim().length > 0
}

/**
 * Retain explicit skill roots after the product and Muse user directories.
 * @param productDirectory - Product-owned native resource directory.
 * @param userDirectory - Persistent Muse user skill directory.
 * @param profileConfig - Skill filesystem configuration before the product policy overlay.
 * @returns Normalized literal directories or expressions evaluated by the Loader at activation.
 * @throws When literal configured roots are not nonempty strings or Loader expressions.
 */
export function desktopSkillDirectories(productDirectory: string, userDirectory: string, profileConfig: unknown): SkillDirectoryConfig {
  const configured = profileConfig ?? {}
  if (typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('muse-med: skill-filesystem requires an object config')
  }
  const configuredDirectories = isExpression(configured)
    ? { __jsExpr: `(${configured.__jsExpr}).customSkillDirs` }
    : 'customSkillDirs' in configured ? configured.customSkillDirs : undefined
  const required = [resolve(productDirectory), resolve(userDirectory)]
  if (isExpression(configuredDirectories)) {
    return { __jsExpr: `((dirs) => { if (dirs !== undefined && !Array.isArray(dirs)) throw new Error('muse-med: customSkillDirs must be an array'); return [...${JSON.stringify(required)}, ...(dirs ?? [])]; })((${configuredDirectories.__jsExpr}))` }
  }
  let directories: readonly (string | SkillDirectoryExpression)[] = []
  if (configuredDirectories !== undefined) {
    if (!Array.isArray(configuredDirectories) || !configuredDirectories.every(isDirectory)) {
      throw new Error('muse-med: skill-filesystem customSkillDirs must contain nonempty directory strings or Loader expressions')
    }
    directories = configuredDirectories
  }
  const result: Array<string | SkillDirectoryExpression> = []
  const seen = new Set<string>()
  for (const directory of [...required, ...directories]) {
    if (isExpression(directory)) { result.push(directory); continue }
    const normalized = resolve(directory)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}
