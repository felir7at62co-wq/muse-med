/** Start the local OpenChatCut workbench with the built Muse development desktop. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const directory = process.env.MUSE_OPENCHATCUT_DIR
const origin = new URL(process.env.MUSE_OPENCHATCUT_ORIGIN ?? 'http://127.0.0.1:19843')
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.href !== origin.origin + '/') {
  throw Error('Choose an HTTP address on 127.0.0.1 with an explicit editor port.')
}
if (!directory || !existsSync(resolve(directory, 'scripts/dev-profile.mjs')) || !existsSync(resolve(directory, 'node_modules/vite/package.json'))) {
  throw Error('Point MUSE_OPENCHATCUT_DIR at the installed OpenChatCut checkout.')
}

const owned = new Set()
const shutdown = new AbortController()
let interruptedStatus = 0
function launch(command, args, cwd, env) {
  shutdown.signal.throwIfAborted()
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' })
  owned.add(child)
  const finished = new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  }).finally(() => owned.delete(child))
  return { child, finished }
}

function stop() {
  for (const child of owned) {
    if (!child.pid) continue
    try {
      if (process.platform === 'win32') child.kill()
      else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

async function available() {
  try {
    const page = await fetch(origin, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(1500)]), redirect: 'error' })
    if (!page.ok || !(await page.text()).includes('<title>OpenChatCut</title>')) {
      throw Error('The editor port is in use by another application.')
    }
    return true
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false
    throw error
  }
}

function interrupt(status) {
  interruptedStatus = status
  shutdown.abort()
  stop()
}

process.once('SIGINT', () => interrupt(130))
process.once('SIGTERM', () => interrupt(143))
try {
  let service
  if (!await available()) {
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SYSTEMROOT', 'CC_BROWSER_EXECUTABLE']
        .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    service = launch(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:isolated', '--', '--host', origin.hostname, '--port', origin.port, '--strictPort'],
      directory, { ...env, BROWSER: 'none', OPENCHATCUT_EDITOR_URL: origin.origin,
        OPENCHATCUT_DATA_DIR: process.env.OPENCHATCUT_DATA_DIR ?? resolve(directory, '.artifacts/studio-data') })
    let exited = false
    const stopped = service.finished.then(() => { exited = true })
    const deadline = Date.now() + 90_000
    while (!await available()) {
      if (exited) throw Error('OpenChatCut exited before serving the editor.')
      if (Date.now() >= deadline) throw Error('OpenChatCut did not start within 90 seconds.')
      await Promise.race([stopped, delay(500, undefined, { signal: shutdown.signal })])
    }
  }
  const desktop = launch(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'start:desktop'], repo,
    { ...process.env, MUSE_OPENCHATCUT_ORIGIN: origin.origin })
  process.exitCode = await (service ? Promise.race([desktop.finished, service.finished.then(() => 1)]) : desktop.finished)
} catch (error) {
  if (!shutdown.signal.aborted) throw error
} finally {
  stop()
  if (interruptedStatus) process.exitCode = interruptedStatus
}
