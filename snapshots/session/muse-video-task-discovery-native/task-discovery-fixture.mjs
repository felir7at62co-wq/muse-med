/** Offline task discovery retains a known task and original intent after an empty provider list. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const { JubianLedger } = await importSnapshotModule(new URL('../../../packages/jubian/jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/jubian/lib/index.js', import.meta.url))
export const name = 'task-discovery-fixture'
export const inject = ['llm', 'tools']

/** @param ctx - Headless profile services. @param config - Native or PTC execution assertion. */
export async function apply(ctx, config = {}) {
  const ledger = new JubianLedger({ root: join(process.env.DSH_HOME, 'jubian', 'ledger') })
  const requests = [], observed = [], dispatches = []
  const known = { id: 749810, scriptId: 5933, episodeId: 130172, taskStatus: 'succeeded', taskName: 'EP01-P3' }
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1793944800000] : args)) }
      static now() { return 1793944800000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = String(init?.method)
      requests.push({ method, path: url.pathname.replace('/prod-api', '') + url.search })
      assert.equal(url.hostname, 'task-discovery.invalid', 'Offline discovery refuses external traffic')
      assert.equal(method, 'GET', 'Discovery cannot submit paid or state-changing requests')
      let data
      if (url.pathname.endsWith('/admin/aigc/video/task/749810')) data = known
      else {
        assert.ok(url.pathname.endsWith('/admin/aigc/video/task/list'))
        assert.equal(url.searchParams.get('scriptId'), '5933')
        data = { total: 0, rows: [] }
      }
      return new Response(JSON.stringify({ code: 200, data }))
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
  await ledger.begin({ idempotencyKey: 'known-original-video-key', method: 'storyboard_generate',
    scriptId: 5933, requestSha256: 'original-request', beforeTaskIds: [] })
  const originalRecords = await ledger.records()
  const originalFiles = await Promise.all((await ledger.files()).map(async path => ({ path, bytes: await readFile(path, 'utf8') })))
  let calls = 0
  ctx.on('llm/stream', async function* (options, next) {
    if (config.ptc) assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    else {
      const tool = options.tools.find(tool => tool.name === 'jubian_video')
      assert.ok(tool)
      assert.ok(tool.parameters.properties.task_type)
      assert.ok(tool.description.includes('不保证提供方保留全部历史') || tool.description.includes('提供方列表'))
    }
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, calls)
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].isError, false, JSON.stringify(results[i]))
      const text = results[i].content.filter(block => block.type === 'text').map(block => block.text).join('')
      const value = JSON.parse(text)
      if (i < 2) {
        assert.equal(value.tasks.total, 0)
        assert.deepEqual(value.tasks.rows, [])
        assert.deepEqual(value.tasks.scope, { script_id: 5933, task_type: i === 0 ? 1 : null })
        assert.equal(value.tasks.complete, true)
        assert.equal(value.tasks.project_complete, i === 1)
        assert.equal(value.tasks.total_verified, true)
        assert.ok(value.guidance.includes('不保证保留全部历史'))
      } else if (i === 2) assert.equal(value.task.task_id, 749810)
      else assert.equal(value.unresolved[0].idempotency_key, 'known-original-video-key')
      if (i === calls - 1) observed.push(value)
    }
    calls++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/ptc-dispatch') dispatches.push({ name: event.data.name, isError: event.data.isError })
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(calls, 5)
    assert.equal(observed.length, 4)
    assert.deepEqual(requests, [
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=5933&taskType=1&pageNum=1&pageSize=20' },
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=5933&pageNum=1&pageSize=20' },
      { method: 'GET', path: '/admin/aigc/video/task/749810' },
    ])
    assert.deepEqual(await ledger.records(), originalRecords)
    assert.deepEqual(await ledger.files(), originalFiles.map(file => file.path))
    for (const file of originalFiles) assert.equal(await readFile(file.path, 'utf8'), file.bytes)
    if (config.ptc) assert.deepEqual(dispatches, Array.from({ length: 4 }, () => ({ name: 'jubian_video', isError: false })))
    const wire = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(wire.length, 4)
    const proof = { executor: config.ptc ? 'ptc' : 'native', requests, filteredProjectComplete: false,
      unfilteredProjectComplete: true, providerListOnly: true, knownTaskId: observed[2].task.task_id,
      originalKeys: originalRecords.map(record => record.idempotency_key), originalLedgerBytesUnchanged: true,
      loggedResultsSeenByNextModel: observed.length, ptcDispatches: dispatches.length, paidPUTs: 0, paidPOSTs: 0 }
    await writeFile(join(agent.session.header.cwd, 'task-discovery-proof.json'), JSON.stringify(proof, null, 2) + '\n')
  })
}
