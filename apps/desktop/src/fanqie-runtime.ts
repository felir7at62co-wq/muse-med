/** Shared Python selection for the current Fanqie downloader. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'

/** Select the bundled interpreter without copying retired sources or changing general Python lookup.
 * @param options - Prepared primary payload directory.
 * @returns Fanqie-specific Python entry after checking distribution metadata and its contained executable.
 */
export async function prepareDesktopFanqieEnvironment(options: { primaryRuntime: string }): Promise<NodeJS.ProcessEnv> {
  const root = await realpath(resolve(options.primaryRuntime))
  const metadata = parsePrimaryRuntime(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')))
  if (metadata.pythonPackages.pycryptodome === undefined) throw new Error('Fanqie runtime: primary Python is missing PyCryptodome')
  const python = await realpath(workspaceDependencyPaths(root, metadata).python)
  const path = relative(root, python)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || !(await lstat(python)).isFile()) {
    throw new Error('Fanqie runtime: Python executable escapes its payload or is not a regular file')
  }
  return { MUSE_FANQIE_PYTHON_PATH: python }
}
