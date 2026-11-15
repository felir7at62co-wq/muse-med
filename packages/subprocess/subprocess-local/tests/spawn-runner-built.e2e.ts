import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupLinuxLaunchFiles,
  createLinuxLaunchFiles,
} from '../src/runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  SUBPROCESS_RUNNER_ENV,
  targetEnvironment,
} from '../src/runner-launch.ts'
import type { RunnerInvocation } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import { launchWindowsJob } from '../src/windows-job.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const sourceRunner = resolve(repoRoot, 'packages/subprocess/subprocess-local/src/bin.ts')
const builtRunner = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner'))

function targetEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    [SUBPROCESS_RUNNER_ENV]: 'target-collision-restored',
  }
}

async function executePosix(invocation: RunnerInvocation): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const files = createLinuxLaunchFiles({ cwd: repoRoot, env: targetEnv() })
  try {
    const child = spawn(invocation[0], [
      ...invocation.slice(1),
      '--',
      process.execPath,
      '--input-type=module',
      '--eval',
      `process.stdout.write(process.argv[0]+'|'+process.cwd()+'|'+process.env.${SUBPROCESS_RUNNER_ENV})`,
    ], {
      env: runnerEnvironment(files.requestPath, invocation),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const status = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', resolveExit)
    })
    return { status, stdout, stderr }
  } finally {
    cleanupLinuxLaunchFiles(files)
  }
}

async function executeWindows(invocation: RunnerInvocation): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const request: SubprocessSpawnSpec = {
    argv: [
      process.execPath,
      '--input-type=module',
      '--eval',
      `process.stdout.write(process.argv[0]+'|'+process.cwd()+'|'+process.env.${SUBPROCESS_RUNNER_ENV})`,
    ],
    cwd: repoRoot,
    env: targetEnv(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
  }
  const handle = bindManagedProcess(request, launchWindowsJob(
    request,
    targetEnvironment(request),
    { runnerInvocation: invocation },
  ))
  const outcome = await handle.done
  await handle.waitForExit()
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { status: outcome.exitCode, stdout, stderr }
}

async function execute(invocation: RunnerInvocation): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return process.platform === 'win32'
    ? executeWindows(invocation)
    : executePosix(invocation)
}

const blockingProbe = String.raw`
import { constants, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [ready, result] = process.argv.slice(2)
const flags = [0, 1, 2].map(fd => {
  const value = readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^flags:\s+([0-7]+)$/m)
  if (!value) throw Error('Missing descriptor flags')
  return { fd, status: Number.parseInt(value[1], 8) }
})
// Use only filesystem APIs: accessing process.stdout/stderr would change the measured flags.
writeFileSync(ready, JSON.stringify({ flags, nonblock: constants.O_NONBLOCK }))
try {
  const stdin = readFileSync(0, 'utf8'), streams = []
  for (const fd of [1, 2]) {
    const bytes = Buffer.alloc(2 * 1024 * 1024, fd === 1 ? 0x31 : 0x32)
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
    streams.push({ fd, written, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  writeFileSync(result, JSON.stringify({ flags, stdin, streams }))
} catch (error) {
  writeFileSync(result, JSON.stringify({ flags, error: String(error), code: error.code }))
  process.exitCode = 1
}
`

async function blockingStdioProof(invocation: RunnerInvocation): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runner-blocking-'))
  const probe = join(root, 'target.mjs'), ready = join(root, 'ready.json'), result = join(root, 'result.json')
  let files: ReturnType<typeof createLinuxLaunchFiles> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<number | null> | undefined
  let cleanupPromise: Promise<void> | undefined
  let cleaning = false
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    cleaning = true
    const errors: unknown[] = []
    try {
      child?.stdin?.destroy()
      child?.stdout?.resume()
      child?.stderr?.resume()
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch (error) { errors.push(error) }
    if (closed) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(Error('Runner did not close after cleanup')) }, 5_000)
        })])
      } catch (error) { errors.push(error) }
      finally { clearTimeout(timer) }
    }
    try { if (files) cleanupLinuxLaunchFiles(files) } catch (error) { errors.push(error) }
    try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Blocking-stdio probe cleanup failed')
  })()
  // Registered before further I/O so Vitest failure/timeout also joins cleanup.
  onTestFinished(cleanup)
  let primary: { error: unknown } | undefined
  try {
    await writeFile(probe, blockingProbe)
    if (cleaning) throw Error('Blocking-stdio probe ended during setup')
    files = createLinuxLaunchFiles({ cwd: repoRoot, env: targetEnv() })
    // Eager getters reproduce a Node bootstrap owning each stream before execve.
    const warmStdio = 'data:text/javascript,void(process.stdin);void(process.stdout);void(process.stderr)'
    const spawned = spawn(invocation[0], ['--import', warmStdio, ...invocation.slice(1), '--', process.execPath, probe, ready, result], {
      env: runnerEnvironment(files.requestPath, invocation), stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = spawned
    const out: Buffer[] = [], err: Buffer[] = []
    closed = new Promise<number | null>((resolveClose, rejectClose) => {
      spawned.once('error', rejectClose)
      spawned.once('close', resolveClose)
    })
    // Observe rejection immediately; its original outcome is still awaited below.
    void closed.catch(() => {})
    spawned.stdin.end('blocking-stdio-input')
    const until = Date.now() + 5_000
    for (;;) {
      if (cleaning) throw Error('Blocking-stdio probe ended before descriptor observation')
      if (existsSync(ready)) break
      if (spawned.exitCode !== null || spawned.signalCode !== null) throw Error('Runner exited before recording descriptor flags')
      if (Date.now() >= until) throw Error('Runner did not record descriptor flags')
      await delay(10)
    }
    // Delayed consumers stress the fixed 2 MiB writes; timing is not a proof of blocking.
    await delay(100)
    spawned.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    spawned.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
    const status = await closed
    const observed = JSON.parse(await readFile(ready, 'utf8')) as { flags: { fd: number; status: number }[]; nonblock: number }
    const evidence = await readFile(result, 'utf8')
    expect(status, evidence).toBe(0)
    expect(observed.flags.map(({ fd, status: flags }) => [fd, flags & observed.nonblock])).toEqual([[0, 0], [1, 0], [2, 0]])
    const streams = [out, err].map((chunks, index) => {
      const bytes = Buffer.concat(chunks), expected = Buffer.alloc(2 * 1024 * 1024, index + 0x31)
      expect(bytes.length).toBe(expected.length)
      expect(bytes.equals(expected)).toBe(true)
      return { fd: index + 1, written: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
    expect(JSON.parse(evidence)).toEqual({ flags: observed.flags, stdin: 'blocking-stdio-input', streams })
  } catch (error) {
    primary = { error }
  } finally {
    try { await cleanup() }
    catch (error) {
      if (primary) throw new AggregateError([primary.error, error], 'Blocking-stdio probe and cleanup failed')
      throw error
    }
  }
  if (primary) throw primary.error
}

describe('subprocess-local runner artifacts', () => {
  it.skipIf(process.platform !== 'linux').each(['source', 'built'] as const)(
    'preserves blocking stdio and complete bytes with delayed stream readers through the %s runner', async (mode) => {
      const invocation: RunnerInvocation = mode === 'source'
        ? [process.execPath, '--import', 'tsx/esm', sourceRunner]
        : [process.execPath, builtRunner]
      expect(runnerInvocationAvailable(invocation)).toBe(true)
      await blockingStdioProof(invocation)
    }, 30_000,
  )

  it('executes the source entry through the provider-owned core', async () => {
    const result = await execute([process.execPath, '--import', 'tsx/esm', sourceRunner])
    expect(result).toEqual({
      status: 0,
      stdout: `${process.execPath}|${repoRoot}|target-collision-restored`,
      stderr: '',
    })
  }, 30_000)

  it.skipIf(!existsSync(builtRunner))('executes the built ./runner subpath through the same core', async () => {
    const invocation: RunnerInvocation = [process.execPath, builtRunner]
    expect(runnerInvocationAvailable(invocation)).toBe(true)
    const result = await execute(invocation)
    expect(result).toEqual({
      status: 0,
      stdout: `${process.execPath}|${repoRoot}|target-collision-restored`,
      stderr: '',
    })
  }, 30_000)
})
