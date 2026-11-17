/** Replay the bundled sharing Skill against an isolated read-only provider. */
import assert from 'node:assert/strict'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'native-share-fixture'
export const inject = ['tools', 'llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless composition. */
export async function apply(ctx) {
  const dir = join(process.env.DSH_HOME, 'skills', 'jubian-project-upload')
  await mkdir(dir, { recursive: true })
  await copyFile(new URL('../../../packages/drama/skills/skills/jubian-project-upload/SKILL.md', import.meta.url), join(dir, 'SKILL.md'))
  const calls = []
  let skillObserved = false, targetsObserved = false, sharesObserved = false
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://project-share.invalid', 'Offline fixture rejects all external traffic')
      assert.equal(init?.method, 'GET', 'This snapshot never writes to the provider')
      const path = url.pathname.replace('/prod-api', '')
      calls.push(path)
      let body
      if (path === '/getInfo') body = { code: 200, data: { user: { userId: 7, userName: '离线编辑' }, permissions: ['aigc:share:add'] } }
      else if (path === '/system/user/getSelectUserList') {
        assert.equal(url.searchParams.get('dataType'), '3')
        body = { code: 200, data: [{ userId: 13, nickName: '林工' }, { userId: 14, nickName: '王编导' }] }
      } else if (path === '/aigc/script/list') {
        assert.equal(url.searchParams.get('pageNum'), '1')
        body = { code: 200, total: 1, rows: [{ id: 2708, scriptName: '离线剧变项目', canShare: 1 }] }
      } else if (path === '/aigc/share/list') {
        assert.equal(url.searchParams.get('scriptId'), '2708')
        assert.equal(url.searchParams.get('pageNum'), '1')
        assert.equal(url.searchParams.has('mineOnly'), false)
        body = { code: 200, total: 1, rows: [{ id: 91, scriptId: 2708, shareType: 2, shareTargetType: 1, shareUserId: 13, shareDeptId: null }] }
      } else throw new Error(`Unexpected offline request ${path}`)
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return () => { globalThis.fetch = originalFetch }
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools?.some(tool => tool.name === 'jubian_project'), 'Native project tool is discoverable by the model')
    for (const message of options.messages) {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.ok(!text.includes('offline-project-share-fixture'), 'Credential must not reach the model')
      if (message.role !== 'tool') continue
      if (message.toolCallId === 'call_native_skill') {
        assert.equal(message.isError, false)
        for (const term of ['share_targets', 'shares', 'share_preview', 'share_apply']) assert.ok(text.includes(term))
        skillObserved = true
      } else if (message.toolCallId === 'call_native_targets') {
        assert.equal(message.isError, false)
        const value = JSON.parse(text)
        assert.equal(value.actor_id, 7)
        assert.deepEqual(value.users, [{ id: 13, name: '林工' }, { id: 14, name: '王编导' }])
        targetsObserved = true
      } else if (message.toolCallId === 'call_native_shares') {
        assert.equal(message.isError, false)
        const value = JSON.parse(text)
        assert.equal(value.script_id, 2708); assert.equal(value.actor_id, 7)
        assert.equal(value.scope, 'provider_visible'); assert.equal(value.global_access_verified, false)
        assert.equal(value.rows[0].user_id, 13)
        sharesObserved = true
      }
    }
    yield* next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'jubian_project') assert.equal(skillObserved, true, 'Skill guidance reaches the model before sharing queries')
    return next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.ok(skillObserved && targetsObserved && sharesObserved)
    assert.ok(calls.includes('/system/user/getSelectUserList'))
    assert.ok(calls.includes('/aigc/script/list'))
    assert.ok(calls.includes('/aigc/share/list'))
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('offline-project-share-fixture'))
  })
  ctx.provide('snapshotNativeSkillReady', true)
}
