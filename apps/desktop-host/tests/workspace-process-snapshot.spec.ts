import { afterEach, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => ({
  run: vi.fn<(command: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = () => { throw new Error('callback interface not expected') }
  Object.defineProperty(execFile, promisify.custom, { value: query.run })
  return { execFile }
})
import { readWorkspaceProcessSnapshot } from '../src/workspace-process-snapshot.ts'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const executable = Object.getOwnPropertyDescriptor(process, 'execPath')
const userIdentity = Object.getOwnPropertyDescriptor(process, 'getuid')
if (platform === undefined || executable === undefined) throw new Error('process descriptors unavailable')
const systemRoot = process.env.SystemRoot
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'execPath', executable)
  if (userIdentity === undefined) Reflect.deleteProperty(process, 'getuid')
  else Object.defineProperty(process, 'getuid', userIdentity)
  if (systemRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = systemRoot
  query.run.mockReset()
})

it('uses a bounded fixed same-user POSIX query', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1234 })
  query.run.mockResolvedValue({ stdout: 'snapshot', stderr: '' })
  await expect(readWorkspaceProcessSnapshot(3210)).resolves.toMatchObject({ platform: 'posix', stdout: 'snapshot' })
  expect(query.run).toHaveBeenCalledWith('/bin/ps', ['-ww', '-U', '1234', '-o', 'pid=,command='],
    expect.objectContaining({ timeout: 3210, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }))
})
it('refuses a POSIX query when no current user identity is available', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  Reflect.deleteProperty(process, 'getuid')
  await expect(readWorkspaceProcessSnapshot(3210)).rejects.toThrow('current user identity unavailable')
  expect(query.run).not.toHaveBeenCalled()
})
it('uses only candidate executables in the current Windows interactive session and selected identity fields', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'execPath', { value: 'C:\\Apps\\Muse.exe' })
  process.env.SystemRoot = 'C:\\Windows'
  query.run.mockResolvedValue({ stdout: '[]', stderr: '' })
  await readWorkspaceProcessSnapshot(2000)
  const args = query.run.mock.calls[0]
  if (args === undefined) throw new Error('no query')
  expect(args[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(args[1]).toContain('-NoProfile')
  expect(args[1].at(-1)).toContain('SessionId = $session')
  expect(args[1].at(-1)).toContain("Name = 'muse.exe'")
  expect(args[1].at(-1)).toContain('Select-Object Name,SessionId,ProcessId,CommandLine')
  expect(args[2]).toMatchObject({ timeout: 2000, windowsHide: true })
})
