/** Bounded local process visibility before the first workspace-store migration.
 * @module @deepseek-ai/dsh-desktop-host/workspace-handoff
 */
import { readWorkspaceProcessSnapshot } from './workspace-process-snapshot.ts'
const HOST_ENTRY = /(?:^|[\\/\s"'])dsh-desktop-host[\\/]lib[\\/]index\.js(?=$|[\s"'])/iu

interface ProcessRecord { readonly pid: number; readonly command: string | null }
/** Sanitized failure; raw process arguments are never attached or logged. */
export class WorkspaceHandoffError extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid-snapshot' | 'other-host') {
    super(reason === 'other-host'
      ? 'Another Desktop Host is still running; wait for it to exit before migrating workspaces.'
      : 'Cannot verify prior Desktop Host exit; workspace migration was not published.')
    this.name = 'WorkspaceHandoffError'
  }
}

/**
 * Parse the fixed POSIX ps snapshot without retaining command arguments beyond this check.
 * @param text - Complete same-user `ps -ww -U <uid> -o pid=,command=` output.
 * @param self - Current Host PID, which must be visible in the snapshot.
 * @returns Whether another supported Desktop Host entry is present.
 */
export function otherPosixDesktopHost(text: string, self: number): boolean {
  const records: ProcessRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*([0-9]+)\s+(.+)$/u.exec(line)
    if (match === null || match[1] === undefined || match[2] === undefined || match[2].trim() === '') throw new WorkspaceHandoffError('invalid-snapshot')
    records.push({ pid: Number(match[1]), command: match[2] })
  }
  return otherHost(records, self)
}

/**
 * Parse the selected CIM process identity, interactive session and command line fields.
 * @param text - Complete JSON from the fixed local CIM query.
 * @param self - Current Host PID, which must expose a readable command line.
 * @returns Whether another supported Desktop Host entry is present.
 */
export function otherWindowsDesktopHost(text: string, self: number): boolean {
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/u, '')) }
  catch (_error) { throw new WorkspaceHandoffError('invalid-snapshot') }
  const rows: unknown[] = Array.isArray(value) ? value : [value]
  const parsed: Array<{ pid: number; command: string | null; name: string; session: number }> = []
  const pids = new Set<number>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('ProcessId' in row) || !('CommandLine' in row)
      || !('Name' in row) || !('SessionId' in row) || typeof row.Name !== 'string' || row.Name.trim() === ''
      || typeof row.SessionId !== 'number'
      || !Number.isSafeInteger(row.SessionId) || row.SessionId < 0
      || typeof row.ProcessId !== 'number' || !Number.isSafeInteger(row.ProcessId) || row.ProcessId < 0 || pids.has(row.ProcessId)
      || (typeof row.CommandLine !== 'string' && row.CommandLine !== null)) {
      throw new WorkspaceHandoffError('invalid-snapshot')
    }
    pids.add(row.ProcessId)
    parsed.push({ pid: row.ProcessId, command: row.CommandLine, name: row.Name, session: row.SessionId })
  }
  const current = parsed.find(row => row.pid === self)
  if (current === undefined || current.command === null) throw new WorkspaceHandoffError('unavailable')
  const names = new Set([current.name.toLowerCase(), 'node.exe', 'electron.exe', 'muse.exe', 'muse-med.exe'])
  const records: ProcessRecord[] = []
  for (const row of parsed) {
    if (row.session !== current.session || !names.has(row.name.toLowerCase())) continue
    if (row.command === null || row.command.trim() === '') throw new WorkspaceHandoffError('unavailable')
    records.push({ pid: row.pid, command: row.command })
  }
  return otherHost(records, self)
}

function otherHost(records: readonly ProcessRecord[], self: number): boolean {
  if (records.length === 0 || !Number.isSafeInteger(self) || self <= 0) throw new WorkspaceHandoffError('invalid-snapshot')
  const seen = new Set<number>()
  let visibleSelf = false, other = false
  for (const record of records) {
    if (!Number.isSafeInteger(record.pid) || record.pid < 0 || seen.has(record.pid)) throw new WorkspaceHandoffError('invalid-snapshot')
    seen.add(record.pid)
    if (record.pid === self) visibleSelf = record.command !== null && record.command.trim() !== ''
    else if (record.command !== null && HOST_ENTRY.test(record.command)) other = true
  }
  if (!visibleSelf) throw new WorkspaceHandoffError('unavailable')
  return other
}

/**
 * Refuse first migration while another supported Desktop Host can still drain the old store.
 * The supported application entry is dsh-desktop-host/lib/index.js. The Desktop parent
 * single-instance protocol prevents another normal parent startup after this scan.
 * Manual non-Desktop writers and cross-user or cross-interactive-session home sharing are unsupported.
 * @param timeoutMs - Positive bounded process-query deadline resolved by the owning plugin.
 * @returns After a complete local process snapshot shows no other supported Host.
 */
export async function assertWorkspaceMigrationHandoff(timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new WorkspaceHandoffError('unavailable')
  let snapshot
  try { snapshot = await readWorkspaceProcessSnapshot(timeoutMs) }
  catch (_error) {
    // Exec failures may contain captured command lines. Keep only a sanitized cause.
    throw new WorkspaceHandoffError('unavailable')
  }
  if (snapshot.stderr.trim() !== '') throw new WorkspaceHandoffError('unavailable')
  const other = snapshot.platform === 'win32'
    ? otherWindowsDesktopHost(snapshot.stdout, process.pid) : otherPosixDesktopHost(snapshot.stdout, process.pid)
  if (other) throw new WorkspaceHandoffError('other-host')
}
