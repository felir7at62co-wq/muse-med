/** Built sandbox preload smoke for Chromium audio output, without a Host or model. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const preload = fileURLToPath(new URL('../lib/preload-app.cjs', import.meta.url))
const ipc = fileURLToPath(new URL('../lib/types/ipc.js', import.meta.url))
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

// Linux Electron needs a display server; the fixture handles minimize separately because xvfb does not establish a window manager.
it.skipIf(!hasDisplay)('renders live attention cues without user activation and never replays them on reload', { retry: 0 }, async () => {
  for (const path of [preload, ipc]) {
    if (!existsSync(path)) throw new Error(`missing built Desktop artifact ${path}; build Desktop before this smoke`)
  }
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new Error('Electron executable is unavailable')
  const userData = await mkdtemp(join(tmpdir(), 'dsh-attention-audio-'))
  try {
    const fixture = fileURLToPath(new URL('./fixtures/attention-audio-smoke.mjs', import.meta.url))
    const realOutput = process.env.DSH_DESKTOP_ATTENTION_REAL_AUDIO === '1'
    const result = await execa(electron, [fixture, preload, ipc, userData, ...(realOutput ? ['--real-audio-output'] : [])], {
      env: { ELECTRON_RUN_AS_NODE: undefined },
      windowsHide: !realOutput,
      timeout: 90_000, forceKillAfterDelay: 5_000, reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find(value => value.startsWith('ATTENTION_AUDIO_RESULT '))
    if (line === undefined) throw new Error(`Missing Electron audio result: ${result.stdout}\n${result.stderr}`)
    const observed: unknown = JSON.parse(line.slice('ATTENTION_AUDIO_RESULT '.length))
    if (!Array.isArray(observed) || !observed.every((value): value is string => typeof value === 'string')) {
      throw new Error('Invalid Electron audio result')
    }
    const expected = await readFile(new URL('./expected/attention-audio.txt', import.meta.url), 'utf8')
    const platformExpected = process.platform === 'linux'
      ? expected.replace('minimized-question=rendered-then-silent\n', 'minimized-question=skipped-linux-window-manager\n')
      : expected
    expect(observed.join('\n') + '\n').toBe(platformExpected)
  } finally {
    // execa settles only after the owned Electron process exits, including timeout termination.
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
