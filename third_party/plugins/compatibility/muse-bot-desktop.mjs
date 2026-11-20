/** Qualify the native Muse Bot workspace for the application's controlled runtime. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** Source pin and deployment choices recorded in the packaged artifact. */
export const museBotDesktopCompatibility = Object.freeze({
  upstreamCommit: '5e9b7da8882da3b68d8a0624342708c2150a9156',
  agentPreset: 'short-drama-v2',
  updateCheck: false,
  mainName: 'Muse',
  mainRole: '主理人',
  settings: 'DS Bot settings dialog; the host settings shell stays off',
  webSearch: 'Muse profile unchanged; upstream search bundle omitted',
  runtime: 'native Cordis plugin in the existing Muse Host',
})

/**
 * Remove the upstream search bundle and require Muse's single native composition.
 * @param {string} directory Private staging directory holding the copied plugin.
 * @returns {void} Writes the qualified manifest in staging only.
 */
export function applyMuseBotDesktopCompatibility(directory) {
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'ds-bot' || manifest.version !== '0.3.8' || manifest.license !== 'Apache-2.0') {
    throw new Error('community plugins: Muse Bot package requires a new source review')
  }
  const patch = load(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'))
  const expected = [
    { insert: [{ id: 'bot', name: 'ds-bot', config: { agentPreset: 'short-drama-v2', updateCheck: false, mainName: 'Muse', mainRole: '主理人' } }] },
    { id: 'ui-settings-general', disabled: true },
  ]
  if (JSON.stringify(patch) !== JSON.stringify(expected)) {
    throw new Error('community plugins: Muse Bot composition must preserve the Muse profile services')
  }
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
    if (manifest[section]) delete manifest[section]['@deepseek-ai/dsh-web']
  }
  delete manifest.exports['./web-search']
  delete manifest.bin
  manifest.description = 'Muse Bot: native persistent team workspaces for Muse'
  manifest.files = [
    ...manifest.files.filter(file => file !== 'web-search.js' && file !== 'bin/'),
    'MUSE_SOURCE.json', 'NOTICE',
  ]
  if (!readFileSync(join(directory, 'NOTICE'), 'utf8').trim()) {
    throw new Error('community plugins: Muse Bot attribution notice is missing')
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
