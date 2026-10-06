/** Optional workspace credentials shared by Jubian tool plugins. */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { JubianClient, type JubianClientOptions } from './client.ts'

/**
 * Read a pipeline token from the nearest readable workspace secret file.
 * @param start - Directory whose ancestors are searched, up to twelve levels.
 * @returns Admin token, legacy token, or an empty string; credentials stay local.
 */
export async function workspacePipelineToken(start: string): Promise<string> {
  let directory = resolve(start)
  for (let hop = 0; hop < 12; hop += 1) {
    let text: string | undefined
    try { text = await readFile(join(directory, '.agents', 'secrets', 'pipeline.env'), 'utf8') }
    catch (_error) { /* Unreadable optional workspace files permit ancestor lookup. */ }
    if (text !== undefined) {
      const values = new Map<string, string>()
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        if (match?.[1] !== undefined && match[2] !== undefined) {
          values.set(match[1], match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
        }
      }
      return values.get('JUBIANAI_ADMIN_TOKEN') || values.get('JUBIANAI_TOKEN') || ''
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ''
}

/**
 * Create a transport that prefers the credential store over optional workspace secrets.
 * @param options - Transport settings, including the store's credential resolver.
 * @param workspace - Whether to search workspace secrets when the store has no usable value.
 * @param directory - Starting workspace directory for the optional lookup.
 * @returns Transport whose credential resolver never publishes tokens.
 */
export function workspaceJubianClient(options: JubianClientOptions, workspace: boolean, directory: string): JubianClient {
  return new JubianClient({ ...options, credential: async () => {
    const stored = await options.credential()
    if (stored.trim() || !workspace) return stored
    return workspacePipelineToken(directory)
  } })
}
