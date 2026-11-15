/** Desktop routing of Workspace data to its exclusively owned successor.
 * @module @deepseek-ai/dsh-desktop-host/workspace-storage-composition
 */
import { join } from 'node:path'
import { z } from 'zod'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const domainConfig = z.object({
  backend: z.unknown(),
  routes: z.record(z.string(), z.unknown()).optional(),
}).loose()

/**
 * Retain the configured source backend and all unrelated domain routes.
 * @param entries - Effective profile entries before the Desktop product overlay.
 * @param storageRoot - Private Desktop storage root for the successor.
 * @returns The provider insertion and Workspace-only route override.
 */
export function workspaceStorageLayer(
  entries: readonly { id?: string; config?: unknown }[], storageRoot: string,
): PatchOptions[] {
  const entry = entries.find(row => row.id === 'storage-domain')
  if (entry === undefined) throw new Error('muse-med: profile has no storage-domain row')
  const config = domainConfig.parse(entry.config)
  const sourceBackend = config.routes?.workspace ?? config.backend
  if (sourceBackend === undefined || sourceBackend === null || sourceBackend === 'muse-workspace-owned') {
    throw new Error('muse-med: Workspace migration requires the original storage backend')
  }
  return [{ insert: [{ id: 'muse-workspace-owned-storage', name: 'muse-workspace-owned-storage',
    config: { sourceBackend, root: join(storageRoot, 'workspace-owned-v1') } }] },
  { id: 'storage-domain', config: { ...config, routes: { ...config.routes, workspace: 'muse-workspace-owned' } } }]
}
