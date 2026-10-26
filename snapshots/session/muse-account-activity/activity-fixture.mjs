/** Live root input reaches the production activity observer; only the external gateway is replaced. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { mountMuseActivity } = await importSnapshotModule(
  new URL('../../../packages/host/muse-account/src/activity.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/activity.js', import.meta.url),
)
const { writeMuseSession } = await importSnapshotModule(
  new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url),
)

export const name = 'snapshot-muse-account-activity'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-activity-snapshot-'))
  const sessionFile = join(home, 'session.json')
  const baseUrl = 'https://activity.invalid'
  await writeMuseSession(sessionFile, { baseUrl, username: 'fixture-user', cookie: '__Host-muse=activity-fixture' })
  let resolveReport
  const reported = new Promise(resolve => { resolveReport = resolve })
  const requests = []
  const owner = ctx.plugin({ name: 'snapshot-owned-muse-activity', apply(scope) {
    mountMuseActivity(scope, { baseUrl, sessionFile, reportIntervalMs: 30_000, requestTimeoutMs: 1000,
      fetcher: async (url, init) => {
        const headers = new Headers(init.headers)
        requests.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body),
          headerNames: [...headers.keys()], sameOrigin: headers.get('origin') === baseUrl,
          authenticated: headers.get('cookie') === '__Host-muse=activity-fixture', redirect: init.redirect })
        resolveReport()
        return new Response(null, { status: 204 })
      },
    })
  } })
  await owner
  let finished = false
  const tasks = []
  ctx.on('session/event', (_session, event) => {
    if (finished || event.type !== 'turn/end') return
    finished = true
    tasks.push((async () => {
      let timeout
      try {
        await Promise.race([reported, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('No root human activity report')), 5000)
        })])
      } finally { clearTimeout(timeout) }
      await owner.dispose()
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0].body, { activity: 'task-start' })
      await writeFile(join(process.cwd(), 'activity-probe.json'), JSON.stringify({ requests }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    })())
  })
  ctx.effect(() => async () => {
    await Promise.all(tasks)
    await owner.dispose()
    await rm(home, { recursive: true, force: true })
  })
}
