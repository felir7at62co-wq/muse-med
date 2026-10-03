/** Bind retained Codex provider source to the Host's reviewed pi-ai release in private staging. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Exact pi-ai dependency exercised by the staged provider and Host adapter checks. */
export const codexPiAiVersion = '0.87.1'

/**
 * Update the copied provider's runtime admission and peer declaration together.
 * @param {string} directory - Private copied source root, never the retained snapshot.
 * @returns {void}
 */
export function applyCodexPiAiCompatibility(directory) {
  const runtimePath = join(directory, 'src/pi-ai-runtime.js')
  const runtime = readFileSync(runtimePath)
  if (createHash('sha256').update(runtime).digest('hex') !== '2978776651688f666e0048b13fff9c3ad246c83449b51ebed37784e7b6980293') {
    throw new Error('community plugins: Codex pi-ai runtime requires source review')
  }
  const fixturesPath = join(directory, 'tests/plugin-integration.test.mjs')
  const fixtures = readFileSync(fixturesPath)
  if (createHash('sha256').update(fixtures).digest('hex') !== 'a8eedbd9e4a5b2fb0b7bdf97d641b6a332cf9dfc2ef39222de8af5f55f2e0656') {
    throw new Error('community plugins: Codex pi-ai catalog fixtures require source review')
  }
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.peerDependencies['@earendil-works/pi-ai'] = codexPiAiVersion
  writeFileSync(runtimePath, runtime.toString('utf8').replace(
    "Object.freeze(['0.82.1', '0.85.1'])", `Object.freeze(['${codexPiAiVersion}'])`,
  ))
  writeFileSync(fixturesPath, fixtures.toString('utf8')
    .replace('CONTEXT_MODE_CUSTOM, customContextGpt54Mini: 400_000, customContextGpt55: 500_000',
      'CONTEXT_MODE_CUSTOM, customContextGpt56: 400_000, customContextGpt55: 500_000')
    .replace("resolveModel('openai-codex', 'gpt-5.4-mini')).context.contextWindow, 400_000",
      "resolveModel('openai-codex', 'gpt-5.6-luna')).context.contextWindow, 400_000")
    .replace(`assert.partialDeepStrictEqual(activeContextModels, [
    { key: 'gpt-5.4', label: 'GPT-5.4', maximum: 1_000_000 },
    { key: 'gpt-5.4-mini', label: 'GPT-5.4 mini', maximum: 400_000 },
    { key: 'gpt-5.5', label: 'GPT-5.5', maximum: 1_000_000 },
    { key: 'gpt-5.6', label: 'GPT-5.6 Luna / Sol / Terra', maximum: 1_000_000 },
  ])`, `assert.deepEqual(activeContextModels, [
    { key: 'gpt-5.5', label: 'GPT-5.5', maximum: 1_000_000 },
    { key: 'gpt-5.6', label: 'GPT-5.6 Luna / Sol / Terra', maximum: 1_000_000 },
    { key: 'gpt-6-astra', label: 'GPT-6 Astra', maximum: 872_000 },
    { key: 'gpt-6-luna', label: 'GPT-6 Luna', maximum: 272_000, default: 272_000 },
    { key: 'gpt-6-sol', label: 'GPT-6 Sol', maximum: 272_000, default: 272_000 },
  ])`)
    .replace("assert.partialDeepStrictEqual(verbosityModels, ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])",
      "assert.deepEqual(verbosityModels, ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'])"))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
