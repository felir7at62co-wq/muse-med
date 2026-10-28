/** Qualify the native Muse Bot workspace for the application's controlled runtime. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** Source pin and deployment choices recorded in the packaged artifact. */
export const museBotDesktopCompatibility = Object.freeze({
  upstreamCommit: 'de55888a93983fc51c94f7d22bc94b4f8293205d',
  brand: 'Muse Bot',
  agentPreset: 'short-drama', mainAgentPreset: 'bot-coordinator',
  contextManagement: 'host',
  goals: 'host',
  memoryReview: false,
  autoSessionBots: true,
  sessionBotSyncIntervalMs: 30000,
  updateCheck: false,
  github: false,
  webSearch: 'Muse profile unchanged; upstream search bundle omitted',
  runtime: 'native Cordis plugin in the existing Muse Host',
})

/**
 * Remove the retired search dependency and require Muse's single native composition.
 * @param {string} directory Private staging directory holding the copied plugin.
 * @returns {void} Writes the qualified manifest in staging only.
 */
export function applyMuseBotDesktopCompatibility(directory) {
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'ds-bot' || manifest.version !== '0.2.2' || manifest.license !== 'Apache-2.0') {
    throw new Error('community plugins: Muse Bot package requires a new source review')
  }
  const patch = load(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'))
  const expected = [{ insert: [{ id: 'muse-bot', name: 'ds-bot', config: {
    agentPreset: 'short-drama', mainAgentPreset: 'bot-coordinator', contextManagement: 'host', goals: 'host', memoryReview: false,
    autoSessionBots: true, sessionBotSyncIntervalMs: 30000, github: false, updateCheck: false,
  } }] }]
  if (JSON.stringify(patch) !== JSON.stringify(expected)) {
    throw new Error('community plugins: Muse Bot composition must preserve the Muse profile services')
  }
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
    if (manifest[section]) delete manifest[section]['@deepseek-ai/dsh-web']
  }
  delete manifest.exports['./web-search']
  manifest.description = 'Muse Bot: native persistent team workspaces for Muse'
  manifest.files = [
    'index.js', 'src/host/', 'src/shared/', 'client.js', 'cordis.patch.yml',
    'README.md', 'README.zh.md', 'MUSE_SOURCE.json', 'LICENSE', 'NOTICE',
  ]
  if (!readFileSync(join(directory, 'NOTICE'), 'utf8').trim()) {
    throw new Error('community plugins: Muse Bot attribution notice is missing')
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
