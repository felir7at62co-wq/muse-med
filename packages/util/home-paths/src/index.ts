/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { existsSync } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name for the default Muse home under the OS home. */
export const MUSE_HOME_DIR_NAME = '.muse'

/** Stable user-facing display form for the default Muse home. */
export const DEFAULT_MUSE_HOME_DISPLAY = `~/${MUSE_HOME_DIR_NAME}`

/** Environment variable that overrides the default Muse home; it outranks {@link DSH_HOME_ENV}. */
export const MUSE_HOME_ENV = 'MUSE_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 *
 * This is the legacy default: {@link resolveDshHome} selects it only while that
 * home already exists and the Muse default does not.
 * @returns the absolute default DeepSeek Harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Resolve the default Muse home using Node's platform path rules.
 * @returns the absolute default Muse home path.
 */
export function defaultMuseHome(): string {
  return join(homedir(), MUSE_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root harness home.
 *
 * Precedence, highest first: an explicit configured path, `$MUSE_HOME`,
 * `$DSH_HOME`, then the default. `$MUSE_HOME` outranks `$DSH_HOME`, so a
 * deployment that sets both resolves to the Muse home with no ambiguity. An
 * empty or whitespace-only override is treated as unset, so a blank value never
 * resolves the home to the current working directory.
 *
 * The default is `~/.muse`. One compatibility rule qualifies it, and it is a
 * contract rather than an oversight: while the legacy `~/.dsh` home exists and
 * `~/.muse` does not, the legacy home keeps winning, so an existing
 * installation's sessions, settings, and stored data are never stranded on a
 * home it stopped reading. Only a machine with no legacy home starts on
 * `~/.muse`. `$DSH_HOME` itself is never renamed or withdrawn.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `MUSE_HOME` and `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const selected = configured
    ?? envPath(env, MUSE_HOME_ENV)
    ?? envPath(env, DSH_HOME_ENV)
    ?? defaultHarnessHome()
  return resolve(expandHomePath(selected))
}

/**
 * Resolve the Muse home that owns the muse-named user locations.
 *
 * Precedence, highest first: an explicit configured path, `$MUSE_HOME`, then
 * `~/.muse`. This default never follows a legacy `~/.dsh`: the muse-named
 * locations sit beside the harness home and stay at the Muse location while an
 * existing installation keeps reading `$DSH_HOME`.
 * @param configured - explicit Muse-home override, which has highest precedence.
 * @param env - environment mapping used to read `MUSE_HOME`.
 * @returns the normalized absolute Muse home path.
 */
export function resolveMuseHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolve(expandHomePath(configured ?? envPath(env, MUSE_HOME_ENV) ?? defaultMuseHome()))
}

/**
 * Read one environment override, treating a blank value as unset.
 * @param env - environment mapping to read.
 * @param key - environment variable name.
 * @returns the configured value, or `undefined` when unset or blank.
 */
function envPath(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * Select the default harness home for a machine with no override.
 *
 * An existing legacy `~/.dsh` wins while `~/.muse` does not exist; see
 * {@link resolveDshHome} for why that asymmetry is required.
 * @returns the absolute default harness home path.
 */
function defaultHarnessHome(): string {
  const legacy = defaultDshHome()
  return existsSync(legacy) && !existsSync(defaultMuseHome()) ? legacy : defaultMuseHome()
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: either default home is labelled
 * `~/.muse` or `~/.dsh`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.muse` or `~/.dsh` for a default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  if (resolvedHome === resolve(defaultMuseHome())) return DEFAULT_MUSE_HOME_DISPLAY
  return resolvedHome === resolve(defaultDshHome()) ? DEFAULT_DSH_HOME_DISPLAY : `$${DSH_HOME_ENV}`
}
