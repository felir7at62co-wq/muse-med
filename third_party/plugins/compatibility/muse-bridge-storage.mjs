/** Conversation listing uses the active Host's public services and current cache generation. */
import { basename } from 'node:path'

/**
 * Read archived IDs from the owning workspace service.
 * @param {object} ctx Injected Host services.
 * @returns {Set<string>} Archived session IDs.
 */
export function getArchivedSessionIds(ctx) {
  return new Set(ctx.workspaceRegistry.archivedSessionIds)
}

/**
 * Adapt identity-checked public cache values to the upstream conversation listing.
 * @param {object} ctx Injected Host services.
 * @returns {Promise<object>} Cached values indexed by session ID.
 */
export async function getSessionProjCache(ctx) {
  const headers = new Map((await ctx.sessionPersistence.list()).map(snapshot => [snapshot.header.id, snapshot.header]))
  for (const session of ctx.sessions.list()) headers.set(session.id, session.header)
  return Object.fromEntries([...headers].map(([id, header]) => {
    const values = ctx.sessionProjectionCache.cachedSnapshot(header)?.values ?? {}
    return [id, { rows: Object.fromEntries(Object.entries(values).map(([key, val]) => [key, { val }])) }]
  }))
}

/**
 * Read the active profile's registered workspaces.
 * @param {object} ctx Injected Host services.
 * @returns {Promise<object[]>} Workspace records for the upstream listing.
 */
export async function getRegisteredWorkspaces(ctx) {
  return (await ctx.workspaceRegistry.list()).map(workspace => ({
    id: workspace.id, path: workspace.path, title: workspace.title || basename(workspace.path), sessionIds: [...workspace.sessionIds],
  }))
}
