import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessCollectedOutputs, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { bundledRulesDirectory, pythonRules } from '../src/rules.ts'
import type { RulesShot, RulesShotResult } from '../src/types.ts'

const PYTHON = 'fixture-python'
const SHOT: RulesShot = {
  key: 'shot-1', audio_sha256: 'f'.repeat(64), words: [], lines: ['林晨回家'], names: ['林晨'], decisions: [], flags: [],
}
const RESULT: RulesShotResult = {
  key: SHOT.key, cues: [{ start: 0.2, end: 1.4, text: '林晨回家' }], items: [], pending: 0,
}

function reader(text: string, lossy = false) {
  return { readFrom: vi.fn((_offset: number) => ({ text, nextOffset: Buffer.byteLength(text), lossy })) }
}

function handle(collected: SubprocessCollectedOutputs, overrides: Partial<SubprocessHandle> = {}): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected,
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(),
    waitForExit: () => Promise.resolve(true), ...overrides,
  }
}

async function setup() {
  const spawn = vi.fn<SubprocessRuntime['spawn']>()
  class FixtureSubprocess extends SubprocessRuntime {
    spawn = spawn
    resolveExecutable(): never { throw new Error('Unexpected executable lookup') }
    terminalEnvironment(): never { throw new Error('Unexpected terminal lookup') }
    spawnTerminal(): never { throw new Error('Unexpected terminal spawn') }
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FixtureSubprocess)
  const directory = bundledRulesDirectory()
  const python = vi.fn(() => Promise.resolve(PYTHON))
  const rules = pythonRules({
    subprocess: ctx.subprocess, directory, python, maxChars: 14, spaceWidth: 0.5, timeoutMs: 30_000, graceMs: 200, maxOutputBytes: 4096,
  })
  return { rules, spawn, directory, python }
}

it('skips interpreter resolution and spawning for an empty shot list', async () => {
  const { rules, spawn, python } = await setup()
  await expect(rules.run([])).resolves.toEqual([])
  expect(python).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('reads a complete matching Unicode result after the managed range exits', async () => {
  const { rules, spawn, directory } = await setup()
  const digest = rules.digest()
  expect(rules.digest()).toBe(digest)
  await expect(digest).resolves.toMatch(/^[0-9a-f]{64}$/u)
  const stdout = reader(JSON.stringify({ rules_sha256: await digest, shots: [RESULT] }))
  const waitEntered = Promise.withResolvers<undefined>()
  const rangeExit = Promise.withResolvers<boolean>()
  spawn.mockReturnValue(handle({ stdout }, {
    waitForExit: () => {
      waitEntered.resolve(undefined)
      return rangeExit.promise
    },
  }))

  const caller = new AbortController()
  const pending = rules.run([SHOT], caller.signal)
  try {
    await Promise.race([waitEntered.promise, pending])
    expect(stdout.readFrom).not.toHaveBeenCalled()
    const spec = spawn.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      argv: [PYTHON, '-B', '-I', '-X', 'utf8', join(directory, 'run.py')], cwd: directory, graceMs: 200,
      stdio: { stdin: { data: JSON.stringify({ max_chars: 14, space_width: 0.5, shots: [SHOT] }) },
        stdout: { maxBytes: 4096 }, stderr: { maxBytes: 65_536 } },
    })
    expect(spec?.signal).toBeInstanceOf(AbortSignal)
    expect(spec?.signal).not.toBe(caller.signal)
  } finally {
    rangeExit.resolve(true)
    await expect(pending).resolves.toEqual([RESULT])
  }
  expect(stdout.readFrom).toHaveBeenCalledExactlyOnceWith(0)
})

it.each([
  ['missing', { stderr: reader('  provider refused the launch  ') }, 'provider refused the launch'],
  ['truncated', { stdout: reader(JSON.stringify({ shots: [RESULT] }), true) }, '没有诊断输出'],
  ['blank', { stdout: reader('  '), stderr: reader('  ') }, '没有诊断输出'],
] as const)('refuses %s output and reports a bounded diagnostic', async (_kind, collected, diagnostic) => {
  const { rules, spawn } = await setup()
  spawn.mockReturnValue(handle(collected))
  const pending = rules.run([SHOT])
  await expect(pending).rejects.toMatchObject({ code: 'EPISODE_SUBTITLES_RULES_UNAVAILABLE' })
  await expect(pending).rejects.toThrow(diagnostic)
})

it('identifies the configured interpreter when Python reports a missing pronunciation dictionary', async () => {
  const { rules, spawn } = await setup()
  spawn.mockReturnValue(handle({
    stdout: reader(JSON.stringify({ error: { code: 'pypinyin_missing', message: '缺少固定版本的拼音词典' } })),
  }))
  await expect(rules.run([SHOT])).rejects.toMatchObject({
    code: 'EPISODE_SUBTITLES_RULES_UNAVAILABLE', message: '字幕规则无法运行（Python：fixture-python）：缺少固定版本的拼音词典',
  })
})

it.each([
  ['stale digest', { rules_sha256: 'outdated' }], ['missing shot array', { shots: null }], ['wrong shot count', { shots: [] }],
] as const)('rejects a response with %s', async (_case, patch) => {
  const { rules, spawn } = await setup()
  const result = { rules_sha256: await rules.digest(), shots: [RESULT], ...patch }
  spawn.mockReturnValue(handle({ stdout: reader(JSON.stringify(result)) }))
  await expect(rules.run([SHOT])).rejects.toMatchObject({ code: 'EPISODE_SUBTITLES_RULES_MISMATCH' })
})

it('propagates caller cancellation only after the managed range exits', async () => {
  const { rules, spawn } = await setup()
  const caller = new AbortController()
  const reason = new Error('closed the subtitle request')
  const stdout = reader('')
  const waitForExit = vi.fn(() => {
    caller.abort(reason)
    return Promise.resolve(true)
  })
  spawn.mockReturnValue(handle({ stdout }, { waitForExit }))
  await expect(rules.run([SHOT], caller.signal)).rejects.toBe(reason)
  expect(waitForExit).toHaveBeenCalledOnce()
  expect(spawn.mock.calls[0]?.[0].signal?.reason).toBe(reason)
  expect(stdout.readFrom).not.toHaveBeenCalled()
})

it('reports the rules deadline and identifies the interpreter before reading output', async () => {
  const { rules, spawn } = await setup()
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  onTestFinished(() => { timeout.mockRestore() })
  const stdout = reader('')
  spawn.mockImplementation(() => {
    deadline.abort()
    return handle({ stdout })
  })
  await expect(rules.run([SHOT])).rejects.toMatchObject({
    code: 'EPISODE_SUBTITLES_RULES_TIMEOUT', message: '字幕规则超过 30000 毫秒未完成（Python：fixture-python）。',
  })
  expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000)
  expect(stdout.readFrom).not.toHaveBeenCalled()
})

it('joins the managed range when the subprocess provider rejects startup', async () => {
  const { rules, spawn } = await setup()
  const reason = new Error('interpreter no longer exists')
  const waitForExit = vi.fn(() => Promise.resolve(true))
  spawn.mockImplementation(() => handle({}, { done: Promise.reject(reason), waitForExit }))
  await expect(rules.run([SHOT])).rejects.toBe(reason)
  expect(waitForExit).toHaveBeenCalledOnce()
})
