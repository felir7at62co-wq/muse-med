/** Offline live pricing, default budget, duplicate-key replay and missing-price refusal. */
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { JubianLedger, readProjectBudget } = await importSnapshotPackage('@deepseek-ai/dsh-jubian',
  new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))
export const name = 'upscale-fixture'
export const inject = ['tools', 'llm', 'settings']
const catalogue = [
  { id: 55, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
    unitPrice: 1, unit: '元/条', genTypes: [],
    videoStandards: [{ id: 303, modelId: '2074071626416742401', resolution: '1080p' }] },
  { id: 77, modelId: 'offline-unpriced-upscale', platformId: 'OFFLINE',
    unit: '元/条', genTypes: [],
    videoStandards: [{ id: 404, modelId: 'offline-unpriced-upscale', resolution: '1080p' }] },
]

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless composition with real drama defaults. */
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
  let missingPricePaidBefore = null, missingPricePaidRequests = null
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1792396800000] : args)) }
      static now() { return 1792396800000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://upscale-pricing.invalid', 'Offline pricing refuses external traffic')
      const path = url.pathname.replace('/prod-api', ''), method = String(init?.method)
      calls.push({ method, path })
      let data
      if (method === 'GET' && path === '/admin/aigc/video/task/42') {
        data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
      } else if (method === 'POST' && path === '/admin/aigc/video/task/sub/list') {
        assert.deepEqual(JSON.parse(init.body), { aigcVideoTaskId: 42 })
        data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
          duration: 13.5, firstResultId: 1007193, parentResultId: 1007193,
          resultList: [{ tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
      } else if (method === 'GET' && path === '/model/charge/getSelectList') {
        assert.equal(url.searchParams.get('taskType'), '20')
        data = catalogue
      } else if (method === 'POST' && path === '/aigc/storyboard/hdConversion') {
        const payload = JSON.parse(init.body)
        assert.equal(payload.scriptId, 2708)
        assert.equal(payload.modelId, '2074071626416742401')
        assert.equal(payload.standardId, 55); assert.equal(payload.videoStandardId, 303)
        assert.equal(payload.platformId, 'RUNNING_HUB'); assert.equal(payload.taskType, 20)
        assert.equal(payload.videoUrl, 'https://media.example.test/source.mp4')
        assert.equal(payload.firstResultId, 1007193); assert.equal(payload.parentResultId, 1007193)
        assert.equal(payload.duration, 13.5)
        const reservation = await ledger.find('offline-upscale-priced')
        assert.equal(reservation?.outcome, null)
        assert.equal(reservation?.quoted_amount, '1.00'); assert.equal(reservation?.quote_unit, 'CNY')
        assert.equal(reservation?.quote_standard_id, 55)
        reservationBeforePaid = true
        assert.equal(++paidPosts, 1, 'Only one paid mock request is authorized')
        data = 429001
      } else throw new Error(`Unexpected offline pricing request ${method} ${path}`)
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
    if (exec.callId === 'call_upscale_replay') replayStart = calls.length
    if (exec.callId === 'call_upscale_unpriced') missingPricePaidBefore = paidPosts
    return next()
  })
  ctx.on('tools/result', (exec) => {
    if (exec.callId === 'call_upscale_replay') {
      assert.notEqual(replayStart, null)
      replayHttpRequests = calls.length - replayStart
      assert.equal(replayHttpRequests, 0)
    }
    if (exec.callId === 'call_upscale_unpriced') {
      assert.notEqual(missingPricePaidBefore, null)
      missingPricePaidRequests = paidPosts - missingPricePaidBefore
      assert.equal(missingPricePaidRequests, 0)
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = (id, isError = false) => {
      const message = events.find(event => event.type === 'tool/result'
        && event.data.message.toolCallId === id)?.data.message
      assert.ok(message, `Missing recorded upscale result ${id}`)
      assert.equal(message.isError, isError, JSON.stringify(message.content))
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return isError ? text : JSON.parse(text)
    }
    const submitted = result('call_upscale_submit'), replayed = result('call_upscale_replay')
    const refused = result('call_upscale_unpriced', true), budget = await readProjectBudget(ledger, 2708)
    assert.equal(submitted.replayed, false); assert.equal(submitted.outcome, 'accepted')
    assert.equal(submitted.accepted_task_id, '429001'); assert.equal(submitted.budget.status, 'authorized')
    assert.equal(replayed.replayed, true); assert.equal(replayed.outcome, 'accepted')
    assert.match(refused, /没有报价/)
    assert.equal(budget.source, 'default'); assert.equal(budget.limit_cents, 400000)
    assert.equal(budget.settled_cents, 100); assert.equal(budget.reserved_cents, 0)
    assert.equal(budget.accounting_complete, true)
    const section = ctx.settings.describe().find(row => row.ns === 'drama-settings')
    assert.equal(section?.value.seriesBudgetCents, 400000)
    await assert.rejects(access(join(ledgerRoot, 'authorization.json')), { code: 'ENOENT' })
    const records = await ledger.records()
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record.idempotency_key, 'offline-upscale-priced'); assert.equal(record.method, 'video_upscale')
    assert.equal(record.script_id, 2708); assert.equal(record.outcome, 'accepted')
    assert.equal(record.quoted_amount, '1.00'); assert.equal(record.quote_unit, 'CNY')
    assert.equal(record.quote_standard_id, 55); assert.ok(Number.isFinite(Date.parse(record.quote_observed_at)))
    assert.equal(await ledger.find('offline-upscale-unpriced'), undefined)
    assert.equal(paidPosts, 1); assert.equal(reservationBeforePaid, true)
    assert.equal(replayHttpRequests, 0); assert.equal(missingPricePaidRequests, 0)
    const catalogueReads = calls.filter(call => call.path === '/model/charge/getSelectList').length
    assert.equal(catalogueReads, 2); assert.equal(calls.length, 7)
    const expectedIds = ['call_upscale_submit', 'call_upscale_replay', 'call_upscale_unpriced']
    assert.deepEqual([...modelResults].sort(), expectedIds.sort())
    const proof = { budgetSource: budget.source, budgetLimitCents: budget.limit_cents,
      manualAuthorizationPresent: false, reservationBeforePaidRequest: reservationBeforePaid,
      paidMockPosts: paidPosts, liveCatalogueReads: catalogueReads, totalProviderRequests: calls.length,
      replayHttpRequests, missingPricePaidRequests, ledgerRecords: records.length,
      quotedAmount: record.quoted_amount, quoteUnit: record.quote_unit, quoteStandardId: record.quote_standard_id,
      settledCents: budget.settled_cents, reservedCents: budget.reserved_cents,
      modelSawEveryToolResult: true, realProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'upscale-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
    assert.equal(JSON.parse(await readFile(join(agent.session.header.cwd, 'upscale-proof.json'), 'utf8')).paidMockPosts, 1)
  })
  ctx.provide('snapshotUpscaleReady', true)
}
