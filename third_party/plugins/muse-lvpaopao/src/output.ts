/** Session-owned output authorization, checked again before local mutations. */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { BridgeError } from './port.ts'

/** Resolved file permission for the initiating Session; absence permits only its workspace. */
export interface OutputPolicy { readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access' }
/** Captured output location and checks; no directory is created during authorization. */
export interface OutputDirectory {
  readonly path: string
  /** Verify captured directory identities and every existing child. */
  check(): Promise<void>
  /** Create missing children only after revalidating the authorized anchor. */
  create(): Promise<void>
}
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

/**
 * Resolve an initiating Session's destination before media acquisition or mkdir.
 * @param session - Exact initiating Session, whose cwd owns relative destinations.
 * @param value - Optional model-selected destination; external paths must be absolute.
 * @param policy - Current Session file access, resolved by the sandbox-policy service.
 * @returns Authorized absolute path and identity-preserving mutation checks.
 */
export async function authorizeOutput(session: Session, value?: string, policy?: OutputPolicy): Promise<OutputDirectory> {
  const workspace = session.header.cwd
  if (!workspace || !isAbsolute(workspace)) throw new BridgeError('download-workspace-missing')
  if (policy?.mode === 'read-only') throw new BridgeError('download-access-denied')
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value))) throw new BridgeError('download-output-invalid')
  const root = await realpath(workspace)
  const requested = value ?? join('downloads', 'lvpaopao')
  const absolute = resolve(isAbsolute(requested) ? workspace : root, requested)
  const target = inside(workspace, absolute) ? resolve(root, relative(workspace, absolute)) : absolute
  if (!isAbsolute(requested) && !inside(root, target)) throw new BridgeError('download-output-outside-workspace')
  if (!inside(root, target) && policy?.mode !== 'danger-full-access') throw new BridgeError('download-access-denied')
  let anchor = inside(root, target) ? root : target
  for (;;) {
    try { await lstat(anchor); break }
    catch (error) {
      if (!missing(error)) throw error
      const parent = dirname(anchor)
      if (parent === anchor) throw new BridgeError('download-output-unsafe')
      anchor = parent
    }
  }
  const identities = new Map<string, { dev: number; ino: number }>()
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(path)) !== path) throw new BridgeError('download-output-unsafe')
    const previous = identities.get(path)
    if (previous !== undefined && (previous.dev !== info.dev || previous.ino !== info.ino)) throw new BridgeError('download-output-replaced')
    identities.set(path, { dev: info.dev, ino: info.ino })
  }
  const check = async (create: boolean): Promise<void> => {
    await inspect(anchor)
    let path = anchor
    for (const component of relative(anchor, target).split(sep).filter(Boolean)) {
      path = join(path, component)
      try { await inspect(path) }
      catch (error) {
        if (!missing(error)) throw error
        if (identities.has(path)) throw new BridgeError('download-output-replaced')
        if (!create) return
        // Recheck all captured parents immediately before creating this child.
        for (const parent of identities.keys()) await inspect(parent)
        try { await mkdir(path, { mode: 0o700 }) }
        catch (failure) { if (!(failure instanceof Error) || !('code' in failure) || failure.code !== 'EEXIST') throw failure }
        await inspect(path)
      }
    }
  }
  await check(false)
  return { path: target, check: () => check(false), create: () => check(true) }
}
