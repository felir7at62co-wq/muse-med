/** Stable allocation only inside this run's private workspace; every other operation uses real filesystem APIs. */
export * from 'node:fs/promises'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {string} prefix - Staging prefix selected by the real Fanqie client.
 * @returns Exclusively created staging directory; existing paths fail.
 */
export async function mkdtemp(prefix) {
  const root = await realpath(process.cwd())
  if (prefix !== join(root, 'novels', '.fanqie-')) {
    throw new Error('Fanqie snapshot refuses a staging path outside its private workspace')
  }
  const path = prefix + 'case01'
  await mkdir(path, { mode: 0o700 })
  return path
}
