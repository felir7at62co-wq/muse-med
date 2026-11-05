/** Account-owned cloud media imports published only after local policy and full media verification. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxUnavailableError, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { mediaFileNameSchema, MuseMediaError } from './media.ts'
import type { MuseMediaClient } from './media.ts'
import type { MuseMediaJobId, MuseMediaTransfer, MuseMediaFileCoverage } from './media-types.ts'
import { MEDIA_FILE_HELPER } from './media-file-helper.ts'

/** Local import failures carry no child stderr, credentials or private transport details. */
export class MuseMediaImportError extends Error {
  constructor(readonly code: 'workspace-required' | 'local-filesystem-required' | 'read-only' | 'workspace-outside'
    | 'local-conflict' | 'invalid-media' | 'file-incomplete' | 'file-too-large' | 'cancelled' | 'unavailable') {
    super(`Muse media import: ${code}`)
  }
}

/** Validated deployment limits; executable paths are resolved through the mounted subprocess provider. */
export interface MuseMediaImportOptions {
  readonly directory: string
  readonly nodePath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxBytes: number
  readonly maxOutputBytes: number
  readonly maxPixels: number
  readonly maxDurationSeconds: number
}

const facts = z.object({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(['video', 'image']), width: z.number().int().positive(), height: z.number().int().positive(),
  durationSeconds: z.number().positive().optional(), fullDecodeVerified: z.literal(true) })
const fileIdentity = z.object({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) })
const publication = z.object({ media: fileIdentity, receipt: fileIdentity })
const helperEvent = z.discriminatedUnion('phase', [
  facts.extend({ phase: z.literal('verified') }),
  facts.extend({ phase: z.literal('published'), path: z.string(), receipt: z.string(), publication }),
  z.object({ phase: z.literal('failed'), code: z.string() }),
  z.object({ phase: z.literal('cleaned') }),
])

/** Locally verified file suitable for the existing present tool and video inventory. */
export interface MuseMediaImportReceipt extends z.infer<typeof facts> {
  readonly state: 'local_ready'
  readonly jobId: MuseMediaJobId
  readonly fileName: string
  readonly path: string
  readonly receipt: string
  readonly sourceJobState: 'cloud_saved' | 'partial'
  readonly fileCoverage: MuseMediaFileCoverage | null
}

interface Location { cwd: string; policy: SandboxExecutionPolicy }
interface HelperSpec {
  cwd: string
  directory: string
  nonce: string
  jobId: MuseMediaJobId
  name: string
  bytes: number
  sha256: string
  kind: 'video' | 'image'
  maxBytes: number
  maxOutputBytes: number
  maxPixels: number
  maxDurationSeconds: number
  ffmpeg: string
  ffprobe: string
  publication?: z.infer<typeof publication>
}

async function* fileChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return
      yield item.value
    }
  } finally {
    try { await reader.cancel() } catch (_error) { /* A disconnected transfer can reject cancellation after the original error. */ }
    reader.releaseLock()
  }
}

function failure(code: string): MuseMediaImportError {
  switch (code) {
    case 'LOCAL_CONFLICT': return new MuseMediaImportError('local-conflict')
    case 'FILE_TOO_LARGE': return new MuseMediaImportError('file-too-large')
    case 'FILE_INCOMPLETE': return new MuseMediaImportError('file-incomplete')
    case 'WORKSPACE_INVALID': return new MuseMediaImportError('workspace-outside')
    default: return new MuseMediaImportError('invalid-media')
  }
}

/** Owns active imports, their confined process ranges, and rollback before plugin unload completes. */
export class MuseMediaImporter {
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<MuseMediaImportReceipt>>()
  private readonly fs: Context['fs']
  private readonly subprocess: Context['subprocess']
  private readonly sandboxPolicy: Context['sandboxPolicy']
  private readonly sandbox: Context['sandbox'] | undefined

  /** @param ctx - Host services sharing one local filesystem and subprocess execution world.
   * @param client - Current-account transport; no credential crosses into a helper.
   * @param options - Validated file, executable and verification limits.
   */
  constructor(ctx: Context, private readonly client: Pick<MuseMediaClient, 'withFile'>,
    private readonly options: MuseMediaImportOptions) {
    this.fs = ctx.fs
    this.subprocess = ctx.subprocess
    this.sandboxPolicy = ctx.sandboxPolicy
    this.sandbox = ctx.get('sandbox')
  }

  /** Import one owned cloud file into the initiating Session without replacing an existing file.
   * @param agent - Live initiating Agent supplying the workspace and execution policy.
   * @param jobId - Muse cloud receipt, distinct from upstream task identifiers.
   * @param fileName - Exact safe filename from the receipt manifest.
   * @param signal - Tool cancellation; accepted cloud downloads remain unchanged.
   * @returns Published local file only after stream, hash, media and account verification.
   */
  async import(agent: Agent, jobId: MuseMediaJobId, fileName: string, signal: AbortSignal): Promise<MuseMediaImportReceipt> {
    const operation = this.perform(agent, jobId, fileName, AbortSignal.any([signal, this.stop.signal]))
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  /** Abort imports and await process exit plus rollback before removing the provider. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }

  private async location(agent: Agent, signal: AbortSignal): Promise<Location> {
    signal.throwIfAborted()
    const raw = agent.session.header.cwd
    if (raw === undefined || !isAbsolute(raw)) throw new MuseMediaImportError('workspace-required')
    const policy = this.sandboxPolicy.resolve({ session: agent.session })
    if (policy.mode === 'read-only') throw new MuseMediaImportError('read-only')
    let cwd: string
    try { cwd = await realpath(raw) } catch (_error) { throw new MuseMediaImportError('workspace-required') }
    const target = await this.fs.resolve(cwd, { signal })
    if (this.fs.processPathFromHostPath(cwd) !== cwd || this.fs.processPath(target) !== cwd) {
      throw new MuseMediaImportError('local-filesystem-required')
    }
    const root = await this.fs.resolve(policy.workspaceRoot, { signal })
    if (policy.mode === 'workspace-write' && !this.fs.contains(root, target)) throw new MuseMediaImportError('workspace-outside')
    // Confinement is required for workspace-write publication, including helper descendants.
    if (policy.mode !== 'danger-full-access' && this.sandbox === undefined) throw new SandboxUnavailableError(policy.mode)
    return { cwd, policy }
  }

  private async argv(spec: HelperSpec, operation: 'receive' | 'cleanup' | 'finalize', policy: SandboxExecutionPolicy,
    signal: AbortSignal): Promise<readonly string[]> {
    const node = await this.subprocess.resolveExecutable(this.options.nodePath, undefined, signal)
    const command = [node, '--input-type=module', '-e', MEDIA_FILE_HELPER, JSON.stringify({ ...spec, operation, controlFd: SUBPROCESS_CONTROL_FD })]
    if (policy.mode === 'danger-full-access') return command
    const sandbox = this.sandbox
    if (sandbox === undefined) throw new SandboxUnavailableError(policy.mode)
    return (await sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv
  }

  private environment(): NodeJS.ProcessEnv {
    const removed: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
    for (const key of Object.keys(process.env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD|COOKIE|PROXY|NODE_OPTIONS|LD_PRELOAD|DYLD_/iu.test(key)) removed[key] = undefined
    }
    return removed
  }

  private async settle(spec: HelperSpec, operation: 'cleanup' | 'finalize', policy: SandboxExecutionPolicy,
    caller?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout])
    const child = this.subprocess.spawn({ argv: await this.argv(spec, operation, policy, signal), cwd: spec.cwd,
      signal, graceMs: this.options.graceMs, env: this.environment(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.options.maxOutputBytes }, stderr: { maxBytes: this.options.maxOutputBytes } } })
    try {
      const outcome = await child.done
      if (outcome.exitCode !== 0 || outcome.signal !== null) throw new MuseMediaImportError('unavailable')
    } finally { child.terminate(); await child.waitForExit() }
  }

  private async receive(agent: Agent, transfer: MuseMediaTransfer, spec: HelperSpec, location: Location,
    caller: AbortSignal): Promise<MuseMediaImportReceipt> {
    const signal = AbortSignal.any([caller, transfer.signal, AbortSignal.timeout(this.options.timeoutMs)])
    const child = this.subprocess.spawn({ argv: await this.argv(spec, 'receive', location.policy, signal), cwd: spec.cwd,
      signal, graceMs: this.options.graceMs, env: this.environment(), stdio: { stdin: 'pipe', stdout: 'pipe',
        stderr: { maxBytes: this.options.maxOutputBytes }, control: 'pipe' } })
    const ready = Promise.withResolvers<void>()
    void ready.promise.catch((_error: unknown) => undefined)
    let published: z.infer<typeof facts> & { path: string; receipt: string } | undefined
    let error: MuseMediaImportError | undefined
    const output = (async () => {
      if (child.stdout === undefined) throw new MuseMediaImportError('unavailable')
      let text = '', bytes = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for await (const chunk of child.stdout) {
        if (!Buffer.isBuffer(chunk)) throw new MuseMediaImportError('invalid-media')
        bytes += chunk.byteLength
        if (bytes > this.options.maxOutputBytes) throw new MuseMediaImportError('invalid-media')
        text += decoder.decode(chunk, { stream: true })
        for (;;) {
          const line = text.indexOf('\n')
          if (line < 0) break
          const event = helperEvent.parse(JSON.parse(text.slice(0, line)))
          text = text.slice(line + 1)
          if (event.phase === 'failed') { error = failure(event.code); ready.reject(error) }
          else if (event.phase === 'verified') ready.resolve()
          else if (event.phase === 'published') {
            spec.publication = event.publication
            published = { path: event.path, receipt: event.receipt, ...facts.parse(event) }
          }
        }
      }
      text += decoder.decode()
      if (text !== '') throw new MuseMediaImportError('invalid-media')
    })()
    const completion = Promise.all([output, child.done]).then(([, outcome]) => {
      if (error !== undefined) throw error
      if (outcome.exitCode !== 0 || outcome.signal !== null) throw new MuseMediaImportError('invalid-media')
    })
    void completion.catch((error: unknown) => { ready.reject(error) })
    try {
      if (child.stdin === undefined || child.control === undefined) throw new MuseMediaImportError('unavailable')
      await pipeline(Readable.from(fileChunks(transfer.body)), child.stdin, { signal })
      await ready.promise
      await transfer.assertCurrent()
      const current = await this.location(agent, signal)
      if (current.cwd !== location.cwd) throw new MuseMediaImportError('workspace-outside')
      child.control.end('commit\n')
      await completion
      await transfer.assertCurrent()
      signal.throwIfAborted()
      const expected = join(spec.cwd, ...spec.directory.split('/'), `${spec.jobId}-${spec.name}`)
      if (published === undefined || published.path !== expected || published.receipt !== expected + '.source.json'
        || published.bytes !== spec.bytes || published.sha256 !== spec.sha256) throw new MuseMediaImportError('invalid-media')
      if (transfer.job.state !== 'cloud_saved' && transfer.job.state !== 'partial') throw new MuseMediaImportError('invalid-media')
      return { state: 'local_ready', jobId: spec.jobId, fileName: spec.name, ...published,
        sourceJobState: transfer.job.state, fileCoverage: transfer.job.file_coverage ?? null }
    } finally {
      child.terminate()
      await child.waitForExit()
      await Promise.allSettled([completion])
    }
  }

  private async perform(agent: Agent, jobId: MuseMediaJobId, name: string, signal: AbortSignal): Promise<MuseMediaImportReceipt> {
    if (!mediaFileNameSchema.safeParse(name).success) throw new MuseMediaError('invalid-input')
    const location = await this.location(agent, signal)
    let spec: HelperSpec | undefined
    try {
      const result = await this.client.withFile(jobId, name, async (transfer) => {
        if (transfer.file.kind === 'metadata') throw new MuseMediaImportError('invalid-media')
        const ffprobe = await this.subprocess.resolveExecutable(this.options.ffprobePath, undefined, signal)
        const ffmpeg = await this.subprocess.resolveExecutable(this.options.ffmpegPath, undefined, signal)
        spec = { cwd: location.cwd, directory: this.options.directory, nonce: randomUUID(), jobId, name,
          bytes: transfer.file.bytes, sha256: transfer.file.sha256,
          kind: transfer.file.kind === 'video' || transfer.file.kind === 'live_video' ? 'video' : 'image',
          maxBytes: this.options.maxBytes, maxOutputBytes: this.options.maxOutputBytes, maxPixels: this.options.maxPixels,
          maxDurationSeconds: this.options.maxDurationSeconds, ffmpeg, ffprobe }
        const receipt = await this.receive(agent, transfer, spec, location, signal)
        await this.settle(spec, 'finalize', location.policy, transfer.signal)
        await transfer.assertCurrent()
        transfer.signal.throwIfAborted()
        return receipt
      }, signal)
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (spec !== undefined) await this.settle(spec, 'cleanup', location.policy)
      if (signal.aborted) throw new MuseMediaImportError('cancelled')
      if (error instanceof MuseMediaError || error instanceof MuseMediaImportError || error instanceof SandboxUnavailableError) throw error
      throw new MuseMediaImportError('invalid-media')
    }
  }
}
