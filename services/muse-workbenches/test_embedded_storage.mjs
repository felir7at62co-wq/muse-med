import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')

const source = name => readFile(new URL(name, import.meta.url), 'utf8')

test('an embedded account switch keeps the standalone site and second workbench signed in separately', async () => {
  const storage = await source('muse_storage.js')
  const login = await source('muse_login.js')
  const requestId = 'i'.repeat(43)
  let owner = 101
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const studio = path.startsWith('/fwp/') || path === '/sfp/'
    const base = studio ? '/fwp/v2/auth/muse' : '/v1/auth/muse'
    const publicOrigin = 'http://' + req.headers.host
    const send = (type, value) => { res.setHeader('Content-Type', type); res.end(value) }
    if (path.endsWith('/storage.js')) return send('text/javascript', storage)
    if (path.endsWith('/login.js')) return send('text/javascript', login)
    if (path.endsWith('/challenge')) return send('application/json', JSON.stringify({ requestId, challenge: 'c'.repeat(43) }))
    if (path.endsWith('/exchange')) return send('application/json', JSON.stringify({
      token: 'studio-' + owner, access_token: 'workshop-' + owner, refresh_token: 'refresh-' + owner, user: { id: owner },
    }))
    if (path === '/') return send('text/html', '<main></main>')
    if (path.endsWith('/embed')) return send('text/html',
      '<main data-parent="' + publicOrigin + '" data-prefix="' + base + '" data-audience="' + (studio ? 'jingliu' : 'script-workshop') +
      '"><button id="login">Muse</button><p id="message"></p></main><script src="' + base +
      '/storage.js"></script><script src="' + base + '/login.js" defer></script>')
    return send('text/html', '<head><script src="' + base + '/storage.js"></script></head><main>Workspace</main>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
  })
  try {
    const host = 'http://127.0.0.1:' + server.address().port
    const page = await browser.newPage()
    await page.goto(host)
    await page.evaluate(() => {
      localStorage.setItem('drama_access_token', 'independent')
      localStorage.setItem('sf_session_prod', 'independent-studio')
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.type !== 'muse-workbench-login') return
        event.source.postMessage({ type: 'muse-workbench-login-result', requestId: event.data.requestId, code: 'g'.repeat(43) }, event.origin)
      })
    })
    async function embed(name, path, result) {
      await page.evaluate(({ name, path }) => {
        document.querySelector('iframe[name="' + name + '"]')?.remove()
        const frame = document.createElement('iframe')
        frame.name = name
        frame.src = path
        document.body.append(frame)
      }, { name, path })
      const element = await page.locator('iframe[name="' + name + '"]').elementHandle()
      const frame = await element.contentFrame()
      await frame.waitForURL(host + result)
      return frame
    }
    let scripts = await embed('scripts', '/v1/auth/muse/embed', '/v2')
    assert.equal(await scripts.evaluate(() => localStorage.getItem('drama_access_token')), 'workshop-101')
    await scripts.evaluate(() => localStorage.setItem('editing-draft', 'previous user draft'))
    const studio = await embed('studio', '/fwp/v2/auth/muse/embed', '/sfp/')
    assert.equal(await studio.evaluate(() => localStorage.getItem('sf_session_prod')), 'studio-101')
    owner = 302
    scripts = await embed('scripts', '/v1/auth/muse/embed', '/v2')
    assert.deepEqual(await scripts.evaluate(() => [localStorage.getItem('drama_access_token'), localStorage.getItem('editing-draft')]), ['workshop-302', null])
    assert.equal(await studio.evaluate(() => localStorage.getItem('sf_session_prod')), 'studio-101')
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('drama_access_token'), localStorage.getItem('sf_session_prod')]), ['independent', 'independent-studio'])
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})
