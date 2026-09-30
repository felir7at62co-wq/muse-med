/** Atomic replacement of local prepared JSON files. */
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Replace a JSON file through a unique temporary file in the same directory.
 * @param path - Destination file, including its owning directory.
 * @param value - JSON-serializable contents.
 * @returns Completion after the replacement is visible.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
