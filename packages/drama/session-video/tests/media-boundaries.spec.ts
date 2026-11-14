/** Media commands join real subprocesses and reject incomplete or invalid process evidence. */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SandboxProvider, SandboxUnavailableError, type SandboxPolicy, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { afterEach, expect, it, vi } from 'vitest'
import { command, facts, shotRanges } from '../src/media.ts'
import type { SessionVideoSourceId } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const bounds = { commandTimeoutMs: 30_000, graceMs: 100, maxOutputBytes: 4096 }
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Subprocess).await()
  return ctx
}

it.each(['missing provider', 'unavailable provider'] as const)('refuses confined execution with an %s', async (kind) => {
  const ctx = await fixture(), spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const captured: { argv: readonly string[]; policy: SandboxPolicy; signal: AbortSignal | undefined }[] = []
  class UnavailableSandbox extends SandboxProvider {
    async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      captured.push({ argv, policy, signal })
      throw new SandboxUnavailableError(policy.mode)
    }
  }
  if (kind === 'unavailable provider') await ctx.plugin(UnavailableSandbox).await()
  const argv = [process.execPath, '-e', 'process.stdout.write("never")']
  await expect(command(ctx, argv, { mode: 'read-only', workspaceRoot: tmpdir() }, new AbortController().signal, bounds))
    .rejects.toBeInstanceOf(SandboxUnavailableError)
  expect(spawn).not.toHaveBeenCalled()
  if (kind === 'unavailable provider') {
    expect(captured).toHaveLength(1)
    expect(captured[0]?.argv).toEqual(argv)
    expect(captured[0]?.policy).toMatchObject({ mode: 'read-only', workspaceRoot: tmpdir() })
    expect(captured[0]?.signal?.aborted).toBe(false)
  }
})

it.each(['complete bytes', 'nonzero exit', 'output overflow', 'string stream', 'spawn failure', 'caller cancellation', 'deadline'] as const)
('settles the managed process before returning its media outcome: %s', async (kind) => {
  const ctx = await fixture(), owner = new AbortController(), exitObserved = vi.fn()
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = spawn(spec)
    if (kind === 'string stream') child.stdout?.setEncoding('utf8')
    if (kind === 'caller cancellation') child.stdout?.once('data', () => { owner.abort(new Error('owner released')) })
    void child.done.then(() => { exitObserved() }, () => { exitObserved() })
    return child
  })
  const script = kind === 'nonzero exit' ? 'process.stderr.write("private-prefix"+"x".repeat(1100));process.exitCode=7'
    : kind === 'output overflow' ? 'process.stdout.write(Buffer.alloc(64));setInterval(()=>{},1000)'
      : kind === 'caller cancellation' ? 'process.stdout.write("ready");setInterval(()=>{},1000)'
        : kind === 'deadline' ? 'setInterval(()=>{},1000)' : 'process.stdout.write("完整 bytes")'
  const argv = kind === 'spawn failure' ? [join(tmpdir(), 'missing-video-command-' + randomUUID())] : [process.execPath, '-e', script]
  const pending = command(ctx, argv, { mode: 'danger-full-access', workspaceRoot: tmpdir() }, owner.signal,
    { ...bounds, maxOutputBytes: kind === 'output overflow' ? 8 : bounds.maxOutputBytes,
      commandTimeoutMs: kind === 'deadline' ? 100 : bounds.commandTimeoutMs })
  if (kind === 'complete bytes') expect(Buffer.from(await pending).toString('utf8')).toBe('完整 bytes')
  else if (kind === 'nonzero exit') {
    await expect(pending).rejects.toThrow('Video process failed (7): ' + 'x'.repeat(1000))
  } else {
    await expect(pending).rejects.toThrow(kind === 'output overflow' ? 'exceeds its limit'
      : kind === 'string stream' ? 'non-binary output' : kind === 'caller cancellation' ? 'owner released' : undefined)
  }
  expect(exitObserved).toHaveBeenCalledOnce()
})

it.each([null, {}, { streams: null }, { streams: [null, { codec_type: 'audio' }], format: { duration: 3 } },
  { streams: [{ codec_type: 'video', width: 0, height: 64 }], format: { duration: 3 } },
  { streams: [{ codec_type: 'video', width: 64, height: -1 }], format: { duration: 3 } },
  { streams: [{ codec_type: 'video', width: 1.5, height: 64 }], format: { duration: 3 } },
  { streams: [{ codec_type: 'video', width: 64, height: 64 }], format: { duration: 'Infinity' } }])
('rejects invalid probed track facts: %j', (value) => {
  expect(() => facts(Buffer.from(JSON.stringify(value)))).toThrow('no valid video')
})

it('keeps only separated interior cuts and rejects detector timestamps outside the source', () => {
  expect(facts(Buffer.from('{"format":{"duration":"3.5"},"streams":[{"codec_type":"video","width":64,"height":48}]}')))
    .toEqual({ durationSeconds: 3.5, width: 64, height: 48 })
  const id = brandString<SessionVideoSourceId>('source'), bytes = (text: string) => Buffer.from(text)
  const ranges = shotRanges(bytes('pts_time:0\npts_time:0.02\npts_time:1\npts_time:1\npts_time:2.99'), 3, id, 'v', 0.08, 10)
  expect(ranges.map(shot => [shot.startSeconds, shot.endSeconds])).toEqual([[0, 1], [1, 3]])
  for (const timestamp of ['-1', '3', 'Infinity']) {
    expect(() => shotRanges(bytes('pts_time:' + timestamp), 3, id, 'v', 0.08, 10)).toThrow('invalid source timestamp')
  }
})
