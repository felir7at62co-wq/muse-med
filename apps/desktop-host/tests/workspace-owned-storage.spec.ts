import { mkdtemp, readFile, rm, mkdir, writeFile, realpath, readdir, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { OwnedWorkspaceStorage } from '../src/workspace-owned-storage.ts'

const isolatedScan = vi.hoisted(() => ({ read: vi.fn<(timeoutMs: number) => Promise<{ platform: 'posix' | 'win32'; stdout: string; stderr: string }>>() }))
vi.mock('../src/workspace-process-snapshot.ts', () => ({
  readWorkspaceProcessSnapshot: (timeoutMs: number) => isolatedScan.read(timeoutMs),
}))
isolatedScan.read.mockImplementation(() => Promise.resolve({ platform: 'posix', stdout: `${process.pid} test-runner\n`, stderr: '' }))

const ID = SessionId('session-original')
const descriptor = { name: 'workspace', version: 2, hasGlobal: true, tables: ['workspaces'] }
const record = { path: '/project', title: 'original', sessionIds: [ID], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const globalState = { initialized: true, workspaceIds: ['ws-original'], archivedSessionIds: [], pinnedSessionIds: [] }
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'muse-owned-workspace-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const sourcePath = join(dir, 'workspace.json'), root = join(dir, 'owned.v1')
  const source = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: globalState, tables: { workspaces: { 'ws-original': record } } })
  await writeFile(sourcePath, source)
  const sourceBackend = new JsonStorageBackend(dir)
  onTestFinished(() => sourceBackend.close())
  const backend = new OwnedWorkspaceStorage({ sourceBackend: 'json', root }, sourceBackend)
  onTestFinished(() => backend.close())
  return { backend, dir, root, sourcePath, source, sourceBackend }
}

describe('Desktop workspace successor ownership', () => {
  it('migrates the full original identity and keeps a source hash while preserving the source bytes', async () => {
    const h = await harness()
    const unit = await h.backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ global: globalState, tables: { workspaces: { 'ws-original': record } } })
    expect(await readFile(h.sourcePath, 'utf8')).toBe(h.source)
    expect(JSON.parse(await readFile(join(h.root, 'migration.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, sourcePath: await realpath(h.sourcePath) })
    const identity = await h.backend.capture(ID, new AbortController().signal)
    expect(identity).toMatchObject({ sessionId: ID, workspaceId: 'ws-original', workspacePath: '/project' })
    await unit.close()
    const reopened = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: h.root }, h.sourceBackend)
    onTestFinished(() => reopened.close())
    await reopened.kv.open(descriptor)
    expect(await reopened.capture(ID, new AbortController().signal)).toEqual(identity)
  })

  it('does not adopt later writes from the legacy store or migrate from a different source', async () => {
    const h = await harness()
    const unit = await h.backend.kv.open(descriptor)
    await writeFile(h.sourcePath, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { ...globalState, workspaceIds: [] }, tables: { workspaces: {} } }))
    expect(await unit.loadAll()).toMatchObject({ tables: { workspaces: { 'ws-original': record } } })
    await h.backend.close()
    const changedSource = new OwnedWorkspaceStorage({ sourceBackend: 'different-json', root: h.root }, h.sourceBackend)
    onTestFinished(() => changedSource.close())
    await expect(changedSource.kv.open(descriptor)).rejects.toThrow('migration source')
  })

  it('blocks a second owner and releases kernel ownership when closed', async () => {
    const h = await harness()
    await h.backend.kv.open(descriptor)
    const second = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: h.root }, h.sourceBackend)
    onTestFinished(() => second.close())
    await expect(second.kv.open(descriptor)).rejects.toThrow()
    await h.backend.close()
    const third = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: h.root }, h.sourceBackend)
    onTestFinished(() => third.close())
    await expect(third.kv.open(descriptor)).resolves.toBeDefined()
  })

  it('retains membership through title changes and distinguishes detach and reattach', async () => {
    const h = await harness()
    const unit = await h.backend.kv.open(descriptor)
    const original = await h.backend.capture(ID, new AbortController().signal)
    expect(original).toBeDefined()
    await unit.putRecord('workspaces', 'ws-original', { ...record, title: 'renamed' })
    expect(await h.backend.capture(ID, new AbortController().signal)).toEqual(original)
    await unit.putRecord('workspaces', 'ws-original', { ...record, sessionIds: [] })
    expect(await h.backend.capture(ID, new AbortController().signal)).toBeUndefined()
    await unit.putRecord('workspaces', 'ws-original', record)
    expect(await h.backend.capture(ID, new AbortController().signal)).not.toEqual(original)
    await expect(h.backend.acquire(original!, new AbortController().signal)).rejects.toThrow('membership changed')
  })

  it('revokes only the affected continuation before a user ownership or archive change', async () => {
    const h = await harness()
    const unit = await h.backend.kv.open(descriptor)
    const signal = new AbortController().signal
    const identity = await h.backend.capture(ID, signal)
    const lease = await h.backend.acquire(identity!, signal)
    await unit.putRecord('workspaces', 'ws-original', { ...record, title: 'renamed' })
    lease.assertCurrent()
    await unit.deleteRecord('workspaces', 'ws-original')
    expect(lease.signal.aborted).toBe(true)
    expect(() => { lease.assertCurrent() }).toThrow()
    await unit.putRecord('workspaces', 'ws-original', record)
    const restored = await h.backend.capture(ID, signal)
    const second = await h.backend.acquire(restored!, signal)
    await unit.putRecord('workspaces', 'ws-original', { ...record, sessionIds: [] })
    expect(second.signal.aborted).toBe(true)
    await unit.putRecord('workspaces', 'ws-original', record)
    const last = await h.backend.capture(ID, signal)
    const third = await h.backend.acquire(last!, signal)
    await unit.setGlobal({ ...globalState, archivedSessionIds: [ID] })
    expect(third.signal.aborted).toBe(true)
    expect(await h.backend.capture(ID, signal)).toBeUndefined()
  })

  it('refuses incomplete or ambiguous migration inputs and does not adopt staging residue', async () => {
    const h = await harness()
    await writeFile(h.sourcePath, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { ...globalState, pendingMutation: { operation: 'delete', workspaceId: 'ws-original' } }, tables: { workspaces: { 'ws-original': record } } }))
    await expect(h.backend.kv.open(descriptor)).rejects.toThrow('mutation must finish')
    expect(await readFile(h.sourcePath, 'utf8')).toContain('pendingMutation')
    await mkdir(join(h.dir, '.owned.v1-migration-interrupted'))
    await writeFile(join(h.dir, '.owned.v1-migration-interrupted', 'state.json'), '{broken')
    await writeFile(h.sourcePath, h.source)
    const fresh = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: h.root }, h.sourceBackend)
    onTestFinished(() => fresh.close())
    await fresh.kv.open(descriptor)
    expect(await fresh.capture(ID, new AbortController().signal)).toMatchObject({ workspaceId: 'ws-original' })
  })
  it('excludes another process and recovers the same authority after the owner is killed', async () => {
    const h = await harness()
    const child = spawn(process.execPath, ['--import', 'tsx/esm',
      fileURLToPath(new URL('./fixtures/workspace-owned-process.ts', import.meta.url)), h.dir, h.root], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exit = once(child, 'exit')
    void exit.catch(() => {})
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    onTestFinished(async () => { child.kill('SIGKILL'); await exit })
    const message = await new Promise<string>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => { reject(new Error(`owner fixture not ready: ${stderr}`)) }, 5000)
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk)
        if (buffer.includes('\n')) { clearTimeout(timer); resolve(buffer.split('\n')[0]!) }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`owner fixture exited: ${stderr}`)) })
    })
    const initial = JSON.parse(message) as { identity: { authorityId: string } }
    await expect(h.backend.kv.open(descriptor)).rejects.toThrow()
    child.kill('SIGKILL')
    await exit
    const reopened = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: h.root }, h.sourceBackend)
    onTestFinished(() => reopened.close())
    await reopened.kv.open(descriptor)
    expect(await reopened.capture(ID, new AbortController().signal)).toMatchObject({ authorityId: initial.identity.authorityId })
  }, 10000)

  it('keeps the legacy source and recovers from a process death before migration publication', async () => {
    const h = await harness()
    const child = spawn(process.execPath, ['--import', 'tsx/esm',
      fileURLToPath(new URL('./fixtures/workspace-owned-process.ts', import.meta.url)), h.dir, h.root, 'crash-before-publish'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = '', stdout = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('close', (code, signal) => { resolve({ code, signal }) })
      child.once('error', reject)
    })
    void closed.catch(() => {})
    onTestFinished(async () => { child.kill('SIGKILL'); await closed })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`migration child did not exit: ${stderr}`)) }, 5000)
      })])
      expect(result, stderr).toEqual(process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' })
      expect(stdout).toBe('MIGRATION_BEFORE_PUBLICATION\n')
    } finally { clearTimeout(timer) }
    await expect(stat(h.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(h.dir)).some(name => name.startsWith('.owned.v1-migration-'))).toBe(true)
    expect(await readFile(h.sourcePath, 'utf8')).toBe(h.source)
    await h.backend.kv.open(descriptor)
    expect(await h.backend.capture(ID, new AbortController().signal)).toMatchObject({ sessionId: ID, workspaceId: 'ws-original' })
  }, 10000)

  it('allows a closed domain to reopen and prevents stale handles from touching its replacement', async () => {
    const h = await harness()
    const first = await h.backend.kv.open(descriptor)
    const identity = await h.backend.capture(ID, new AbortController().signal)
    const lease = await h.backend.acquire(identity!, new AbortController().signal)
    await first.close()
    expect(lease.signal.aborted).toBe(true)
    const second = await h.backend.kv.open(descriptor)
    await expect(first.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await expect(first.putRecord('workspaces', 'ws-original', { ...record, title: 'stale' })).rejects.toMatchObject({ code: 'closed' })
    await first.close()
    expect(await second.loadAll()).toMatchObject({ tables: { workspaces: { 'ws-original': record } } })
    expect(await h.backend.capture(ID, new AbortController().signal)).toEqual(identity)
  })

  it.skipIf(process.platform === 'win32')('waits for an observed old Host drain before publishing the first migration', async () => {
    const h = await harness()
    const oldEntry = join(h.dir, 'dsh-desktop-host', 'lib', 'index.js')
    await mkdir(join(h.dir, 'dsh-desktop-host', 'lib'), { recursive: true })
    await writeFile(oldEntry, `const fs = require('node:fs/promises');
process.send({ ready: true });
process.on('message', async (message) => {
  await fs.writeFile(process.argv[2] + '.drain', message.text);
  await fs.rename(process.argv[2] + '.drain', process.argv[2]);
  process.exit(0);
});`)
    const child = spawn(process.execPath, [oldEntry, h.sourcePath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const exit = once(child, 'exit')
    void exit.catch(() => {})
    onTestFinished(async () => {
      child.kill('SIGKILL'); await exit
      isolatedScan.read.mockImplementation(() => Promise.resolve({ platform: 'posix', stdout: `${process.pid} test-runner\n`, stderr: '' }))
    })
    await once(child, 'message', { signal: AbortSignal.timeout(5000) })
    if (child.pid === undefined) throw new Error('old host child has no PID')
    const oldPid = child.pid
    isolatedScan.read.mockImplementation(async () => {
      const snapshot = await promisify(execFile)('/bin/ps', ['-ww', '-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
      const stdout = snapshot.stdout.split('\n').filter((line) => {
        const pid = Number(/^\s*([0-9]+)/u.exec(line)?.[1])
        return pid === oldPid || pid === process.pid
      }).join('\n')
      return { platform: 'posix', stdout, stderr: snapshot.stderr }
    })
    await expect(h.backend.kv.open(descriptor)).rejects.toMatchObject({ name: 'WorkspaceHandoffError', reason: 'other-host' })
    await expect(stat(h.root)).rejects.toMatchObject({ code: 'ENOENT' })
    const finalSource = JSON.parse(h.source) as { tables: { workspaces: Record<string, typeof record> } }
    finalSource.tables.workspaces['ws-original'] = { ...record, title: 'after-old-host-drain' }
    child.send({ text: JSON.stringify(finalSource) })
    await exit
    const unit = await h.backend.kv.open(descriptor)
    expect(await unit.loadAll()).toMatchObject({ tables: { workspaces: { 'ws-original': { title: 'after-old-host-drain' } } } })
  }, 15000)

  it('refuses publication when the second process snapshot finds a Host after source capture', async () => {
    const h = await harness()
    isolatedScan.read.mockResolvedValueOnce({ platform: 'posix', stdout: `${process.pid} self\n`, stderr: '' })
      .mockResolvedValueOnce({ platform: 'posix', stdout: `${process.pid} self\n999999 node /prior/dsh-desktop-host/lib/index.js\n`, stderr: '' })
    await expect(h.backend.kv.open(descriptor)).rejects.toMatchObject({ reason: 'other-host' })
    await expect(stat(h.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(h.sourcePath, 'utf8')).toBe(h.source)
  })

})
