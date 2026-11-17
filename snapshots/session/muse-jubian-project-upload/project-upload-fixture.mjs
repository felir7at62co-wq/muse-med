/** Replay bundled project-upload guidance and an offline manuscript registration-to-project flow. */
import assert from 'node:assert/strict'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { JubianLedger } = await importSnapshotPackage('@deepseek-ai/dsh-jubian',
  new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))

export const name = 'native-skill-fixture'
export const inject = ['tools', 'llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless composition. */
export async function apply(ctx) {
  const skillDirectory = join(process.env.DSH_HOME, 'skills', 'jubian-project-upload')
  await mkdir(skillDirectory, { recursive: true })
  await copyFile(new URL('../../../packages/drama/skills/skills/jubian-project-upload/SKILL.md', import.meta.url),
    join(skillDirectory, 'SKILL.md'))
  const calls = []
  const posts = new Map()
  const allowedPosts = new Set(['/script/center/pool/produceUpload', '/script/center/pool/startProduce'])
  const tagNames = { creationType: '原创', genre: '家庭', era: '现代', audience: '女性' }
  const manuscriptFile = { name: '离线家庭剧.docx', url: 'https://documents.invalid/manuscript.docx', objectKey: 'offline/manuscript.docx' }
  const originalFile = { name: '离线原著.docx', url: 'https://documents.invalid/original.docx', objectKey: 'offline/original.docx' }
  let instructionsReachedModel = false, tagOptionsReachedModel = false, filesReachedModel = false
  let registered = false, started = false
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://project-upload.invalid', 'Offline fixture refuses external traffic')
      const path = url.pathname.replace('/prod-api', '')
      const method = init?.method
      assert.ok(method === 'GET' || method === 'POST' && allowedPosts.has(path), 'Only two exact mock business writes are authorized')
      calls.push({ method, path })
      let envelope
      if (method === 'POST') {
        const count = (posts.get(path) ?? 0) + 1
        posts.set(path, count)
        assert.equal(count, 1, `Original-key replay must not repeat ${path}`)
        if (path === '/script/center/pool/produceUpload') {
          const body = JSON.parse(init.body)
          assert.equal(body.scriptName, '离线家庭剧')
          assert.equal(body.manuscriptFileName, manuscriptFile.name)
          assert.equal(body.manuscriptFileUrl, manuscriptFile.url)
          assert.equal(body.manuscriptObjectKey, manuscriptFile.objectKey)
          assert.equal(body.originalFileName, originalFile.name)
          assert.equal(body.originalFileUrl, originalFile.url)
          assert.equal(body.originalObjectKey, originalFile.objectKey)
          assert.equal(body.hasCopyright, '1')
          assert.equal(body.copyrightOwner, '离线权利方')
          registered = true
          envelope = { code: 200, data: 7 }
        } else if (path === '/script/center/pool/startProduce') {
          assert.equal(registered, true)
          const body = JSON.parse(init.body)
          assert.equal(body.manuscriptId, 7)
          assert.equal(body.script.manuscriptId, 7)
          assert.equal(body.script.createType, 1)
          assert.equal(body.script.produceType, 1)
          assert.equal(body.script.productionType, 0)
          started = true
          envelope = { code: 200, data: 2708 }
        } else throw new Error('Unexpected mock write')
      } else if (path === '/getInfo') envelope = { code: 200, data: { user: { userId: 91, userName: '离线编辑' } } }
      else if (path === '/script/center/pool/viewRole') envelope = { code: 200, data: 'prodlead' }
      else if (path === '/script/center/pool/list') {
        assert.equal(url.searchParams.get('pageNum'), '1')
        envelope = { code: 200, total: 1, rows: [
          { id: 11, scriptName: '离线剧本', status: 'pending_leader_claim', canClaim: 1 },
        ] }
      } else if (path === '/aigc/script/checkManuscriptProject') {
        assert.equal(url.searchParams.get('manuscriptId'), '7')
        assert.equal(url.searchParams.get('productionType'), '0')
        envelope = { code: 200, data: 0 }
      } else if (path === '/aigc/script/2708') {
        assert.equal(started, true, 'Only the real mock creation receipt establishes this project')
        envelope = { code: 200, data: { id: 2708, scriptName: '离线家庭剧', productionType: 0,
          createType: 1, produceType: 1, manuscriptId: 7 } }
      } else if (path === '/script/center/pool/detail/7') {
        assert.equal(registered, true)
        envelope = { code: 200, data: { manuscript: { id: 7, scriptName: '离线家庭剧', episodeCount: 4,
          status: started ? 'in_production' : 'pending_distribute' },
          manuscriptFileName: manuscriptFile.name, manuscriptFileUrl: manuscriptFile.url,
          manuscriptObjectKey: manuscriptFile.objectKey, originalFileName: originalFile.name,
          originalFileUrl: originalFile.url, originalObjectKey: originalFile.objectKey,
          canClaim: 0 } }
      } else if (path === '/script/center/tag/listByCategory') {
        const category = url.searchParams.get('tagCategory')
        assert.ok(Object.hasOwn(tagNames, category), 'Only the four registration tag categories are queried')
        const id = 101 + Object.keys(tagNames).indexOf(category)
        envelope = { code: 200, data: [{ id, tagName: tagNames[category], tagCode: category === 'creationType' ? 'original' : category,
          tagCategory: category }] }
      } else throw new Error(`Unexpected offline request ${method} ${path}`)
      return new Response(JSON.stringify(envelope), { status: 200 })
    }
    return () => { globalThis.fetch = originalFetch }
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.ok(!text.includes('offline-project-upload-fixture'), 'Credentials never enter model-visible messages')
      if (message.role !== 'tool') continue
      assert.notEqual(message.isError, true, `Native tool failed (${message.toolCallId}): ${text}`)
      if (message.toolCallId === 'call_native_skill') {
        assert.ok(text.includes('jubian_manuscript'))
        assert.ok(text.includes('jubian_project'))
        assert.ok(text.includes('idempotency_key'))
        instructionsReachedModel = true
      } else if (message.toolCallId === 'call_native_options') {
        for (const name of Object.values(tagNames)) assert.ok(text.includes(name), 'Every current tag list reaches the model')
        tagOptionsReachedModel = true
      } else if (message.toolCallId === 'call_native_manuscript') {
        const manuscript = JSON.parse(text).manuscript
        assert.deepEqual(manuscript.manuscript_file, { file_name: manuscriptFile.name,
          file_url: manuscriptFile.url, object_key: manuscriptFile.objectKey })
        assert.deepEqual(manuscript.original_file, { file_name: originalFile.name,
          file_url: originalFile.url, object_key: originalFile.objectKey })
        filesReachedModel = true
      }
    }
    yield* next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (['jubian_project', 'jubian_manuscript'].includes(exec.name)) {
      assert.equal(instructionsReachedModel, true, 'Current Skill instructions reach the model before business actions')
      if (exec.name === 'jubian_manuscript' && exec.arguments.method === 'register') assert.equal(tagOptionsReachedModel, true)
      if (exec.name === 'jubian_manuscript' && exec.arguments.method === 'start_produce') assert.equal(filesReachedModel, true)
    }
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = id => {
      const message = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data.message
      assert.ok(message, `Missing persisted native result ${id}`)
      assert.equal(message.isError, false)
      return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    const registeredResult = result('call_native_register'), start = result('call_native_start')
    assert.equal(registeredResult.outcome, 'accepted')
    assert.equal(start.script_id, 2708)
    assert.equal(start.readback.manuscript_binding_verified, true)
    assert.equal(result('call_native_project').project.manuscript_id, 7)
    for (const id of ['call_native_register_replay', 'call_native_start_replay']) {
      const replay = result(id)
      assert.equal(replay.replayed, true)
      assert.equal(replay.outcome, 'accepted')
    }
    assert.equal(instructionsReachedModel, true)
    assert.equal(tagOptionsReachedModel, true)
    assert.equal(filesReachedModel, true)
    assert.deepEqual([...posts.entries()].sort(), [...allowedPosts].map(path => [path, 1]).sort())
    assert.equal(calls.filter(call => call.path === '/aigc/script/checkManuscriptProject').length, 1,
      'Only the first project creation checks duplicates; original-key replay reuses its receipt')
    assert.ok(calls.every(call => call.method === 'GET' || allowedPosts.has(call.path)))
    assert.ok(!JSON.stringify(events).includes('offline-project-upload-fixture'), 'Session events contain no raw credential')
    const ledger = new JubianLedger({ root: join(process.env.DSH_HOME, 'jubian', 'ledger') })
    const records = await ledger.records()
    assert.equal(records.length, 2, 'Only the two accepted business writes have ledger records')
    assert.ok(records.every(record => record.outcome === 'accepted'))
  })
  ctx.provide('snapshotNativeSkillReady', true)
}
