/** Content-derived versions for explicitly selected recorded-session workspace files. */

import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'

/**
 * Exact paths and byte budget resolved by the real filesystem provider.
 * @typedef {object} Config
 * @property {string[]} files - Scenario-owned paths resolved in the provider's workspace.
 * @property {number} [maxBytes] - Maximum bytes hashed per owned file; defaults to 1024.
 * @property {string[]} [reportFiles] - Owned JSON reports whose script, assets_manifest and written paths use a portable workspace prefix.
 */

/** Required, scenario-owned paths; other targets retain the provider's versions. */
export const Config = z.object({ files: z.array(z.string()), maxBytes: z.number().default(1024), reportFiles: z.array(z.string()).default([]) })
export const name = 'read-snapshot-version'
export const inject = ['fs']

const reportSchema = z.object({ script: z.string().required(), assets_manifest: z.string().required(), written: z.array(z.string()).required() })

/**
 * Project only the report's declared path fields; business text remains exact.
 * @param {Uint8Array} bytes - Complete bounded report bytes.
 * @param {string} root - Canonical provider workspace path.
 * @returns {Uint8Array} JSON bytes with a portable prefix in the three path fields.
 */
function reportBytes(bytes, root) {
  const report = reportSchema(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  const prefix = root.replaceAll('\\', '/')
  /** @param {string} value - One declared path. @returns {string} Its portable path or unchanged external path. */
  const portable = value => {
    const path = value.replaceAll('\\', '/')
    if (path === prefix || path.startsWith(`${prefix}/`)) return `{{cwd}}${path.slice(prefix.length)}`
    return path === '{{cwd}}' || path.startsWith('{{cwd}}/') ? path : value
  }
  return new TextEncoder().encode(JSON.stringify({ ...report, script: portable(report.script),
    assets_manifest: portable(report.assets_manifest), written: report.written.map(portable) }))
}

/**
 * Derive versions from file contents while retaining native guarded mutations.
 * @param {import('@deepseek-ai/cordis').Context} ctx - scenario context with the shipped filesystem provider.
 * @param {Config} config - exact workspace files whose versions must be portable, with resolved defaults.
 * @returns {Promise<void>} when the scenario-owned version effect is installed.
 */
export async function apply(ctx, config) {
  const fs = ctx.fs
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) {
    throw new Error('read-snapshot-version: maxBytes must be a positive safe integer')
  }
  const seeds = new Set((await Promise.all(config.files.map(path => fs.resolve(path)))).map(target => target.targetKey))
  const reports = new Set((await Promise.all((config.reportFiles ?? []).map(path => fs.resolve(path)))).map(target => target.targetKey))
  if ([...reports].some(path => !seeds.has(path))) throw new Error('read-snapshot-version: reportFiles must also be listed in files')
  const root = (await fs.resolve('.')).targetKey
  ctx.effect(() => {
    const original = fs.stat.bind(fs)
    const write = fs.writeText.bind(fs), edit = fs.editText.bind(fs)
    /** @type {Map<string, { native: import('@deepseek-ai/dsh-fs').FsVersion, rawSha256: string, invalid: boolean }>} */
    const observed = new Map()
    const key = (target, version) => `${target.targetKey}\0${version}`
    // Mutations keep the provider's atomic check against the exact observed native version.
    const nativeGuard = (target, expected) => {
      if (!seeds.has(target.targetKey) || !expected || !('version' in expected)
        || !expected.version.startsWith('fixture-sha256:')) return expected
      const observation = observed.get(key(target, expected.version))
      if (observation === undefined || observation.invalid) throw new FsError('fixture version was not observed or its raw bytes changed', 'FS_STALE_VERSION')
      return { ...expected, version: observation.native }
    }
    fs.stat = async (target, signal) => {
      const info = await original(target, signal)
      if (info?.type !== 'file' || !seeds.has(target.targetKey)) return info
      const bytes = await fs.readBytes(target, signal, config.maxBytes)
      const current = await original(target, signal)
      if (current?.version !== info.version) throw new FsError('file changed during fixture version read', 'FS_STALE_VERSION')
      const content = reports.has(target.targetKey) ? reportBytes(bytes, root) : bytes
      const version = FsVersion(`fixture-sha256:${createHash('sha256').update(content).digest('hex')}`)
      const rawSha256 = createHash('sha256').update(bytes).digest('hex')
      const observationKey = key(target, version)
      const previous = observed.get(observationKey)
      if (previous && (previous.invalid || previous.rawSha256 !== rawSha256)) {
        previous.invalid = true
        throw new FsError('different raw report bytes share a fixture version; restart the scenario', 'FS_STALE_VERSION')
      }
      observed.set(observationKey, { native: info.version, rawSha256, invalid: false })
      return { ...info, version }
    }
    fs.writeText = async (target, content, expected, signal, policy) => write(target, content, nativeGuard(target, expected), signal, policy)
    fs.editText = async (target, change, expected, signal, policy) => edit(target, change, nativeGuard(target, expected), signal, policy)
    return () => {
      fs.stat = original
      fs.writeText = write
      fs.editText = edit
      observed.clear()
    }
  }, 'read-snapshot-version.stat')
}
