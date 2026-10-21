/** Built completion controller with real Electron windows and a silent fake notification device. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const controller = fileURLToPath(new URL('../lib/types/completion-notice.js', import.meta.url))
const locale = fileURLToPath(new URL('../lib/types/locale.js', import.meta.url))
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

// Electron needs a display; xvfb does not supply a window manager for native minimize transitions.
it.skipIf(!hasDisplay)('keeps built completion notices silent and returns only after activation', { retry: 0 }, async () => {
  for (const path of [controller, locale]) {
    if (!existsSync(path)) throw new Error(`missing built Desktop artifact ${path}; build Desktop before this smoke`)
  }
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new Error('Electron executable is unavailable')
  const userData = await mkdtemp(join(tmpdir(), 'dsh-completion-notice-'))
  try {
    const fixture = fileURLToPath(new URL('./fixtures/completion-notice-smoke.mjs', import.meta.url))
    const result = await execa(electron, [fixture, controller, locale, userData], {
      // This smoke observes real foreground windows; SW_HIDE would suppress the first Windows ShowWindow call.
      env: { ELECTRON_RUN_AS_NODE: undefined }, windowsHide: false,
      timeout: 90_000, forceKillAfterDelay: 5_000, reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find(value => value.startsWith('COMPLETION_NOTICE_RESULT '))
    if (line === undefined) throw new Error(`Missing Electron completion result: ${result.stdout}\n${result.stderr}`)
    const observed: unknown = JSON.parse(line.slice('COMPLETION_NOTICE_RESULT '.length))
    if (!Array.isArray(observed) || !observed.every((value): value is string => typeof value === 'string')) {
      throw new Error('Invalid Electron completion result')
    }
    const expected = await readFile(new URL('./expected/completion-notice.txt', import.meta.url), 'utf8')
    const platformExpected = process.platform === 'linux'
      ? expected.replace('minimized=silent-without-restore\nminimized-click=restored-and-focused\n', 'minimized=skipped-linux-window-manager\n')
      : expected
    expect(observed.join('\n') + '\n').toBe(platformExpected)
  } finally {
    // execa has joined the exact owned Electron process, including timeout termination, before userData removal.
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
