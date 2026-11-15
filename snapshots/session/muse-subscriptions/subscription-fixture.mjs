/** Exercise the current subscription image tool with an isolated empty account store. */
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const sourceRoot = new URL('../../../third_party/plugins/dsh-plugin-subscriptions/', import.meta.url)
const artifactDirectory = process.env.MUSE_SUBSCRIPTIONS_ARTIFACT_DIR
  ?? fileURLToPath(new URL('../../../.artifacts/subscriptions-snapshot-artifact/package', import.meta.url))
if (!isAbsolute(artifactDirectory)) {
  throw new Error('Subscriptions snapshot artifact directory must be absolute')
}
const artifactEntry = name => pathToFileURL(join(artifactDirectory, 'lib', name))
const { createImageGenerateTool } = await importSnapshotModule(
  new URL('src/tools/image-generate.ts', sourceRoot), artifactEntry('muse-image-tool.js'))
const { AccountTokenManager } = await importSnapshotModule(
  new URL('src/providers/accounts.ts', sourceRoot), artifactEntry('muse-accounts.js'))

/** Isolated subscription replay contribution. */
export const name = 'snapshot-subscriptions'
/** Real host image and tool services from the shipped profile. */
export const inject = ['attachments', 'tools']

/**
 * Mount the upstream image tool and token manager without opening a credential file.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot process context.
 * @returns {void}
 */
export function apply(ctx) {
  const codexTokens = new AccountTokenManager({
    provider: 'codex',
    displayName: 'ChatGPT (Codex)',
    io: {
      list: async () => [],
      get: async () => undefined,
      save: async () => assert.fail('A disconnected subscription must not save credentials'),
      remove: async () => assert.fail('A disconnected subscription must not remove credentials'),
    },
    makeOptions: () => assert.fail('A disconnected subscription must not initialize refresh hooks'),
  })
  ctx.effect(() => ctx.tools.register(createImageGenerateTool({
    codexTokens,
    resolveAttachments: () => ctx.attachments,
    fetchFn: () => assert.fail('A disconnected subscription must not contact a provider'),
  })), 'subscriptions snapshot: current image tool')
}
