/** Real interactive shells preserve startup files and distinguish prompts from running jobs. */
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalActivity } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { createProcessInspector } from '../src/process-inspector.ts'
import type { ProcessIdentity, ProcessInspector } from '../src/process-inspector.ts'

const cleanups: Array<() => void | Promise<void>> = []
const diagnosticFreezes: Array<() => void> = []
afterEach(async () => {
  for (const freeze of diagnosticFreezes.splice(0)) freeze()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Prompt every startup file in this spec prints; its repeats count the prompts a shell reached. */
const PROMPT_MARKER = 'READY>'

interface ShellDiagnostics {
  phase: string
  pid: number | undefined
  activity: SubprocessTerminalActivity | undefined
  complete: boolean | undefined
  tree: readonly ProcessIdentity[]
  foreground: number | undefined
  outputTail: string
}

function failureDiagnostics(label: string): ShellDiagnostics {
  const diagnostics: ShellDiagnostics = {
    phase: 'create shell', pid: undefined, activity: undefined,
    complete: undefined, tree: [], foreground: undefined, outputTail: '',
  }
  let frozen: ShellDiagnostics | undefined
  // Failure hooks run after teardown, whose process scans would overwrite the observations.
  diagnosticFreezes.push(() => { frozen = structuredClone(diagnostics) })
  onTestFailed(() => { process.stderr.write(`${JSON.stringify({ event: 'bash-terminal-activity-failure', label, ...(frozen ?? diagnostics) })}\n`) })
  return diagnostics
}

function observedInspector(diagnostics: ShellDiagnostics): ProcessInspector {
  const inspector = createProcessInspector()
  return {
    foregroundPgid(pid) {
      const foreground = inspector.foregroundPgid(pid)
      diagnostics.foreground = foreground
      return foreground
    },
    isStdinWaiting: (pgid, pid) => inspector.isStdinWaiting(pgid, pid),
    snapshot() {
      const snapshot = inspector.snapshot()
      diagnostics.complete = snapshot.complete
      diagnostics.tree = []
      diagnostics.foreground = undefined
      return {
        ...snapshot.complete === undefined ? {} : { complete: snapshot.complete },
        tree(pid) {
          const tree = snapshot.tree(pid)
          diagnostics.tree = tree.slice(-16)
          return tree
        },
        session: pid => snapshot.session(pid),
        alive: identity => snapshot.alive(identity),
      }
    },
    isAlive: identity => inspector.isAlive(identity),
    signalGroup: (pgid, signal) => { inspector.signalGroup(pgid, signal) },
    signalProcess: (identity, signal) => { inspector.signalProcess(identity, signal) },
  }
}

async function shell(path: string, rc = '', envFile = '', diagnostics?: ShellDiagnostics) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shell-activity-test-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, '.zshenv'), envFile)
  await writeFile(join(home, '.zshrc'), `PROMPT='${PROMPT_MARKER} '\n${rc}\n`)
  await writeFile(join(home, '.bashrc'), `PS1='${PROMPT_MARKER} '\n${rc}\n`)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  if (diagnostics !== undefined) diagnostics.phase = 'load local subprocess runtime'
  await ctx.plugin(LocalSubprocessRuntime)
  if (diagnostics !== undefined) {
    ;(ctx.subprocess as LocalSubprocessRuntime).terminalInspector = observedInspector(diagnostics)
    diagnostics.phase = 'allocate interactive terminal'
  }
  const handle = await ctx.subprocess.spawnTerminal({ argv: [path, '-i'], cwd: home, env: { HOME: home, ZDOTDIR: home }, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 200, shellActivity: true })
  cleanups.push(() => handle.terminate())
  let output = ''
  handle.output.on('data', (data: Buffer) => {
    output += data.toString('utf8')
    if (diagnostics !== undefined) diagnostics.outputTail = output.slice(-4096)
  })
  if (diagnostics !== undefined) { diagnostics.pid = handle.pid; diagnostics.phase = 'wait for first prompt' }
  await expect.poll(() => output).toContain(PROMPT_MARKER)
  const prompts = (): number => output.split(PROMPT_MARKER).length - 1
  const inspectActivity = async (): Promise<SubprocessTerminalActivity> => {
    const activity = await handle.inspectActivity()
    if (diagnostics !== undefined) diagnostics.activity = activity
    return activity
  }
  return { handle, home, prompts, output: () => output, inspectActivity, activity: async () => (await inspectActivity()).state }
}

type Shell = Awaited<ReturnType<typeof shell>>

/** Collapse repeated samples and bound how many groups the message can carry. */
function summarizeSamples(samples: readonly string[]): string {
  const groups: Array<{ sample: string; count: number }> = []
  for (const sample of samples) {
    const last = groups.at(-1)
    if (last?.sample === sample) last.count += 1
    else groups.push({ sample, count: 1 })
  }
  const rendered = groups.map(group => group.count === 1 ? group.sample : `${group.sample} x${group.count}`)
  return rendered.length <= 8 ? rendered.join(' ') : `${rendered.slice(0, 6).join(' ')} … ${rendered.slice(-2).join(' ')}`
}

/**
 * Poll one activity expectation. A timeout names the sampled `state:revision` values, how many
 * prompts the shell printed while it waited, and keeps the original failure as cause. A prompt
 * in the window shows the shell returned to one; a count of zero shows none appeared while the
 * message waited. The samples are a bounded summary: the state record and the process
 * observation behind `unknown` are not exposed here.
 */
async function expectActivity(h: Shell, expected: SubprocessTerminalActivity['state'], label?: string): Promise<void> {
  const observed: string[] = []
  const promptsBefore = h.prompts()
  try {
    await expect.poll(async () => {
      const activity = await h.inspectActivity()
      observed.push(`${activity.state}:${activity.revision}`)
      return activity.state
    }).toBe(expected)
  } catch (cause) {
    const prompts = h.prompts() - promptsBefore
    const samples = observed.length === 0 ? 'no sample' : summarizeSamples(observed)
    throw new Error(`${label === undefined ? 'terminal activity' : `terminal activity for "${label}"`} reported state:revision ${samples} with ${prompts} further prompt${prompts === 1 ? '' : 's'} instead of reaching ${expected}`, { cause })
  }
}

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))('Zsh terminal activity', () => {
  it('keeps silent foreground work, builtin loops, read, and background jobs busy until a new prompt is idle', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer', 'sleep 600 &']) {
      await h.handle.write(`${command}\r`)
      await expectActivity(h, 'busy', command)
      await h.handle.write(command.endsWith('&') ? 'kill %1\r' : '\x03')
      await expectActivity(h, 'idle', command)
    }
  })

  it('does not confuse vared or multiline editing with a top-level empty prompt', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    await h.handle.write('value=abc; vared value\r')
    await expectActivity(h, 'busy')
    await h.handle.write('\x03')
    await expectActivity(h, 'idle')
    await h.handle.write('if true; then\r')
    await expectActivity(h, 'busy')
    await h.handle.write('fi\r')
    await expectActivity(h, 'idle')
    await h.handle.write('partial')
    expect(await h.activity()).toBe('unknown')
  })

  it('preserves startup options and ZDOTDIR and supports noclobber status updates', async () => {
    const h = await shell('/bin/zsh', 'setopt noclobber\nprint RC-LOADED', 'print ENV-LOADED')
    expect(h.output()).toContain('ENV-LOADED')
    expect(h.output()).toContain('RC-LOADED')
    await expectActivity(h, 'idle')
    await h.handle.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await expect.poll(() => h.output()).toContain(`DIRECTORY:${h.home}`)
    await expectActivity(h, 'idle')
    expect(h.output()).not.toContain('file exists')
  })

  it('protects a stopped job even after the shell returns to the prompt', async () => {
    const h = await shell('/bin/zsh')
    await expectActivity(h, 'idle')
    await h.handle.write('sleep 600\r')
    await expectActivity(h, 'busy')
    await h.handle.write('\x1a')
    await expect.poll(() => h.output()).toContain('suspended')
    expect(await h.activity()).toBe('busy')
    await h.handle.write('kill -KILL %1\r')
    await expectActivity(h, 'idle')
  })

  it('refuses idle evidence when custom signal traps may run without terminal input', async () => {
    const h = await shell('/bin/zsh', "trap ':' USR1")
    expect(await h.activity()).toBe('unknown')
    await h.handle.write('trap - USR1\r')
    await expectActivity(h, 'idle')
  })

  it('leaves disabled startup files disabled and restores ZDOTDIR immediately', async () => {
    const h = await shell('/bin/zsh', 'print UNEXPECTED-RC', `unsetopt rcs\nPROMPT='${PROMPT_MARKER} '`)
    expect(h.output()).not.toContain('UNEXPECTED-RC')
    await h.handle.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await expect.poll(() => h.output()).toContain(`DIRECTORY:${h.home}`)
  })
})

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))('Bash terminal activity', () => {
  it('preserves scalar prompt hooks and uses unknown on shells without PS0', async () => {
    const diagnostics = failureDiagnostics('Bash terminal activity failure')
    const h = await shell('bash', "PROMPT_COMMAND='printf HOOK; # user comment'\nset -C", '', diagnostics)
    expect(h.output()).toContain('HOOK')
    diagnostics.phase = 'read Bash version'
    await h.handle.write('printf "VERSION:%s\\n" "$BASH_VERSION"\r')
    await expect.poll(() => h.output()).toContain('VERSION:')
    await expect.poll(() => /VERSION:\d+\.\d+/u.test(h.output())).toBe(true)
    const version = /VERSION:(\d+)\.(\d+)/u.exec(h.output())
    const supported = Number(version?.[1]) > 4 || Number(version?.[1]) === 4 && Number(version?.[2]) >= 4
    if (!supported) { expect(await h.activity()).toBe('unknown'); return }
    diagnostics.phase = 'observe initial idle'
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer']) {
      diagnostics.phase = `write ${command}`
      await h.handle.write(`${command}\r`)
      diagnostics.phase = `observe busy for ${command}`
      await expectActivity(h, 'busy', command)
      diagnostics.phase = `write Ctrl-C for ${command}`
      await h.handle.write('\x03')
      diagnostics.phase = `observe idle after Ctrl-C for ${command}`
      await expectActivity(h, 'idle', command)
    }
    expect(h.output()).not.toContain('syntax error')
    expect(h.output()).not.toContain('file exists')
  })

  it.runIf(process.platform === 'linux')('observes Ctrl-C delivery across a gated Bash pre-dispatch transition', async () => {
    for (const interruptAt of ['pre-dispatch', 'command-ready'] as const) {
      const diagnostics = failureDiagnostics(`Bash Ctrl-C ${interruptAt} diagnostic`)
      const h = await shell('bash', [
        '__dsh_test_gate() {',
        '  if [[ -z ${__dsh_test_gate_installed-} ]]; then',
        '    __dsh_test_gate_installed=1',
        '    PS0="${PS0%)}; builtin printf \'GATE_ENTERED\\n\' >&2; IFS= builtin read -r __dsh_test_release < \\"\\$HOME/dispatch-gate\\")"',
        '  fi',
        '}',
        "PROMPT_COMMAND='__dsh_test_gate; printf HOOK; # user comment'",
        "stty isig echoctl intr '^C'",
        'set -C',
      ].join('\n'), '', diagnostics)
      const fifo = join(h.home, 'dispatch-gate')
      execFileSync('mkfifo', ['--', fifo])
      const gate = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)
      cleanups.push(() => { closeSync(gate) })
      const command = join(h.home, 'foreground.mjs')
      await writeFile(command, [
        "process.on('SIGINT', () => { process.stdout.write('COMMAND_INTERRUPTED\\n', () => { process.exit(0) }) })",
        'process.stdin.resume()',
        "process.stdout.write('COMMAND_READY\\n')",
      ].join('\n'))
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      const promptsBefore = h.prompts()
      diagnostics.phase = 'wait for PS0 gate'
      await h.handle.write(`${quote(process.execPath)} ${quote(command)}\r`)
      await expect.poll(() => h.output()).toContain('GATE_ENTERED')
      await expectActivity(h, 'busy', 'PS0 gate')
      expect(h.output()).not.toContain('COMMAND_READY')
      let signalsBeforeRelease: Array<{ pid: number; fields?: string[]; error?: string }> = []
      if (interruptAt === 'pre-dispatch') {
        diagnostics.phase = 'send Ctrl-C before command dispatch'
        await h.handle.write('\x03')
        // PTY echo confirms line-discipline processing before PS0 can finish.
        await expect.poll(() => h.output()).toContain('^C')
        signalsBeforeRelease = diagnostics.tree.map(({ pid }) => {
          try {
            const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
            return { pid, fields: status.split('\n').filter(line => /^(?:SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/u.test(line)) }
          } catch (error) {
            return { pid, error: error instanceof Error ? error.message : String(error) }
          }
        })
      }
      writeSync(gate, 'release\n')
      diagnostics.phase = 'wait for command start or a new prompt'
      await expect.poll(() => h.output().includes('COMMAND_READY') || h.prompts() > promptsBefore).toBe(true)
      const started = h.output().includes('COMMAND_READY')
      process.stdout.write(`${JSON.stringify({ event: 'bash-ctrl-c-gate', interruptAt, started, signalsBeforeRelease, output: h.output(), activity: diagnostics.activity })}\n`)
      if (interruptAt === 'command-ready') expect(started).toBe(true)
      if (started) {
        diagnostics.phase = 'send Ctrl-C after SIGINT handler readiness'
        await h.handle.write('\x03')
        await expect.poll(() => h.output()).toContain('COMMAND_INTERRUPTED')
      }
      diagnostics.phase = 'observe idle after gated command'
      await expectActivity(h, 'idle', 'gated command')
    }
  })
})
