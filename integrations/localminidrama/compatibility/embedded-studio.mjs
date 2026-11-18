/** Report studio readiness and install the fixed, parent-approved Muse collaboration helper. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('LocalMiniDrama embedded studio patch does not match pinned source: frontweb/src/main.js')
  }
  return source.replace(before, after)
}

const embeddedStartup = `const museMountedApp = app.mount('#app')
const museEmbeddedReadiness = router.isReady().then(() => nextTick()).then(() => {
  if (!museMountedApp || !document.querySelector('#app > *') || window.parent === window) return
  const ready = { type: 'muse-localminidrama:ready', version: 1 }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || typeof event.data !== 'object' || event.data === null
      || event.data.type !== 'muse-localminidrama:ping' || event.data.version !== 1) return
    window.parent.postMessage(ready, event.origin === 'null' ? '*' : event.origin)
  })
  window.parent.postMessage(ready, '*')
}).catch(() => {
  console.warn('Muse studio embedding did not become ready')
})
`

/**
 * Add readiness messages after Vue and its initial route have rendered.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read the latest staged source at an absolute path.
 * @returns Absolute filenames paired with their complete replacement source.
 */
export function planEmbeddedStudio(root, readSource = path => readFileSync(path, 'utf8')) {
  const path = resolve(root, 'frontweb/src/main.js')
  let source = readSource(path).replaceAll('\r\n', '\n')
  source = replaceOnce(source, "import { createApp, h } from 'vue'", "import { createApp, h, nextTick } from 'vue'")
  source = replaceOnce(source, "\napp.mount('#app')\n", '\n' + embeddedStartup)
  return [[path, source], [resolve(root, 'frontweb/src/utils/museStudioBridge.js'),
    readFileSync(new URL('./muse-studio-bridge.client.mjs', import.meta.url), 'utf8')]]
}
