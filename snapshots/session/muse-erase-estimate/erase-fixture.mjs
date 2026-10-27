/** Explicit caller estimates, default budget, duplicate replay and missing-estimate refusal. */
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { JubianLedger, readProjectBudget } = await importSnapshotPackage('@deepseek-ai/dsh-jubian',
  new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))
export const name = 'erase-fixture'
export const inject = ['tools', 'llm', 'settings']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Real Headless composition with isolated external transport. */
export async function apply(ctx) {
  const ledgerRoot = join(process.env.DSH_HOME, 'jubian', 'ledger')
  const ledger = new JubianLedger({ root: ledgerRoot, defaultLimitCents: () => {
    const value = ctx.settings.describe().find(row => row.ns === 'drama-settings')?.value.seriesBudgetCents
    assert.equal(value, 400000)
    return value
  } })
  const calls = [], modelResults = new Set()
  let paidPosts = 0, reservationBeforePaid = false
  let replayStart = null, replayHttpRequests = null
  let missingEstimatePaidBefore = null, missingEstimatePaidRequests = null
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1792396800000] : args)) }
      static now() { return 1792396800000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://erase-estimate.invalid', 'The fixture refuses external provider traffic')
      const path = url.pathname.replace('/prod-api', ''), method = String(init?.method)
      calls.push({ method, path })
      let data
      if (method === 'GET' && path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      } else if (method === 'POST' && path === '/admin/aigc/video/task/sub/list') {
        assert.deepEqual(JSON.parse(init.body), { aigcVideoTaskId: 42 })
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
          duration: 13.5, firstResultId: 123, parentResultId: 456,
          resultList: [{ taskType: 1, tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
      } else if (method === 'GET' && path === '/model/charge/getSelectList') {
        data = [{ id: 67, modelId: 'ark-erase-video-subtitle-pro', platformId: 'AI_MEDIA_KIT',
          unitPrice: 0, unit: '元/条', videoStandards: [] }]
      } else if (method === 'POST' && path === '/aigc/storyboard/subtitleEraser') {
        const payload = JSON.parse(init.body)
        assert.equal(payload.scriptId, 2708); assert.equal(payload.episodeId, 46744)
        assert.equal(payload.modelId, 'ark-erase-video-subtitle-pro')
        assert.equal(payload.standardId, 67); assert.equal(payload.platformId, 'AI_MEDIA_KIT')
        assert.equal(payload.taskType, 10); assert.equal(payload.duration, 13.5)
        assert.equal(payload.videoUrl, 'https://media.example.test/source.mp4')
        assert.equal(payload.firstResultId, 123); assert.equal(payload.parentResultId, 456)
        assert.equal(Object.hasOwn(payload, 'estimated_cost_cny'), false)
        assert.equal(Object.hasOwn(payload, 'estimate_basis'), false)
        const reservation = await ledger.find('offline-erase-estimated')
        assert.equal(reservation?.outcome, null)
        assert.equal(reservation?.quoted_amount, '1.00'); assert.equal(reservation?.quote_unit, 'CNY')
        reservationBeforePaid = true
        assert.equal(++paidPosts, 1, 'Only one synthetic mock request is authorized')
        data = { taskId: 429001 }
      } else throw new Error(`Unexpected offline erasure request ${method} ${path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role === 'tool') modelResults.add(message.toolCallId)
    }
    yield* next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.callId === 'call_erase_replay') replayStart = calls.length
    if (exec.callId === 'call_erase_unpriced') missingEstimatePaidBefore = paidPosts
    return next()
  })
  ctx.on('tools/result', (exec) => {
    if (exec.callId === 'call_erase_replay') {
      assert.notEqual(replayStart, null)
      replayHttpRequests = calls.length - replayStart
      assert.equal(replayHttpRequests, 0)
    }
    if (exec.callId === 'call_erase_unpriced') {
      assert.notEqual(missingEstimatePaidBefore, null)
      missingEstimatePaidRequests = paidPosts - missingEstimatePaidBefore
      assert.equal(missingEstimatePaidRequests, 0)
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = (id, isError = false) => {
      const message = events.find(event => event.type === 'tool/result'
        && event.data.message.toolCallId === id)?.data.message
      assert.ok(message, `Missing recorded erasure result ${id}`)
      assert.equal(message.isError, isError, JSON.stringify(message.content))
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return isError ? text : JSON.parse(text)
    }
    const submitted = result('call_erase_submit'), replayed = result('call_erase_replay')
    const refused = result('call_erase_unpriced', true), budget = await readProjectBudget(ledger, 2708)
    assert.equal(submitted.replayed, false); assert.equal(submitted.outcome, 'accepted')
    assert.equal(submitted.accepted_task_id, '429001'); assert.equal(submitted.budget.status, 'authorized')
    assert.match(submitted.next, /估算 1\.00 CNY/)
    assert.match(submitted.next, /不是供应商报价或实际结算金额/)
    assert.equal(replayed.replayed, true); assert.equal(replayed.outcome, 'accepted')
    assert.doesNotMatch(replayed.next, /本次按调用方声明/)
    assert.match(refused, /没有报价/)
    assert.equal(budget.source, 'default'); assert.equal(budget.limit_cents, 400000)
    assert.equal(budget.settled_cents, 100); assert.equal(budget.reserved_cents, 0)
    assert.equal(budget.accounting_complete, true)
    await assert.rejects(access(join(ledgerRoot, 'authorization.json')), { code: 'ENOENT' })
    const records = await ledger.records()
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record.idempotency_key, 'offline-erase-estimated'); assert.equal(record.method, 'erase_subtitle')
    assert.equal(record.script_id, 2708); assert.equal(record.outcome, 'accepted')
    assert.equal(record.quoted_amount, '1.00'); assert.equal(record.quote_unit, 'CNY')
    assert.equal(record.quote_standard_id, null)
    assert.equal(await ledger.find('offline-erase-unestimated'), undefined)
    assert.equal(paidPosts, 1); assert.equal(reservationBeforePaid, true)
    assert.equal(replayHttpRequests, 0); assert.equal(missingEstimatePaidRequests, 0)
    assert.equal(calls.length, 6)
    const expectedIds = ['call_erase_submit', 'call_erase_replay', 'call_erase_unpriced']
    assert.deepEqual([...modelResults].sort(), expectedIds.sort())
    const proof = { budgetSource: budget.source, budgetLimitCents: budget.limit_cents,
      manualAuthorizationPresent: false, reservationBeforePaidRequest: reservationBeforePaid,
      paidMockPosts: paidPosts, totalProviderRequests: calls.length, replayHttpRequests,
      missingEstimatePaidRequests, ledgerRecords: records.length, estimateAmount: record.quoted_amount,
      estimateUnit: record.quote_unit, providerQuoteObserved: false, actualBilledCostObserved: false,
      settledCents: budget.settled_cents, reservedCents: budget.reserved_cents,
      modelSawEveryToolResult: true, realProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'erase-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
    assert.equal(JSON.parse(await readFile(join(agent.session.header.cwd, 'erase-proof.json'), 'utf8')).paidMockPosts, 1)
  })
  ctx.provide('snapshotEraseReady', true)
}
