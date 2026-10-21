/** Record the restored subscription tool's unconnected-account result without contacting a provider. */
import assert from 'node:assert/strict'
import { createCodexImageTool } from '../../../third_party/plugins/dsh-codex-subscription/src/codex-images.js'
import { DshOAuthCredentialStore } from '../../../third_party/plugins/dsh-codex-subscription/src/credential-store.js'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { credentialRef } = await importSnapshotPackage('@deepseek-ai/dsh-credentials',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

/** Isolated subscription replay contribution. */
export const name = 'snapshot-codex-subscription'
/** Real host credential, image and tool services from the shipped profile. */
export const inject = ['credentials', 'attachments', 'tools', 'sessions']

/**
 * Mount the unchanged upstream image tool with an isolated empty credential reference.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot process context.
 * @returns {void}
 */
export function apply(ctx) {
  const store = new DshOAuthCredentialStore(ctx.credentials, credentialRef('SNAPSHOT_CODEX_SUBSCRIPTION_OAUTH'))
  ctx.effect(() => ctx.tools.register(createCodexImageTool({
    getFeatures: () => ({}),
    readCredential: options => store.read('openai-codex', options),
    getAuth: async options => {
      assert.equal(await store.read('openai-codex', options), undefined)
      return undefined
    },
    getSessionMessages: sessionId => ctx.sessions.get(sessionId)?.deriveMessages() ?? [],
    attachments: ctx.attachments,
    fetch: () => { throw new Error('The unconnected subscription must not contact a provider') },
  })))
}
