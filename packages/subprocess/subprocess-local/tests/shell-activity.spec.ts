/** Real interactive shells preserve startup files and distinguish prompts from running jobs. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalActivity } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFailed } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { createProcessInspector } from '../src/process-inspector.ts'
import type { ProcessIdentity, ProcessInspector } from '../src/process-inspector.ts'
import { runShellActivityCase } from './shell-activity-lifecycle.ts'
import type { ShellActivityScope } from './shell-activity-lifecycle.ts'

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

function failureDiagnostics(scope: ShellActivityScope, label: string): ShellDiagnostics {
  const diagnostics: ShellDiagnostics = {
    phase: 'create shell', pid: undefined, activity: undefined,
    complete: undefined, tree: [], foreground: undefined, outputTail: '',
  }
  let frozen: ShellDiagnostics | undefined
  // Failure hooks run after teardown, whose process scans would overwrite the observations.
  scope.beforeCleanup(() => { frozen = structuredClone(diagnostics) })
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
      diagnostics.complete = undefined
      diagnostics.tree = []
      diagnostics.foreground = undefined
      const snapshot = inspector.snapshot()
      diagnostics.complete = snapshot.complete
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

async function shell(scope: ShellActivityScope, path: string, rc = '', envFile = '', diagnostics?: ShellDiagnostics) {
  const home = await scope.acquire(() => mkdtemp(join(tmpdir(), 'dsh-shell-activity-test-')), home => rm(home, { recursive: true, force: true }))
  await scope.run(() => writeFile(join(home, '.zshenv'), envFile))
  await scope.run(() => writeFile(join(home, '.zshrc'), `PROMPT='${PROMPT_MARKER} '\n${rc}\n`))
  await scope.run(() => writeFile(join(home, '.bashrc'), `PS1='${PROMPT_MARKER} '\n${rc}\n`))
  const ctx = new Context()
  scope.defer(async () => { await ctx.fiber.dispose() })
  if (diagnostics !== undefined) diagnostics.phase = 'load local subprocess runtime'
  await scope.run(() => ctx.plugin(LocalSubprocessRuntime))
  if (diagnostics !== undefined) {
    ;(ctx.subprocess as LocalSubprocessRuntime).terminalInspector = observedInspector(diagnostics)
    diagnostics.phase = 'allocate interactive terminal'
  }
  const handle = await scope.acquire(() => ctx.subprocess.spawnTerminal({ argv: [path, '-i'], cwd: home, env: { HOME: home, ZDOTDIR: home }, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 200, shellActivity: true, signal: scope.signal }), handle => handle.terminate())
  let output = ''
  handle.output.on('data', (data: Buffer) => {
    output += data.toString('utf8')
    if (diagnostics !== undefined) diagnostics.outputTail = output.slice(-4096)
  })
  if (diagnostics !== undefined) { diagnostics.pid = handle.pid; diagnostics.phase = 'wait for first prompt' }
  await scope.poll(() => { expect(output).toContain(PROMPT_MARKER) })
  const prompts = (): number => output.split(PROMPT_MARKER).length - 1
  const inspectActivity = async (): Promise<SubprocessTerminalActivity> => {
    scope.signal.throwIfAborted()
    const activity = await handle.inspectActivity()
    if (diagnostics !== undefined) diagnostics.activity = activity
    scope.signal.throwIfAborted()
    return activity
  }
  return {
    scope, write: (data: string) => scope.run(() => handle.write(data)), handle, home, prompts,
    output: () => output, inspectActivity, activity: async () => (await inspectActivity()).state,
  }
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
    await h.scope.poll(async () => {
      const activity = await h.inspectActivity()
      observed.push(`${activity.state}:${activity.revision}`)
      expect(activity.state).toBe(expected)
    })
  } catch (cause) {
    h.scope.signal.throwIfAborted()
    const prompts = h.prompts() - promptsBefore
    const samples = observed.length === 0 ? 'no sample' : summarizeSamples(observed)
    throw new Error(`${label === undefined ? 'terminal activity' : `terminal activity for "${label}"`} reported state:revision ${samples} with ${prompts} further prompt${prompts === 1 ? '' : 's'} instead of reaching ${expected}`, { cause })
  }
}

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))('Zsh terminal activity', () => {
  it('keeps silent foreground work, builtin loops, read, and background jobs busy until a new prompt is idle', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh')
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer', 'sleep 600 &']) {
      await h.write(`${command}\r`)
      await expectActivity(h, 'busy', command)
      await h.write(command.endsWith('&') ? 'kill %1\r' : '\x03')
      await expectActivity(h, 'idle', command)
    }
  }))

  it('does not confuse vared or multiline editing with a top-level empty prompt', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh')
    await expectActivity(h, 'idle')
    await h.write('value=abc; vared value\r')
    await expectActivity(h, 'busy')
    await h.write('\x03')
    await expectActivity(h, 'idle')
    await h.write('if true; then\r')
    await expectActivity(h, 'busy')
    await h.write('fi\r')
    await expectActivity(h, 'idle')
    await h.write('partial')
    expect(await h.activity()).toBe('unknown')
  }))

  it('preserves startup options and ZDOTDIR and supports noclobber status updates', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh', 'setopt noclobber\nprint RC-LOADED', 'print ENV-LOADED')
    expect(h.output()).toContain('ENV-LOADED')
    expect(h.output()).toContain('RC-LOADED')
    await expectActivity(h, 'idle')
    await h.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await h.scope.poll(() => { expect(h.output()).toContain(`DIRECTORY:${h.home}`) })
    await expectActivity(h, 'idle')
    expect(h.output()).not.toContain('file exists')
  }))

  it('protects a stopped job even after the shell returns to the prompt', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh')
    await expectActivity(h, 'idle')
    await h.write('sleep 600\r')
    await expectActivity(h, 'busy')
    await h.write('\x1a')
    await h.scope.poll(() => { expect(h.output()).toContain('suspended') })
    expect(await h.activity()).toBe('busy')
    await h.write('kill -KILL %1\r')
    await expectActivity(h, 'idle')
  }))

  it('refuses idle evidence when custom signal traps may run without terminal input', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh', "trap ':' USR1")
    expect(await h.activity()).toBe('unknown')
    await h.write('trap - USR1\r')
    await expectActivity(h, 'idle')
  }))

  it('leaves disabled startup files disabled and restores ZDOTDIR immediately', async test => runShellActivityCase(test, async (scope) => {
    const h = await shell(scope, '/bin/zsh', 'print UNEXPECTED-RC', `unsetopt rcs\nPROMPT='${PROMPT_MARKER} '`)
    expect(h.output()).not.toContain('UNEXPECTED-RC')
    await h.write('print -r -- "DIRECTORY:$ZDOTDIR"\r')
    await h.scope.poll(() => { expect(h.output()).toContain(`DIRECTORY:${h.home}`) })
  }))
})

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))('Bash terminal activity', () => {
  it('preserves scalar prompt hooks and uses unknown on shells without PS0', async test => runShellActivityCase(test, async (scope) => {
    const diagnostics = failureDiagnostics(scope, 'Bash terminal activity failure')
    const h = await shell(scope, 'bash', "PROMPT_COMMAND='printf HOOK; # user comment'\nset -C", '', diagnostics)
    expect(h.output()).toContain('HOOK')
    diagnostics.phase = 'read Bash version'
    await h.write('printf "VERSION:%s\\n" "$BASH_VERSION"\r')
    await h.scope.poll(() => { expect(h.output()).toContain('VERSION:') })
    await h.scope.poll(() => { expect(/VERSION:\d+\.\d+/u.test(h.output())).toBe(true) })
    const version = /VERSION:(\d+)\.(\d+)/u.exec(h.output())
    const supported = Number(version?.[1]) > 4 || Number(version?.[1]) === 4 && Number(version?.[2]) >= 4
    if (!supported) { expect(await h.activity()).toBe('unknown'); return }
    diagnostics.phase = 'observe initial idle'
    await expectActivity(h, 'idle')
    for (const command of ['sleep 600', 'while :; do :; done', 'read answer']) {
      diagnostics.phase = `write ${command}`
      await h.write(`${command}\r`)
      diagnostics.phase = `observe busy for ${command}`
      await expectActivity(h, 'busy', command)
      diagnostics.phase = `write Ctrl-C for ${command}`
      await h.write('\x03')
      diagnostics.phase = `observe idle after Ctrl-C for ${command}`
      await expectActivity(h, 'idle', command)
    }
    expect(h.output()).not.toContain('syntax error')
    expect(h.output()).not.toContain('file exists')
  }))

})
