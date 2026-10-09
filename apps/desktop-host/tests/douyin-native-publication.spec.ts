import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as fileIO from 'node:fs/promises'
import type { DouyinDesktopRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { installDesktopDouyinBrowser } from '../src/douyin-browser.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const realFileIO = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const id = '7692443246022167851'
const evidence = { responseStatus: 206, mediaHost: 'v3.douyinvod.com', mediaUrlHash: 'a'.repeat(64), association: 'player-exact', currentSrcMatched: true }
const playerMetadata = { targetVideoId: id, sourceField: 'video.playAddr', durationMs: 34434,
  width: 3840, height: 2160, documentEpoch: 1, source: 'player-parent-awemeInfo' }
const playerEvidence = { responseStatus: 206, mediaHost: 'v3.douyinvod.com', mediaUrlHash: 'b'.repeat(64),
  association: 'player-metadata-verified', currentSrcMatched: false, playerMetadata }
/** Verification dependency fixture; these tests exercise actual filesystem publication, not codecs or platform downloads. */
class FileVerification extends SubprocessRuntime {
  readonly commands: string[][] = []
  constructor(ctx: Context, private readonly config: { decode?: (spec: SubprocessSpawnSpec) => Promise<void> } = {}) { super(ctx) }
  override async resolveExecutable(command: string): Promise<string> { return command }
  override async terminalEnvironment() { return { platform: 'posix' as const } }
  override async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('No terminal in file verification fixture') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.commands.push([...spec.argv])
    const text = spec.argv.includes('-show_entries') ? JSON.stringify({ format: { duration: '34.41' }, streams: [{ codec_type: 'video', width: 3840, height: 2160 }] }) : ''
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) } },
      done: (spec.argv.includes('-xerror') && this.config.decode !== undefined ? this.config.decode(spec) : Promise.resolve())
        .then(() => ({ exitCode: 0, signal: null })), terminate() {}, waitForExit: async () => true,
    }
  }
}
it.each(['publish', 'publish-player-metadata', 'player-duration-mismatch', 'player-aspect-mismatch', 'crossed-player-provider',
  'long-verification', 'cancel-verification', 'expired-verification',
  'existing-media', 'existing-receipt', 'outside', 'symlink', 'linked-directory', 'wrong-work', 'write-failure', 'cancel-close'] as const)(
  'native file publication preserves private source effects: %s', async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'muse-native-file-effects-'))), ctx = new Context()
    const connected = Object.getOwnPropertyDescriptor(process, 'connected'), send = Object.getOwnPropertyDescriptor(process, 'send')
    let published = '', receipt = '', staging = ''
    let linkedDirectory: string | undefined
    const cancellation = new AbortController(), closing = Promise.withResolvers<undefined>(), closeGate = Promise.withResolvers<undefined>()
    const decodeEntered = Promise.withResolvers<undefined>(), decodeExit = Promise.withResolvers<undefined>()
    const timedVerification = ['long-verification', 'cancel-verification', 'expired-verification'].includes(mode)
    let decodeSignal: AbortSignal | undefined
    let restoreTimeout: (() => void) | undefined
    if (timedVerification) {
      vi.useFakeTimers()
      const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const timer = new AbortController()
        setTimeout(() => { timer.abort(new Error('Verification deadline')) }, ms)
        return timer.signal
      })
      restoreTimeout = () => { timeoutMock.mockRestore() }
    }
    if (mode === 'write-failure' || mode === 'cancel-close') vi.mocked(fileIO.open).mockImplementationOnce(async (...args) => {
      const handle = await realFileIO.open(...args)
      const write = handle.writeFile.bind(handle), close = handle.close.bind(handle)
      if (mode === 'write-failure') vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await write('partial-owned-receipt')
        throw new Error('Controlled write failure')
      })
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        closing.resolve(undefined)
        await closeGate.promise
        await close()
      })
      return handle
    })
    Object.defineProperty(process, 'connected', { value: true, configurable: true })
    Object.defineProperty(process, 'send', { configurable: true, value: (request: DouyinDesktopRequest, callback: (error: Error | null) => void) => {
      published = join(root, 'source', 'media', 'douyin', `${id}-${request.taskId}.mp4`)
      receipt = published + '.source.json'
      if (request.action === 'prepare') {
        mkdirSync(join(root, 'source', 'media', 'douyin'), { recursive: true })
        if (mode === 'existing-media') writeFileSync(published, 'retain-media')
        if (mode === 'existing-receipt') writeFileSync(receipt, 'retain-receipt')
      }
      if (request.action === 'download') {
        const directory = join(root, 'source', 'media', 'douyin', `.native-${request.taskId}`)
        if (mode === 'linked-directory') {
          const retained = join(root, 'retained-directory')
          mkdirSync(retained)
          writeFileSync(join(retained, 'video.mp4'), 'retain-input')
          symlinkSync(retained, directory, process.platform === 'win32' ? 'junction' : 'dir')
          linkedDirectory = directory
          expect(lstatSync(directory).isSymbolicLink()).toBe(true)
        } else mkdirSync(directory)
        staging = join(directory, 'video.mp4')
        const other = join(root, 'retained-input.mp4')
        if (mode === 'outside') writeFileSync(other, 'retain-input')
        if (mode === 'symlink') renameSync(join(root, 'staged-link.mp4'), staging)
        else if (mode !== 'linked-directory') writeFileSync(staging, 'fixture-media')
        const selectedEvidence = mode === 'publish-player-metadata' ? playerEvidence
          : mode === 'player-duration-mismatch' ? { ...playerEvidence, playerMetadata: { ...playerMetadata, durationMs: 1000 } }
            : mode === 'player-aspect-mismatch' ? { ...playerEvidence, playerMetadata: { ...playerMetadata, width: 2160, height: 3840 } }
              : mode === 'crossed-player-provider' ? { ...playerEvidence, provider: { targetVideoId: id } } : evidence
        const staged = (): void => { EventEmitter.prototype.emit.call(process, 'message', {
          type: 'douyin-browser-result', requestId: request.requestId, code: 'STAGED',
          targetVideoId: mode === 'wrong-work' ? '7690000000000000000' : id,
          path: mode === 'outside' ? other : staging, evidence: selectedEvidence,
        }) }
        if (mode === 'long-verification') setTimeout(staged, 290_000)
        else queueMicrotask(staged)
      } else queueMicrotask(() => { EventEmitter.prototype.emit.call(process, 'message', {
        type: 'douyin-browser-result', requestId: request.requestId, code: request.action === 'prepare' ? 'PREPARED' : 'RELEASED', targetVideoId: id,
      }) })
      callback(null)
    } })
    try {
      // Create the file-link fixture before the transport can convert setup errors into a blocked receipt.
      if (mode === 'symlink') {
        const other = join(root, 'retained-input.mp4')
        writeFileSync(other, 'retain-input')
        symlinkSync(other, join(root, 'staged-link.mp4'), 'file')
      }
      await ctx.plugin(SessionStore)
      await ctx.plugin(FileVerification, timedVerification ? { decode(spec) {
        decodeSignal = spec.signal
        decodeEntered.resolve(undefined)
        return decodeExit.promise
      } } : {})
      const session = ctx.sessions.create(SessionId('native-file-effects'), { meta: { cwd: root } })
      installDesktopDouyinBrowser(ctx)
      const operation = ctx.douyinBrowser.download({ id: session.id, session } as Agent,
        `https://www.douyin.com/video/${id}`, cancellation.signal, 1024,
        mode === 'expired-verification' ? 1000 : mode === 'long-verification' ? 300_000 : 1_800_000)
      if (timedVerification) {
        if (mode === 'long-verification') await vi.advanceTimersByTimeAsync(290_000)
        await decodeEntered.promise
        let settled = false
        void operation.then(() => { settled = true })
        if (mode === 'cancel-verification') cancellation.abort('cancelled')
        await vi.advanceTimersByTimeAsync(mode === 'expired-verification' ? 1000 : 130_001)
        expect(decodeSignal?.aborted).toBe(mode !== 'long-verification')
        expect(settled).toBe(false)
        expect(existsSync(published)).toBe(false)
        expect(existsSync(receipt)).toBe(false)
        decodeExit.resolve(undefined)
      }
      if (mode === 'write-failure' || mode === 'cancel-close') {
        let settled = false
        void operation.then(() => { settled = true })
        await closing.promise
        try {
          if (mode === 'cancel-close') cancellation.abort('cancelled')
          for (let i = 0; i < 10; i++) await Promise.resolve()
          expect(settled).toBe(false)
          expect(existsSync(receipt)).toBe(true)
        } finally { closeGate.resolve(undefined) }
      }
      const result = await operation
      if (mode === 'publish' || mode === 'publish-player-metadata' || mode === 'long-verification') {
        expect(result).toMatchObject({ status: 'downloaded', path: published, receipt, bytes: 13 })
        expect(readFileSync(published, 'utf8')).toBe('fixture-media')
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ targetVideoId: id, path: published })
        if (mode === 'publish-player-metadata') {
          const recorded: unknown = JSON.parse(readFileSync(receipt, 'utf8'))
          expect(recorded).toMatchObject({ evidence: playerEvidence,
            sha256: createHash('sha256').update(readFileSync(published)).digest('hex'), full_decode_verified: true })
          expect(recorded).not.toHaveProperty('evidence.provider')
          if (!(ctx.subprocess instanceof FileVerification)) throw new Error('Unexpected verification provider')
          expect(ctx.subprocess.commands.some(argv => argv.includes('-show_entries'))).toBe(true)
          expect(ctx.subprocess.commands.some(argv => argv.includes('-xerror') && argv.includes('null'))).toBe(true)
        }
      } else {
        expect(result).toMatchObject({ status: 'blocked', code: mode === 'cancel-close' || mode === 'cancel-verification' ? 'CANCELLED' : 'MEDIA_VERIFICATION_FAILED' })
        if (mode === 'existing-media') expect(readFileSync(published, 'utf8')).toBe('retain-media')
        else expect(existsSync(published)).toBe(false)
        if (mode === 'existing-receipt') expect(readFileSync(receipt, 'utf8')).toBe('retain-receipt')
        else expect(existsSync(receipt)).toBe(false)
        if (mode === 'outside' || mode === 'symlink') expect(readFileSync(join(root, 'retained-input.mp4'), 'utf8')).toBe('retain-input')
        if (mode === 'linked-directory') {
          expect(readFileSync(join(root, 'retained-directory', 'video.mp4'), 'utf8')).toBe('retain-input')
          expect(realpathSync(staging)).not.toBe(staging)
          if (!(ctx.subprocess instanceof FileVerification)) throw new Error('Unexpected verification provider')
          expect(ctx.subprocess.commands).toEqual([])
        }
      }
      expect(existsSync(staging)).toBe(true)
    } finally {
      closeGate.resolve(undefined)
      decodeExit.resolve(undefined)
      await ctx.fiber.dispose()
      vi.mocked(fileIO.open).mockRestore()
      if (connected !== undefined) Object.defineProperty(process, 'connected', connected); else Reflect.deleteProperty(process, 'connected')
      if (send !== undefined) Object.defineProperty(process, 'send', send); else Reflect.deleteProperty(process, 'send')
      if (linkedDirectory !== undefined) unlinkSync(linkedDirectory)
      rmSync(root, { recursive: true, force: true })
      if (timedVerification) { restoreTimeout?.(); vi.useRealTimers() }
    }
  },
)
