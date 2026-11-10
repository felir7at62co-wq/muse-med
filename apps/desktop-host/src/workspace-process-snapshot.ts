/** Fixed local process-enumeration commands for the first workspace handoff.
 * @module @deepseek-ai/dsh-desktop-host/workspace-process-snapshot
 */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_PROCESS_SNAPSHOT_BYTES = 8 * 1024 * 1024
/** Private-memory process snapshot; callers must not log its contents. */
export interface WorkspaceProcessSnapshot { platform: 'posix' | 'win32'; stdout: string; stderr: string }

/**
 * Execute a fixed local process query with a bounded output and deadline.
 * @param timeoutMs - Positive query deadline supplied by the owning plugin.
 * @returns same-user process IDs and command lines, or potential Hosts in the Windows interactive session, in private memory.
 */
export async function readWorkspaceProcessSnapshot(timeoutMs: number): Promise<WorkspaceProcessSnapshot> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) throw new Error('SystemRoot unavailable')
    const command = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const executable = win32.basename(process.execPath)
    if (!/^[A-Za-z0-9_. -]+$/u.test(executable)) throw new Error('unsupported process executable spelling')
    const names = [...new Set([executable.toLowerCase(), 'node.exe', 'electron.exe', 'muse.exe', 'muse-med.exe'])]
    const executableFilter = names.map(name => `Name = '${name}'`).join(' OR ')
    const query = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
      + '$session=[Diagnostics.Process]::GetCurrentProcess().SessionId;'
      + `Get-CimInstance Win32_Process -Filter "SessionId = $session AND (${executableFilter})"`
      + ' -Property Name,SessionId,ProcessId,CommandLine | Select-Object Name,SessionId,ProcessId,CommandLine | ConvertTo-Json -Compress'
    const result = await run(command, ['-NoProfile', '-NonInteractive', '-Command', query], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_PROCESS_SNAPSHOT_BYTES, windowsHide: true,
    })
    return { platform: 'win32', stdout: result.stdout, stderr: result.stderr }
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const uid = process.getuid?.()
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new Error('current user identity unavailable')
    const result = await run('/bin/ps', ['-ww', '-U', String(uid), '-o', 'pid=,command='], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_PROCESS_SNAPSHOT_BYTES,
    })
    return { platform: 'posix', stdout: result.stdout, stderr: result.stderr }
  }
  throw new Error('process enumeration unavailable')
}
