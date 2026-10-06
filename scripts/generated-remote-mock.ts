import { join } from 'node:path'

/**
 * Resolve generated Remote exports only for their owning browser-entry mocks.
 * Unmocked imports fail; no generated artifact is supplied by the source test lane.
 * @param repositoryRoot - source root selected by the test configuration.
 * @returns a test-only Vite resolver with exact module and importer ownership.
 */
export function generatedRemoteMockPlugin(repositoryRoot: string) {
  const remoteFiles: readonly (readonly [string, readonly string[]])[] = [
    ['@deepseek-ai/dsh-muse-account/remote', [
      'packages/client/ui-muse-account/src/client/index.ts',
      'packages/client/ui-muse-account/tests/browser-plugin.client.spec.tsx',
    ]],
    ['@deepseek-ai/dsh-feishu-settings/remote', [
      'packages/host/feishu-settings/src/client/index.ts',
      'packages/host/feishu-settings/tests/browser-plugin.client.spec.tsx',
    ]],
  ]
  const remoteOwners = new Map(remoteFiles.map(([id, files]) => [id, files.map(file =>
    join(repositoryRoot, file).replaceAll('\\', '/'))]))
  const virtualPrefix = '\0dsh-owning-test-remote:'
  const virtualIds = new Set([...remoteOwners.keys()].map(id => `${virtualPrefix}${id}`))
  return {
    name: 'dsh-owning-generated-remote-mocks',
    enforce: 'pre' as const,
    resolveId(id: string, importer: string | undefined) {
      if (importer === undefined) return
      const query = importer.indexOf('?')
      const owner = (query < 0 ? importer : importer.slice(0, query)).replaceAll('\\', '/')
      if (remoteOwners.get(id)?.includes(owner)) return `${virtualPrefix}${id}`
    },
    load(id: string) {
      if (virtualIds.has(id)) return 'throw new Error("Generated Remote contribution requires an explicit owning-test mock"); export default undefined;'
    },
  }
}
