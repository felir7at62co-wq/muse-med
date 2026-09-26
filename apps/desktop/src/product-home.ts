import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Home directory this product named before the rename to `~/.muse`. */
const LEGACY_HOME_DIR_NAME = '.muse-med'
/** Home directory the packaged product names today. */
const HOME_DIR_NAME = '.muse'

/**
 * Resolve the packaged product home below a user directory.
 *
 * `~/.muse` is the current home. A machine that still has the pre-rename
 * `~/.muse-med` and no `~/.muse` keeps using the legacy directory, so installing
 * a build that names the new home never strands the sessions, settings, and
 * credentials an existing installation left behind. A machine with neither, or
 * with both, uses `~/.muse`; `MUSE_MED_HOME` still overrides the result.
 * @param userHome - operating-system user home directory.
 * @returns the absolute packaged product home path.
 */
export function productHomeFor(userHome: string): string {
  const current = join(userHome, HOME_DIR_NAME)
  if (existsSync(current)) return current
  const legacy = join(userHome, LEGACY_HOME_DIR_NAME)
  return existsSync(legacy) ? legacy : current
}
