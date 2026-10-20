/** Real Chromium output from the shipped sandbox preload; fake output keeps automation silent. */
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { pathToFileURL } from 'node:url'

const [preload, ipcModule, userData, outputOption] = process.argv.slice(2)
if (preload === undefined || ipcModule === undefined || userData === undefined
  || (outputOption !== undefined && outputOption !== '--real-audio-output')) {
  throw new Error('expected <built-preload-app.cjs> <built-ipc.js> <userDataDir> [--real-audio-output]')
}

app.setPath('userData', userData)
app.setAppLogsPath(`${userData}/logs`)
// Chromium AudioManagerBase routes this switch through FakeAudioOutputStream, which still pulls PCM.
// https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/audio/audio_manager_base.cc
if (outputOption !== '--real-audio-output') app.commandLine.appendSwitch('disable-audio-output')
const applicationScheme = 'dsh-app'
protocol.registerSchemesAsPrivileged([{ scheme: applicationScheme, privileges: { standard: true, secure: true } }])

const document = '<!doctype html><html lang="en" data-ds-theme-source="light"><head><meta charset="utf-8"><title>Attention audio fixture</title></head><body></body></html>'
const timeoutMs = 10_000
const quietMs = 1_000

/** Wait for a Chromium audio-state transition, observing the independent current-state getter. */
function audioState(contents, audible) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(deadline)
      contents.off('audio-state-changed', changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = event => {
      if (event.audible === audible && contents.isCurrentlyAudible() === audible) finish()
    }
    const deadline = setTimeout(() => finish(new Error(`audio did not become ${audible ? 'audible' : 'silent'}`)), timeoutMs)
    contents.on('audio-state-changed', changed)
    if (contents.isCurrentlyAudible() === audible) finish()
  })
}

/** Require a full quiet interval, restarting it if Chromium reports more output. */
function quiet(contents) {
  return new Promise((resolve, reject) => {
    let settled
    const finish = error => {
      clearTimeout(deadline)
      clearTimeout(settled)
      contents.off('audio-state-changed', changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = () => {
      clearTimeout(settled)
      if (!contents.isCurrentlyAudible()) settled = setTimeout(() => finish(), quietMs)
    }
    const deadline = setTimeout(() => finish(new Error('audio did not remain silent')), timeoutMs)
    contents.on('audio-state-changed', changed)
    changed()
  })
}

/** Observe native visibility and minimize state without sending any input or user activation. */
function windowState(window, event, change, matches) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(deadline)
      window.off(event, changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = () => { if (matches()) finish() }
    const deadline = setTimeout(() => finish(new Error(`window did not reach ${event}`)), timeoutMs)
    window.on(event, changed)
    try { change(); changed() }
    catch (error) { finish(error) }
  })
}

/** Reload the real document and wait for its new sandbox preload to finish loading. */
function reload(contents) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(deadline)
      contents.off('did-finish-load', loaded)
      contents.off('did-fail-load', failed)
      if (error) reject(error)
      else resolve()
    }
    const loaded = () => finish()
    const failed = (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) finish(new Error(`reload failed: ${description} (${code})`))
    }
    const deadline = setTimeout(() => finish(new Error('reloaded preload did not finish loading')), timeoutMs)
    contents.on('did-finish-load', loaded)
    contents.on('did-fail-load', failed)
    try { contents.reload() }
    catch (error) { finish(error) }
  })
}

async function run() {
  const { DESKTOP_IPC, SCHEME } = await import(pathToFileURL(ipcModule).href)
  const { MANDATORY_IPC } = await import(new URL('./mandatory-update-ipc.js', pathToFileURL(ipcModule)).href)
  if (SCHEME !== applicationScheme) throw new Error(`unexpected Desktop scheme ${SCHEME}`)
  await app.whenReady()
  protocol.handle(SCHEME, request => new URL(request.url).hostname === 'app'
    ? new Response(document, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('Not found', { status: 404 }))
  // The real Windows preload reads this policy once; this fixture supplies no credentials or Host.
  ipcMain.handle(MANDATORY_IPC.status, () => ({ policy: { blocking: false } }))
  const window = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  const contents = window.webContents
  const errors = []
  const transitions = []
  contents.on('audio-state-changed', event => {
    transitions.push(event.audible)
    if (event.audible !== contents.isCurrentlyAudible()) errors.push('Chromium audio event disagreed with current output state')
  })
  contents.on('preload-error', (_event, _path, error) => { errors.push(String(error)) })
  contents.on('render-process-gone', (_event, details) => { errors.push(`renderer exited: ${details.reason}`) })
  contents.on('console-message', details => {
    if (details.level === 'error' || details.message.startsWith('desktop attention audio:')) errors.push(details.message)
  })
  const states = ['evidence=chromium-software-audio-output']
  const cue = async (name, kind) => {
    const audible = audioState(contents, true)
    contents.send(DESKTOP_IPC.attentionSound, kind)
    await audible
    await audioState(contents, false)
    await quiet(contents)
    states.push(`${name}=rendered-then-silent`)
  }
  try {
    await window.loadURL(`${SCHEME}://app/`)
    await windowState(window, 'show', () => window.showInactive(), () => window.isVisible())
    await cue('first-complete', 'complete')
    // A read with userGesture=false must not unlock playback in the isolated preload.
    if (await contents.executeJavaScript('navigator.userActivation.hasBeenActive', false) !== false) {
      throw new Error('attention fixture unexpectedly acquired user activation')
    }
    states.push('user-activation=absent')
    await cue('question', 'question')

    await windowState(window, 'hide', () => window.hide(), () => !window.isVisible())
    await cue('hidden-complete', 'complete')
    if (window.isVisible()) throw new Error('hidden cue showed its window')

    await windowState(window, 'show', () => window.showInactive(), () => window.isVisible())
    if (process.platform === 'linux') {
      // A DISPLAY under xvfb does not guarantee a window manager that acknowledges minimize.
      states.push('minimized-question=skipped-linux-window-manager')
    } else {
      await windowState(window, 'minimize', () => window.minimize(), () => window.isMinimized())
      await cue('minimized-question', 'question')
      if (!window.isMinimized()) throw new Error('minimized cue restored its window')
      await windowState(window, 'restore', () => window.restore(), () => !window.isMinimized())
    }

    const rapid = audioState(contents, true)
    contents.send(DESKTOP_IPC.attentionSound, 'complete')
    await rapid
    for (const kind of ['question', 'complete', 'question']) contents.send(DESKTOP_IPC.attentionSound, kind)
    await audioState(contents, false)
    await quiet(contents)
    states.push('rapid-replacement=rendered-then-silent')

    const beforeReload = audioState(contents, true)
    contents.send(DESKTOP_IPC.attentionSound, 'complete')
    await beforeReload
    const previousTransitions = transitions.length
    await reload(contents)
    await quiet(contents)
    if (transitions.slice(previousTransitions).some(audible => audible)) throw new Error('reload replayed an earlier cue')
    states.push('reload=quiet-without-replay')
    await cue('after-reload-question', 'question')
    if (errors.length > 0) throw new Error(errors.join('\n'))
    await new Promise((resolve, reject) => {
      process.stdout.write(`ATTENTION_AUDIO_RESULT ${JSON.stringify(states)}\n`, error => error ? reject(error) : resolve())
    })
  } catch (error) {
    if (errors.length > 0) throw new AggregateError([error, ...errors.map(message => new Error(message))], 'Attention audio smoke failed')
    throw error
  } finally {
    if (!window.isDestroyed()) window.destroy()
    protocol.unhandle(SCHEME)
    ipcMain.removeHandler(MANDATORY_IPC.status)
  }
}

run().then(() => { app.quit() }, error => {
  console.error(`ATTENTION_AUDIO_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  app.exit(1)
})
