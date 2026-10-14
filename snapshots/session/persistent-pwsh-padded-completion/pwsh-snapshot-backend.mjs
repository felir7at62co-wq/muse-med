/** Scripted terminal frames exercise PowerShell startup, completion extraction, and the Session log. */

import { PassThrough } from 'node:stream'
import { BashTerminalBackend, Config, PWSH_PROMPT_SETUP } from '@deepseek-ai/dsh-terminal-bash'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'

const responses = [
  { token: 'PWSH_OK', code: 0 },
  { token: 'PWSH_FAIL', code: 7 },
]

class SnapshotSession {
  motd = ''
  statusValue = { kind: 'running' }
  scrollback = ''
  next = 0
  startup = 0

  constructor(terminal) {
    this.terminal = terminal
  }

  startSend(request) {
    if (this.startup < 2) {
      const first = this.startup++ === 0
      const expected = first ? ENCODING_PREAMBLE + PWSH_PROMPT_SETUP : ''
      if (request.text !== expected || request.submit !== first) {
        throw new Error('PowerShell startup must submit setup once and wait through empty output')
      }
      const viewport = first ? '' : 'dsh> '
      this.scrollback += viewport
      return {
        done: Promise.resolve({
          viewport, waitReason: first ? 'inferred_idle' : 'stdin_read',
          sessionStatus: this.statusValue, truncated: false,
        }),
        readOutput: () => ({ delta: viewport, truncated: false }),
        cancel: () => false,
      }
    }
    const response = responses[this.next++]
    if (!response || !request.submit || !request.text.includes(`[Console]::Out.Write('  ${response.token}  ')`)) {
      throw new Error('unexpected padded-completion snapshot command')
    }
    const start = /__DSH_PERSISTENT_PWSH_START_[a-f0-9-]+__/.exec(request.text)?.[0]
    const end = /__DSH_PERSISTENT_PWSH_END_[a-f0-9-]+:/.exec(request.text)?.[0]
    if (!start || !end) throw new Error('padded-completion snapshot requires the actual command markers')
    const viewport = `${request.text}\r\n${start}\r\n  ${response.token}  ${end}${response.code}  \r\n${this.motd}`
    this.scrollback += viewport
    const result = { viewport, waitReason: 'stdin_read', sessionStatus: this.statusValue, truncated: false }
    let consumed = false
    return {
      done: Promise.resolve(result),
      readOutput: () => {
        if (consumed) return { delta: '', truncated: false }
        consumed = true
        return { delta: viewport, truncated: false }
      },
      cancel: () => false,
    }
  }

  read(request) {
    const lines = this.scrollback.split('\n')
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    const end = lines.length - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines: lines.length, lineBegin: offset, lineEnd: offset + text.split('\n').length, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  async close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    await this.terminal.terminate()
  }
}

/** Scenario-local fixture identity. */
export const name = 'pwsh-padded-completion-snapshot'
/** Terminal service owns the backend registration and sessions. */
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections']

/** Register deterministic completion frames under the real terminal service. @param ctx - Effect-scoped plugin context. */
export function apply(ctx) {
  const config = {
    ...Config({ shellDialect: 'pwsh', shellPath: 'pwsh' }),
    shellArgs: ['-NoLogo', '-NoProfile'],
  }
  ctx.terminals.registerBackend(new BashTerminalBackend(
    ctx,
    config,
    async () => {
      const output = new PassThrough()
      const done = Promise.withResolvers()
      return {
        pid: 1, output, done: done.promise,
        write: async () => {}, resize: async () => {},
        inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
        inspectForeground: async () => undefined,
        signalForeground: async () => undefined,
        terminate: async () => {
          output.end()
          done.resolve({ exitCode: 0, signal: null })
          await done.promise
        },
      }
    },
    terminal => new SnapshotSession(terminal),
  ))
}
