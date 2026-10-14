import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DesktopUpdateJournal, desktopUpdateJournalState } from '../src/update-journal.ts'

describe('desktop qualification update journal', () => {
  it('keeps both versions in separate files in the shared evidence directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-update-journal-'))
    try {
      const old = new DesktopUpdateJournal(directory, '1.0.0-nightly.1')
      old.action('download-requested')
      old.state({ phase: 'downloading', version: '1.0.0-nightly.2', percent: 42.1 })
      old.state({ phase: 'downloading', version: '1.0.0-nightly.2', percent: 42.9 })
      old.state({ phase: 'error', version: '1.0.0-nightly.2', failedOperation: 'download', message: 'ETIMEDOUT private-data' })
      old.action('download-requested')
      old.state({ phase: 'ready', version: '1.0.0-nightly.2' })
      old.action('install-confirmed')
      old.action('quit-requested')
      const next = new DesktopUpdateJournal(directory, '1.0.0-nightly.2')
      next.action('workspace-ready')
      const first = (await readFile(old.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      const second = (await readFile(next.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(first.map(row => row.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(first[4]).toMatchObject({ failedOperation: 'download', errorCode: 'ETIMEDOUT' })
      expect(second).toMatchObject([{ event: 'started', version: '1.0.0-nightly.2' }, { event: 'app-ready' },
        { event: 'workspace-ready' }])
      expect(first[0]).toMatchObject({ schemaVersion: 2, elapsedMs: 0, processType: 'desktop-main',
        pid: process.pid, ppid: process.ppid, platform: process.platform, arch: process.arch })
      expect(JSON.stringify(first)).not.toContain('private-data')
      expect(next.path).not.toBe(old.path)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('records fixed stage outcomes and durations without retaining paths or arbitrary details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-update-journal-stage-'))
    try {
      const journal = new DesktopUpdateJournal(directory, '1.0.0')
      const profile = journal.stage('profile-apply')
      profile.complete({ result: 'rebuilt' })
      const host = journal.stage('desktop-host-start')
      host.complete({ hostPid: 4321 })
      expect(() => { host.fail() }).toThrow('already settled')
      journal.stage('hongguo-prepare').fail()
      const rows = (await readFile(journal.path, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(rows.map(row => row.event)).toEqual(['started', 'app-ready', 'profile-apply-started',
        'profile-apply-completed', 'desktop-host-start-started', 'desktop-host-start-completed',
        'hongguo-prepare-started', 'hongguo-prepare-failed'])
      expect(rows[3]?.result).toBe('rebuilt')
      expect(typeof rows[3]?.durationMs).toBe('number')
      expect(rows[5]?.hostPid).toBe(4321)
      expect(typeof rows[5]?.durationMs).toBe('number')
      expect(typeof rows[7]?.durationMs).toBe('number')
      expect(rows.every(row => Number.isSafeInteger(row.elapsedMs) && (row.elapsedMs as number) >= 0)).toBe(true)
      expect(JSON.stringify(rows)).not.toContain(directory)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('drops detailed errors and unexpected fields instead of trying to redact arbitrary text', () => {
    const state = { phase: 'error' as const, failedOperation: 'download' as const, version: '1.2.3',
      message: 'https://user:password@example.test/file?token=secret', technicalDetails: 'password', extra: 'secret' }
    expect(desktopUpdateJournalState(state)).toEqual({ phase: 'error', targetVersion: '1.2.3',
      failedOperation: 'download', errorCode: 'UNCLASSIFIED' })
    expect(desktopUpdateJournalState({ phase: 'idle' })).toEqual({ phase: 'idle' })
    expect(desktopUpdateJournalState({ phase: 'downloading' })).toEqual({ phase: 'downloading' })
    expect(desktopUpdateJournalState({ phase: 'error' })).toEqual({ phase: 'error', errorCode: 'UNCLASSIFIED' })
    expect(desktopUpdateJournalState({ phase: 'verifying', version: '1.2.3', percent: 100 })).toEqual({ phase: 'verifying', targetVersion: '1.2.3' })
  })

  it('refuses relative evidence paths and reports storage failure', async () => {
    expect(() => new DesktopUpdateJournal('relative-logs', '1.0.0')).toThrow('must be absolute')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-update-journal-failure-'))
    try {
      const journal = new DesktopUpdateJournal(directory, '1.0.0')
      await rm(journal.path)
      await rm(directory, { recursive: true, force: true })
      expect(() => { journal.action('download-requested') }).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
