/** Keyless deletion inspection with empty history, complete task pages and zero remote mutations. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const name = 'delete-history-fixture'
export const inject = ['tools']
export const boards = [
  { id: 701, scriptId: 2708, episodeId: 35, storyboardName: 'Empty target', isGenerate: 1,
    modelConfig: null, storyboardMaterialList: [] },
  { id: 702, scriptId: 2708, episodeId: 35, storyboardName: 'Running child target', isGenerate: 1,
    modelConfig: JSON.stringify({ prompt: 'Offline running generation', duration: 10 }), storyboardMaterialList: [] },
]
export const parent = { id: 20, scriptId: 2708, episodeId: 999, taskType: 1, taskStatus: 'succeeded' }
export const detail = { id: 20, scriptId: 2708, taskStatus: 'succeeded' }
export const children = [
  { id: 200, aigcVideoTaskId: 20, scriptId: 2708, storyboardId: 703, taskStatus: 'succeeded' },
  { id: 201, aigcVideoTaskId: 20, scriptId: 2708, storyboardId: 702, taskStatus: 'running' },
]
export function apply(ctx) {
  const calls = []
  let deletes = 0
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://empty-history.invalid', 'No external traffic is permitted')
      const path = url.pathname.replace('/prod-api', '')
      const method = String(init?.method)
      calls.push({ method, path, page: Number(url.searchParams.get('pageNum') ?? 0) })
      if (method === 'DELETE') { deletes++; throw Error('Offline fixture refuses every DELETE') }
      const answer = data => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
      if (method === 'GET' && /^\/aigc\/storyboard\/(701|702)$/u.test(path)) {
        return answer(boards.find(board => board.id === Number(path.split('/').pop())))
      }
      if (method === 'GET' && /^\/aigc\/storyboard\/byStoryboard\/(701|702)$/u.test(path)) {
        return new Response(null, { status: 200 })
      }
      if (path === '/admin/aigc/video/task/list' && method === 'GET') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        assert.equal(url.searchParams.get('pageSize'), '1')
        assert.equal(url.searchParams.get('orderByColumn'), 'createTime')
        assert.equal(url.searchParams.get('orderBy'), 'desc')
        const page = Number(url.searchParams.get('pageNum'))
        assert.ok(page === 1 || page === 2)
        return answer({ total: 2, rows: [page === 1 ? parent : { id: 21, scriptId: 2708, taskType: 2 }] })
      }
      if (path === '/admin/aigc/video/task/20' && method === 'GET') return answer(detail)
      if (path === '/admin/aigc/video/task/sub/list' && method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), { aigcVideoTaskId: '20' })
        assert.equal(url.searchParams.get('pageSize'), '1')
        assert.equal(url.searchParams.get('orderByColumn'), 'createTime')
        assert.equal(url.searchParams.get('orderBy'), 'desc')
        const page = Number(url.searchParams.get('pageNum'))
        assert.ok(page === 1 || page === 2)
        return answer({ total: 2, rows: [children[page - 1]] })
      }
      throw Error(`Unexpected offline deletion request ${method} ${path}`)
    }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
    const result = id => {
      const message = messages.find(message => message.toolCallId === id)
      assert.ok(message, `Missing actual tool result ${id}`)
      return message
    }
    const parse = message => JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    const emptyMessage = result('call_delete_empty_preview'), activeMessage = result('call_delete_running_preview')
    assert.equal(emptyMessage.isError, false); assert.equal(activeMessage.isError, false)
    const empty = parse(emptyMessage), active = parse(activeMessage)
    assert.equal(empty.status, 'inspection_required')
    assert.deepEqual(empty.targets.map(target => [target.storyboard_id, target.tasks, target.active_generation, target.has_generated_media]), [[701, [], false, false]])
    assert.equal(active.status, 'inspection_required')
    assert.equal(active.targets[0].storyboard_id, 702)
    assert.equal(active.targets[0].active_generation, true)
    assert.equal(active.targets[0].tasks[0].taskStatus, 'succeeded')
    assert.deepEqual(active.targets[0].tasks[0].subTaskList, children)
    const denial = result('call_delete_running_apply')
    assert.equal(denial.isError, true)
    assert.ok(denial.content.some(block => block.type === 'text' && block.text.includes('active generation')))
    const directory = join(agent.session.header.cwd, 'project', 'video_tasks')
    const prepared = (await readdir(directory)).sort()
    assert.equal(prepared.length, 2)
    for (const plan of [empty, active]) {
      const saved = JSON.parse(await readFile(plan.preview_path, 'utf8'))
      assert.equal(saved.fingerprint, plan.fingerprint)
      assert.deepEqual(saved.targets, plan.targets)
      assert.equal(saved.script_id, 2708)
    }
    assert.equal(calls.filter(call => call.path.includes('/byStoryboard/')).length, 3)
    assert.equal(calls.filter(call => call.path === '/admin/aigc/video/task/list').length, 12)
    assert.equal(calls.filter(call => call.path === '/admin/aigc/video/task/20').length, 3)
    assert.equal(calls.filter(call => call.path === '/admin/aigc/video/task/sub/list').length, 12)
    assert.equal(calls.filter(call => call.method !== 'GET' && !(call.method === 'POST' && call.path.endsWith('/task/sub/list'))).length, 0)
    assert.equal(deletes, 0)
    const probe = { realToolResults: 3, emptyTargetPreviewSaved: true, runningChildBelowSucceededParentDetected: true,
      runningTargetApplyRejected: true, completeProjectPagesRead: 12, completeChildPagesRead: 12,
      taskDetailsRead: 3, zeroByteHistoryReads: 3, stableProjectAndChildrenReread: true,
      readOnlyChildPostRequests: 12, remoteDeleteRequests: deletes, paidRequests: 0,
      survivingStoryboardIds: boards.map(board => board.id), actualPreparedFiles: prepared }
    await writeFile(join(agent.session.header.cwd, '_probe.json'), JSON.stringify(probe, null, 2) + '\n')
  })
}
