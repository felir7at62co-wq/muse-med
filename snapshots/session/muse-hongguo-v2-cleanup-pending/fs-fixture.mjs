/** Deterministic isolated staging and one failed cleanup for this keyless session. */
import * as actual from 'node:fs/promises'
import { basename } from 'node:path'
export * from 'node:fs/promises'
let ordinal = 0, failed = false
export async function mkdtemp(prefix, options) {
  if (!String(prefix).endsWith('.muse-v2-')) return await actual.mkdtemp(prefix, options)
  const path = String(prefix) + 'snapshot-' + ++ordinal
  await actual.mkdir(path, { mode: 0o700 })
  return path
}
export async function rm(path, options) {
  if (!failed && basename(String(path)) === 'episode.part') {
    failed = true
    throw Object.assign(new Error('synthetic cleanup denial'), { code: 'EACCES' })
  }
  return await actual.rm(path, options)
}
