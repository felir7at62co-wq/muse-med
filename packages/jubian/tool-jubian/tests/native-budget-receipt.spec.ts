/** Native reconciliation retains original reservation evidence without another budget check or paid request. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildNativeVideoPreview } from '@deepseek-ai/dsh-jubian-api'
import { reconcileRecordedVideo, recoverVideoSubmission, submitVideoBatchMethod, submitVideoMethod } from '../src/native.ts'
import { bodyHash } from '../src/write.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jubian-native-budget-receipt-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const project = join(root, 'project'), ledgerRoot = join(root, 'ledger'), videoTasks = join(project, 'video_tasks')
  await mkdir(videoTasks, { recursive: true })
  await mkdir(ledgerRoot)
  await writeFile(join(project, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  await writeFile(join(ledgerRoot, 'authorization.json'), '{unreadable-current-authorization')
  const authorization = vi.fn((): number => { throw new Error('Replay must not recheck the current project budget') })
  const ledger = new JubianLedger({ root: ledgerRoot, defaultLimitCents: authorization })
  const requests: string[] = []
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}`)
    if (init?.method !== 'GET' || !url.pathname.endsWith('/admin/aigc/video/task/list')) {
      throw new Error('Native replay must only read the original task inventory')
    }
    return Response.json({ code: 200, data: { total: 0, rows: [] } })
  } })
  async function record(storyboardId: number, outcome: 'accepted' | 'unknown' | undefined, quote?: { amount: string; unit: string }) {
    const image = 'https://media.example/lead.png'
    const config = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
      modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
      materialList: [], backupModelList: [], prompt: '@[Lead](lead) stands still.' }
    const preview = buildNativeVideoPreview({ createdAt: '2026-10-11T00:00:00Z',
      storyboard: { id: storyboardId, scriptId: 2708, isGenerate: 1, modelConfig: JSON.stringify(config),
        storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
          materialType: 'image', materialUrl: image, sortOrder: 1 }] },
      assets: [{ id: 81285, scriptId: 2708, assetUrl: image, hsAssetId: 'asset-lead', hsAssetStatus: 'Active',
        isUsed: 1, official: true, asset_status: 'confirmed' }],
      models: [{ ...config, id: 11, genTypes: [{ id: 7, type: 3 }],
        videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }] })
    const previewPath = join(videoTasks, `storyboard-${storyboardId}.storyboard-native.prepared.json`)
    const frozen = JSON.stringify(preview)
    await writeFile(previewPath, frozen)
    await ledger.begin({ idempotencyKey: preview.idempotencyKey, method: 'storyboard_native_submit', scriptId: 2708,
      requestSha256: bodyHash(preview.payload), videoPreviewPath: previewPath, beforeTaskIds: [],
      ...(quote === undefined ? {} : { quotedAmount: quote.amount, quoteUnit: quote.unit }) })
    if (outcome !== undefined) await ledger.settle(preview.idempotencyKey, {
      httpStatus: outcome === 'accepted' ? 200 : null, applicationCode: outcome === 'accepted' ? 200 : null,
      responseSha256: null, outcome,
    })
    return { preview_path: previewPath, idempotency_key: preview.idempotencyKey, frozen }
  }
  return { ledger, authorization, client, requests, project, record }
}

it.each(['accepted', 'unknown', undefined] as const)('returns the original native reservation for every %s replay entry', async (outcome) => {
  const f = await fixture(), item = await f.record(916953, outcome, { amount: '13.36', unit: 'CNY' })
  const before = await f.ledger.records()
  for (const result of [
    await submitVideoMethod(f.client, f.ledger, { ...item, estimated_cost_cny: '999.99', estimate_basis: 'Changed estimate is ignored' }),
    await reconcileRecordedVideo(f.client, f.ledger, item),
    await recoverVideoSubmission(f.client, f.ledger, f.project, item.idempotency_key),
  ]) {
    expect(result).toMatchObject({ replayed: true, outcome: outcome ?? 'unknown', budget: {
      status: 'not_rechecked', reason: '', project_accounting: null,
      this_submission: { reservation: { status: 'recorded', amount: '13.36', unit: 'CNY', basis: 'quote_or_estimate' },
        provider_billing: 'not_observed' },
    } })
  }
  expect(f.authorization).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(3)
  expect(f.requests.every(request => request.startsWith('GET '))).toBe(true)
  expect(await f.ledger.records()).toEqual(before)
  expect(await readFile(item.preview_path, 'utf8')).toBe(item.frozen)
})

it('returns each batch replay reservation separately and keeps a missing historical amount unavailable', async () => {
  const f = await fixture()
  const first = await f.record(916953, 'unknown', { amount: '13.36', unit: 'CNY' })
  const second = await f.record(916954, 'accepted')
  const before = await f.ledger.records()
  const result = await submitVideoBatchMethod(f.client, f.ledger, { items: [first, second] })
  expect(result.results).toMatchObject([
    { replayed: true, outcome: 'unknown', budget: { status: 'not_rechecked', project_accounting: null,
      this_submission: { reservation: { status: 'recorded', amount: '13.36', unit: 'CNY' }, provider_billing: 'not_observed' } } },
    { replayed: true, outcome: 'accepted', budget: { status: 'not_rechecked', project_accounting: null,
      this_submission: { reservation: { status: 'unavailable' }, provider_billing: 'not_observed' } } },
  ])
  expect(f.authorization).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(2)
  expect(f.requests.every(request => request.startsWith('GET '))).toBe(true)
  expect(await f.ledger.records()).toEqual(before)
})
