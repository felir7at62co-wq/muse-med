/** The owned video command over the sandbox and subprocess service contracts, plus real process output. */
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished } from 'vitest'
import { command } from '../src/media.ts'

/** One captured confinement request from the sandbox seam. */
interface ConfinementRequest {
  readonly argv: readonly string[]
  readonly mode: string
  readonly workspaceRoot: string
  readonly signal: AbortSignal | undefined
}

/** Output limits wide enough for every fixture command below. */
const bounds = { commandTimeoutMs: 10_000, graceMs: 1000, maxOutputBytes: 1024 }
const unconfined = { mode: 'danger-full-access', workspaceRoot: process.cwd() } as const

/**
 * A provider shape this command must survive: the service contract makes stdout
 * optional, chunks may arrive as text, and a provider may expose no collected
 * diagnostics at all.
 */
type ProviderArm = 'no-stdout' | 'text-chunks' | 'no-diagnostics'

/**
 * Build the subprocess provider implementing one contract arm above.
 * @param arm - Which optional provider capability stays absent.
 * @param cleanup - Receives the teardown calls the command must still make.
 * @returns A provider class usable as this context's `subprocess` service.
 */
function providerFor(arm: ProviderArm, cleanup: string[]) {
  return class ContractRuntime extends SubprocessRuntime {
    async resolveExecutable(name: string): Promise<string> { return name }
    async terminalEnvironment(): Promise<never> { throw Error('This runtime allocates no terminal environment') }
    async spawnTerminal(): Promise<never> { throw Error('This runtime allocates no terminal') }
    spawn(): SubprocessHandle {
      return {
        stdout: arm === 'no-stdout' ? undefined
          : Readable.from([arm === 'text-chunks' ? 'text provider output' : Buffer.from('bytes')]),
        stdin: undefined, stderr: undefined, control: undefined,
        collected: arm === 'no-diagnostics' ? {}
          : { stderr: { readFrom: () => ({ text: 'analyzer diagnostic', nextOffset: 18, lossy: false }) } },
        done: Promise.resolve({ exitCode: arm === 'no-diagnostics' ? 7 : 0, signal: null }),
        terminate() { cleanup.push('terminate') },
        async waitForExit() { cleanup.push('wait'); return true },
      }
    }
  }
}

it('spawns only the argv the sandbox seam confines and keeps its real binary output', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Subprocess).await()
  const asked: ConfinementRequest[] = []
  /** Confinement that really runs: the returned argv is the confined one this host executes. */
  class Confinement extends SandboxProvider {
    async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      asked.push({ argv, mode: policy.mode, workspaceRoot: policy.workspaceRoot, signal })
      return { argv: [process.execPath, '-e', 'process.stdout.write("confined")', ...argv], enforcement: 'full',
        denialSignatures: [], runnerFailureRules: [] }
    }
  }
  await ctx.plugin(Confinement).await()
  const argv = [process.execPath, '-e', 'process.stdout.write("unconfined")']
  const bytes = await command(ctx, argv, { mode: 'workspace-write', workspaceRoot: process.cwd() },
    new AbortController().signal, bounds)
  expect(new TextDecoder().decode(bytes)).toBe('confined')
  expect(asked).toHaveLength(1)
  expect(asked[0]?.argv).toEqual(argv)
  expect(asked[0]).toMatchObject({ mode: 'workspace-write', workspaceRoot: process.cwd() })
  expect(asked[0]?.signal).toBeInstanceOf(AbortSignal)
})

it('rejects a provider command with no piped stdout and still joins its process', async () => {
  const cleanup: string[] = []
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(providerFor('no-stdout', cleanup)).await()
  await expect(command(ctx, ['analyzer'], unconfined, new AbortController().signal, bounds))
    .rejects.toThrow('Video process has no stdout stream')
  expect(cleanup).toEqual(['terminate', 'wait'])
})

it('rejects text chunks from a provider that yields no binary output and still joins its process', async () => {
  const cleanup: string[] = []
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(providerFor('text-chunks', cleanup)).await()
  await expect(command(ctx, ['analyzer'], unconfined, new AbortController().signal, bounds))
    .rejects.toThrow('Video process returned non-binary output')
  expect(cleanup).toEqual(['terminate', 'wait'])
})

it('reports a failed exit with an empty diagnostic when the provider collects no stderr', async () => {
  const cleanup: string[] = []
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(providerFor('no-diagnostics', cleanup)).await()
  await expect(command(ctx, ['analyzer'], unconfined, new AbortController().signal, bounds))
    .rejects.toThrow(/^Video process failed \(7\): $/u)
  expect(cleanup).toEqual(['terminate', 'wait'])
})
