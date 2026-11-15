/** Refuse release records when the active packaged PI-AI stream parser lost its source patch. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'

const MODULE_PATH = ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js']

/**
 * Locate the patched dependency installed for the source adapter workspace.
 * @returns {string} Module read by the source PI-AI adapter after the locked pnpm install.
 */
export function sourcePiAiCompletionsModule() {
  return resolve(import.meta.dirname, '../../../packages/llm/llm-pi-ai', ...MODULE_PATH)
}

/**
 * Locate the assembled application whose bytes will enter one unsigned release.
 * @param {'mac-arm64' | 'win-x64'} target Native Muse release target.
 * @param {string} artifactsRoot Target-owned unsigned artifact directory.
 * @returns {string} Actual assembled application ASAR path.
 */
export function packagedPiAiArchive(target, artifactsRoot) {
  if (target === 'mac-arm64') return join(artifactsRoot, 'mac-arm64', 'muse-med.app', 'Contents', 'Resources', 'app.asar')
  if (target === 'win-x64') return join(artifactsRoot, 'win-unpacked', 'resources', 'app.asar')
  throw new Error('Muse packaged PI-AI: unsupported release target')
}

/**
 * Compare the active ASAR module with the patched module used by source tests.
 * @param {string} archive Actual assembled application ASAR, including its unpacked sibling when present.
 * @param {string} sourceModule Installed source module; omission selects the adapter workspace dependency.
 * @returns {Promise<{module: string, sha256: string}>} Verified module identity; absent or different bytes throw.
 */
export async function verifyPackagedPiAiPatch(archive, sourceModule = sourcePiAiCompletionsModule()) {
  const filesystem = await readAsar(archive)
  const module = join('dsh', ...MODULE_PATH)
  const [source, packaged] = await Promise.all([readFile(sourceModule), filesystem.readFile(module)])
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const expected = digest(source), actual = digest(packaged)
  if (actual !== expected) {
    throw new Error(`Muse packaged PI-AI: active module differs from the patched source dependency (expected ${expected}, received ${actual})`)
  }
  return { module, sha256: actual }
}
