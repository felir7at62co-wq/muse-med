/** Live free-route selection, durable zero intent, duplicate replay and paid-price refusal. */
import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
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
    assert.equal(value, 0)
    return value
  } })
  const calls = [], cataloguePrices = [], modelResults = new Map()
  let price = 0, submissions = 0, zeroIntentBeforeProviderRequest = false
  let replayStart = null, replayHttpRequests = null
  let repricedSubmissionBefore = null, repricedSubmissionRequests = null
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1792396800000] : args)) }
      static now() { return 1792396800000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      assert.equal(url.origin, 'https://erase-free.invalid', 'The fixture refuses external provider traffic')
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
        assert.equal(url.search, '?taskType=10')
        cataloguePrices.push(price)
        data = [{ id: 67, modelId: 'ark-erase-video-subtitle-pro', platformId: 'AI_MEDIA_KIT',
          unitPrice: price, unit: '元/条', videoStandards: [] }]
      } else if (method === 'POST' && path === '/aigc/storyboard/subtitleEraser') {
        assert.equal(price, 0, 'A positive catalogue price must never reach submission')
        const payload = JSON.parse(init.body)
        assert.equal(payload.scriptId, 2708); assert.equal(payload.episodeId, 46744)
        assert.equal(payload.modelId, 'ark-erase-video-subtitle-pro')
        assert.equal(payload.standardId, 67); assert.equal(payload.platformId, 'AI_MEDIA_KIT')
        assert.equal(payload.taskType, 10); assert.equal(payload.duration, 13.5)
        assert.equal(payload.videoUrl, 'https://media.example.test/source.mp4')
        assert.equal(payload.firstResultId, 123); assert.equal(payload.parentResultId, 456)
        assert.equal(Object.hasOwn(payload, 'estimated_cost_cny'), false)
        assert.equal(Object.hasOwn(payload, 'estimate_basis'), false)
        const reservation = await ledger.find('offline-erase-free')
        assert.equal(reservation?.outcome, null)
        assert.equal(reservation?.quoted_amount, '0.00'); assert.equal(reservation?.quote_unit, 'CNY')
        assert.equal(reservation?.quote_standard_id, 67)
        assert.equal(typeof reservation?.quote_observed_at, 'string')
        await assert.rejects(access(join(ledgerRoot, 'authorization.json')), { code: 'ENOENT' })
        zeroIntentBeforeProviderRequest = true
        assert.equal(++submissions, 1, 'Only one synthetic free mock request is authorized')
        data = { taskId: 429001 }
      } else throw new Error(`Unexpected offline erasure request ${method} ${path}`)
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role === 'tool') modelResults.set(message.toolCallId, message.content)
    }
    yield* next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.callId === 'call_erase_replay') replayStart = calls.length
    if (exec.callId === 'call_erase_repriced') {
      price = 0.5
      repricedSubmissionBefore = submissions
    }
    return next()
  })
  ctx.on('tools/result', (exec) => {
    if (exec.callId === 'call_erase_replay') {
      assert.notEqual(replayStart, null)
      replayHttpRequests = calls.length - replayStart
      assert.equal(replayHttpRequests, 0)
    }
    if (exec.callId === 'call_erase_repriced') {
      assert.notEqual(repricedSubmissionBefore, null)
      repricedSubmissionRequests = submissions - repricedSubmissionBefore
      assert.equal(repricedSubmissionRequests, 0)
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
    const refused = result('call_erase_repriced', true), budget = await readProjectBudget(ledger, 2708)
    assert.equal(submitted.replayed, false); assert.equal(submitted.outcome, 'accepted')
    assert.equal(submitted.accepted_task_id, '429001'); assert.equal(submitted.budget.status, 'authorized')
    assert.match(submitted.next, /0 元\/条/)
    assert.equal(replayed.replayed, true); assert.equal(replayed.outcome, 'accepted')
    assert.equal(replayed.accepted_task_id, null)
    assert.match(refused, /Jubian spend is not covered by the authorization/)
    assert.match(refused, /授权上限 0\.00 CNY/)
    assert.equal(budget.source, 'default'); assert.equal(budget.limit_cents, 0)
    assert.equal(budget.settled_cents, 0); assert.equal(budget.reserved_cents, 0)
    assert.equal(budget.accounting_complete, true)
    await assert.rejects(access(join(ledgerRoot, 'authorization.json')), { code: 'ENOENT' })
    const records = await ledger.records()
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record.idempotency_key, 'offline-erase-free'); assert.equal(record.method, 'erase_subtitle')
    assert.equal(record.script_id, 2708); assert.equal(record.outcome, 'accepted')
    assert.equal(record.quoted_amount, '0.00'); assert.equal(record.quote_unit, 'CNY')
    assert.equal(record.quote_standard_id, 67); assert.equal(typeof record.quote_observed_at, 'string')
    assert.equal(await ledger.find('offline-erase-now-priced'), undefined)
    assert.equal(submissions, 1); assert.equal(zeroIntentBeforeProviderRequest, true)
    assert.equal(replayHttpRequests, 0); assert.equal(repricedSubmissionRequests, 0)
    assert.equal(calls.length, 7); assert.deepEqual(cataloguePrices, [0, 0.5])
    const expectedIds = ['call_erase_submit', 'call_erase_replay', 'call_erase_repriced']
    assert.deepEqual([...modelResults.keys()].sort(), expectedIds.sort())
    for (const id of expectedIds) {
      const recorded = events.find(event => event.type === 'tool/result'
        && event.data.message.toolCallId === id)?.data.message
      assert.deepEqual(modelResults.get(id), recorded.content)
    }
    const proof = { budgetSource: budget.source, budgetLimitCents: budget.limit_cents,
      manualAuthorizationPresent: false, zeroIntentBeforeProviderRequest,
      acceptedMockPosts: submissions, totalProviderRequests: calls.length, cataloguePricesObserved: cataloguePrices,
      replayHttpRequests, repricedSubmissionRequests, ledgerRecords: records.length,
      originalIdempotencyKey: record.idempotency_key, quoteAmount: record.quoted_amount,
      quoteUnit: record.quote_unit, quoteStandardId: record.quote_standard_id,
      quoteObservedAtRecorded: typeof record.quote_observed_at === 'string',
      providerQuoteObserved: true, actualBilledCostObserved: false,
      settledCents: budget.settled_cents, reservedCents: budget.reserved_cents,
      modelSawEveryToolResult: true, realProviderRequests: 0 }
    await writeFile(join(agent.session.header.cwd, 'erase-free-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  })
  ctx.provide('snapshotEraseReady', true)
}
