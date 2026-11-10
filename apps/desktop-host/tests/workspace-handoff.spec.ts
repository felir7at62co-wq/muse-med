import { afterEach, expect, it, vi } from 'vitest'
const view = vi.hoisted(() => ({ read: vi.fn<(timeoutMs: number) => Promise<{ platform: 'posix' | 'win32'; stdout: string; stderr: string }>>() }))
vi.mock('../src/workspace-process-snapshot.ts', () => ({ readWorkspaceProcessSnapshot: (timeoutMs: number) => view.read(timeoutMs) }))
import { assertWorkspaceMigrationHandoff, otherPosixDesktopHost, otherWindowsDesktopHost } from '../src/workspace-handoff.ts'

afterEach(() => view.read.mockReset())
it('recognizes exact supported POSIX entries and excludes its own process', () => {
  expect(otherPosixDesktopHost(' 9 /runtime/node /pkg/dsh-desktop-host/lib/index.js\n', 9)).toBe(false)
  expect(otherPosixDesktopHost(' 9 /node current.js\n 20 /runtime/node "/a b/dsh-desktop-host/lib/index.js"\n', 9)).toBe(true)
  expect(otherPosixDesktopHost(' 9 /node current.js\n 20 /node /pkg/dsh-desktop-host/lib/index.js.map\n', 9)).toBe(false)
})
it('rejects missing visibility, duplicate rows and incomplete POSIX output', () => {
  expect(() => otherPosixDesktopHost('20 /node other.js\n', 9)).toThrow('Cannot verify')
  expect(() => otherPosixDesktopHost('9 self\n9 duplicate\n', 9)).toThrow('Cannot verify')
  expect(() => otherPosixDesktopHost('9 self\nincomplete\n', 9)).toThrow('Cannot verify')
})
it('recognizes Windows path separators, quoting and case without exposing arguments', () => {
  const rows = [{ ProcessId: 9, Name: 'node.exe', SessionId: 1, CommandLine: 'node current.js' },
    { ProcessId: 20, Name: 'Muse.exe', SessionId: 1, CommandLine: '"C:\\Muse\\Muse.exe" "C:\\pkg\\DSH-DESKTOP-HOST\\LIB\\INDEX.JS"' }]
  expect(otherWindowsDesktopHost(JSON.stringify(rows), 9)).toBe(true)
  expect(otherWindowsDesktopHost(JSON.stringify(rows.slice(0, 1)), 9)).toBe(false)
  expect(() => otherWindowsDesktopHost(JSON.stringify([{ ProcessId: 9, Name: 'node.exe', SessionId: 1, CommandLine: null }]), 9)).toThrow('Cannot verify')
})
it('ignores unrelated Windows services but refuses invisible candidate Hosts in the same interactive session', () => {
  const self = { ProcessId: 9, Name: 'Muse.exe', SessionId: 1, CommandLine: 'Muse current.js' }
  expect(otherWindowsDesktopHost(JSON.stringify([self,
    { ProcessId: 4, Name: 'System', SessionId: 0, CommandLine: null },
    { ProcessId: 20, Name: 'node.exe', SessionId: 2, CommandLine: null },
  ]), 9)).toBe(false)
  expect(() => otherWindowsDesktopHost(JSON.stringify([self,
    { ProcessId: 21, Name: 'node.exe', SessionId: 1, CommandLine: null },
  ]), 9)).toThrow('Cannot verify')
  expect(() => otherWindowsDesktopHost(JSON.stringify([self,
    { ProcessId: 21, Name: 'node.exe', SessionId: 1, CommandLine: '' },
  ]), 9)).toThrow('Cannot verify')
})
it('fails closed on process query errors or diagnostics and sanitizes raw output', async () => {
  view.read.mockRejectedValueOnce(new Error('private-command-argument'))
  await expect(assertWorkspaceMigrationHandoff(5000)).rejects.toMatchObject({ reason: 'unavailable' })
  view.read.mockResolvedValueOnce({ platform: 'posix', stdout: `${process.pid} self`, stderr: 'private-warning' })
  await expect(assertWorkspaceMigrationHandoff(5000)).rejects.not.toHaveProperty('cause')
  view.read.mockResolvedValueOnce({ platform: 'posix', stdout: `${process.pid} self`, stderr: '' })
  await expect(assertWorkspaceMigrationHandoff(5000)).resolves.toBeUndefined()
  await expect(assertWorkspaceMigrationHandoff(0)).rejects.toMatchObject({ reason: 'unavailable' })
})
