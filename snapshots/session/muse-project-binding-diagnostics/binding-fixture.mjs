/** The real model-preview tool reports missing local binding before any transport or preview write. */
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'binding-fixture'
export const inject = ['tools', 'llm']
const expectedText = 'Error: Muse 无法核对本地项目绑定: 未找到 project_config.json。请打开包含该文件的原项目目录。'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless composition. */
export function apply(ctx) {
  let requests = 0, visibleInModelRequest = false
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      requests += 1
      throw new Error('Local binding validation must not make a provider request')
    }
    return () => { globalThis.fetch = original; assert.equal(requests, 0) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role === 'tool' && message.toolCallId === 'call_missing_binding') {
        assert.equal(message.isError, true)
        assert.equal(message.content[0]?.text, expectedText)
        visibleInModelRequest = true
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.toolCallId, 'call_missing_binding')
    assert.equal(results[0].data.message.isError, true)
    assert.deepEqual(results[0].data.error, { name: 'JubianProjectBindingError', code: 'PROJECT_BINDING_INVALID' })
    assert.equal(results[0].data.message.content[0]?.text, expectedText)
    assert.equal(visibleInModelRequest, true)
    assert.equal(requests, 0)
    const cwd = agent.session.header.cwd
    assert.ok(cwd)
    const files = await readdir(cwd)
    assert.equal(files.includes('project_config.json'), false)
    assert.equal(files.includes('video_tasks'), false)
    let ledgerFiles
    try { ledgerFiles = await readdir(join(process.env.DSH_HOME, 'jubian', 'ledger')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledgerFiles = [] }
    assert.equal(ledgerFiles.some(file => file.endsWith('.ndjson')), false)
    await writeFile(join(cwd, 'project-binding-proof.json'), JSON.stringify({
      errorName: 'JubianProjectBindingError', errorCode: 'PROJECT_BINDING_INVALID',
      diagnosticVisibleToModel: true, providerRequests: 0, ledgerRecords: 0, previewFiles: 0,
    }, null, 2) + '\n')
  })
}
