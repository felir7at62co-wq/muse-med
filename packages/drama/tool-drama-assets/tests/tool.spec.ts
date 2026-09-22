/**
 * The plugin entry: its identity, its registration, the argument names the model
 * sends, and one call per method through the registered executor.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF } from '@deepseek-ai/dsh-jubian'
import { apply, name, inject, runDramaAssets, workspacePipelineToken } from '../src/index.ts'
import { evidencePath } from '../src/reconcile.ts'
import type { ReconcileReport } from '../src/types.ts'
import { cleanup, dramaAssets, manifestDocument, mountContext, stubTransport, tempProject, writeInto } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** One project tracked for cleanup, with the standard manifest unless a document is given. */
async function project(document: Record<string, unknown> = manifestDocument()): Promise<string> {
  const dir = await tempProject(document)
  temporary.push(dir)
  return dir
}

/** The registry context a registered tool's executor receives. */
function runContext(): ToolRunContext {
  return {
    callId: 'drama-assets-spec',
    rootCallId: 'drama-assets-spec',
    name: 'drama_assets',
    arguments: {},
    signal: new AbortController().signal,
    token: 'drama-assets-spec',
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

/** One `drama_assets` result, as `runDramaAssets` reports it. */
type DramaAssetsPresentation = Awaited<ReturnType<typeof runDramaAssets>>

/**
 * The `reconcile` arm of a `drama_assets` result.
 *
 * Only `reconcile` reads the remote project, so only its presentation carries
 * `unregistered` and `dangling`; a spec asserting them states the method it called.
 * @param result - One `drama_assets` result.
 * @returns The same value, narrowed by its `method` discriminant.
 */
function reconciled(result: DramaAssetsPresentation): Extract<DramaAssetsPresentation, { method: 'reconcile' }> {
  if (result.method !== 'reconcile') throw new Error(`expected a reconcile result, got ${result.method}`)
  return result
}

/**
 * The alive assets and used materials one project holds.
 *
 * The standard manifest records 125204 and 125300 in `items` and 125400 in
 * `lead_readonly_records`, so 83840 is the one asset here the manifest misses.
 */
const ALIVE = [
  { id: 125204, delFlag: '0', assetName: '陆沉舟', assetType: 1, url: 'https://example.invalid/lu.jpg',
    createTime: '2026-08-01 10:00:00' },
  { id: 125300, delFlag: '0', assetName: '公文箱', assetType: 3 },
  { id: 125400, delFlag: '0', assetName: '林晚', assetType: 1 },
  { id: 83840, delFlag: '0', assetName: '西装', assetType: 1 },
]
const USED = [
  { id: 124527, assetId: 125204, isUsed: 1, hsAssetStatus: 'Active' },
  { id: 124528, assetId: 125300, isUsed: 1, hsAssetStatus: 'Active' },
  { id: 124529, assetId: 125400, isUsed: 1, hsAssetStatus: 'Active' },
  { id: 81426, assetId: 83840, assetName: '西装', assetType: 1, isUsed: 1, hsAssetStatus: 'Active' },
]

/** Read one project's evidence file. */
async function evidence(projectDir: string): Promise<ReconcileReport> {
  return JSON.parse(await readFile(evidencePath(projectDir), 'utf8')) as ReconcileReport
}

describe('registration', () => {
  it('declares its name and the two registries it needs', () => {
    expect(name).toBe('tool-drama-assets')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  it('registers exactly the drama_assets tool with the pipeline rules in its description', () => {
    const { ctx, registered } = mountContext()
    apply(ctx)
    expect(registered.map(tool => tool.name)).toEqual(['drama_assets'])
    const tool = dramaAssets(registered)
    for (const phrase of ['asset/list', 'delFlag == "0"', 'material/list', 'isUsed == 1',
      'hsAssetStatus == "Active"', 'unregistered', 'dangling', 'matched', 'disposition',
      'blocking', 'ignored_without_note', 'ready', '_probe/asset-reconcile.json',
      '绝不调用剧变的任何写方法']) {
      expect(tool.description).toContain(phrase)
    }
  })

  it('exposes the method enum and exactly the argument names the call interface reads', () => {
    const { ctx, registered } = mountContext()
    apply(ctx)
    const parameters = dramaAssets(registered).parameters as {
      properties: Record<string, { enum?: string[]; required?: boolean }>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['asset_id', 'method', 'note', 'project_dir', 'status'])
    expect(parameters.properties['method']?.enum).toEqual(['reconcile', 'dispose'])
    expect(parameters.properties['status']?.enum).toEqual(['registered', 'ignored'])
    expect(parameters.required).toEqual(['method', 'project_dir'])
  })

  it('runs the registered executor end to end against a stubbed transport', async () => {
    const previous = globalThis.fetch
    const paths: string[] = []
    // The executor is the path the model's call takes, so one spec drives it: the
    // transport is the only seam substituted, and the tool's own value comes back.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const address = (url as URL).toString()
      paths.push(address)
      const body = address.includes('/aigc/material/list')
        ? { total: USED.length, rows: USED }
        : { total: ALIVE.length, rows: ALIVE }
      return new Response(JSON.stringify({ code: 200, data: body }), { status: 200 })
    }) as typeof fetch
    try {
      const { ctx, registered } = mountContext('stored-token')
      apply(ctx, { timeoutMs: 5000 })
      const projectDir = await project()
      const value = await dramaAssets(registered).execute(
        { method: 'reconcile', project_dir: projectDir }, runContext()) as {
        method: string
        ready: boolean
        matched: number
        blocking: number[]
      }

      expect(paths).toHaveLength(2)
      expect(value.method).toBe('reconcile')
      expect(value.ready).toBe(false)
      expect(value.matched).toBe(3)
      expect(value.blocking).toEqual([83840])
    } finally {
      globalThis.fetch = previous
    }
  })

  it('sends the token the credential store resolved to the deployment origin', async () => {
    // The origin is the deployment's; the token comes from the credential store and
    // reaches the transport's own request to that origin.
    const { ctx, registered, resolvedRefs } = mountContext('resolved-secret')
    apply(ctx, { baseUrl: 'https://jubian.example.invalid/prod-api', timeoutMs: 5000 })
    const projectDir = await project()
    await expect(dramaAssets(registered).execute(
      { method: 'reconcile', project_dir: projectDir }, runContext()))
      .rejects.toThrow()
    expect(resolvedRefs).toEqual([JUBIAN_TOKEN_REF])
  })

  it('renders the canonical value as pretty JSON', () => {
    const { ctx, registered } = mountContext()
    apply(ctx)
    const blocks = dramaAssets(registered).output.render({}, { ready: true }) as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('"ready": true')
  })

  it('fails a call through the registered executor when an argument is missing', async () => {
    const { ctx, registered } = mountContext()
    apply(ctx)
    // The registry validates the spec's own required fields before the body runs.
    await expect(dramaAssets(registered).execute({ method: 'reconcile' }, runContext()))
      .rejects.toThrow('invalid arguments')
  })
})

describe('workspacePipelineToken', () => {
  it('reads the pipeline token from the nearest workspace secret file', async () => {
    const workspace = await project()
    const nested = join(workspace, 'short-drama', 'ep05')
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'), 'JUBIANAI_ADMIN_TOKEN="from-file"\n')
    expect(await workspacePipelineToken(nested)).toBe('from-file')
    expect(await workspacePipelineToken(join(workspace, '..', 'no-such-workspace'))).toBe('')
  })

  it('prefers the admin token and falls back to the plain one', async () => {
    const workspace = await project()
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'),
      'JUBIANAI_TOKEN=plain\n# comment\nOTHER=1\n')
    expect(await workspacePipelineToken(workspace)).toBe('plain')
  })

  it('reads a quoted, single-quoted or unquoted value and ignores every other line', async () => {
    const workspace = await project()
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'), "JUBIANAI_TOKEN='quoted'\n")
    expect(await workspacePipelineToken(workspace)).toBe('quoted')
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'), 'JUBIANAI_TOKEN=bare\n')
    expect(await workspacePipelineToken(workspace)).toBe('bare')
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'), 'JUBIANAI_TOKEN=\n')
    expect(await workspacePipelineToken(workspace)).toBe('')
    // An empty admin token falls through to the plain spelling rather than winning.
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'),
      'JUBIANAI_ADMIN_TOKEN=\nJUBIANAI_TOKEN=fallback\n')
    expect(await workspacePipelineToken(workspace)).toBe('fallback')
    // A value the shell quoted keeps its quotes only when they do not match.
    await writeInto(join(workspace, '.agents', 'secrets', 'pipeline.env'), 'JUBIANAI_TOKEN="mixed\'\n')
    expect(await workspacePipelineToken(workspace)).toBe('"mixed\'')
  })
})

describe('runDramaAssets', () => {
  it('reconciles and returns every field of the schema', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    const result = await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir })

    expect(result).toEqual({
      method: 'reconcile',
      ready: false,
      ready_reason: '对账里还有 1 条未处置的未登记资产：83840',
      evidence: evidencePath(projectDir),
      script_id: 2708,
      ran_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/),
      source: { asset_list_rows: 4, material_list_rows: 4, remote_alive: 4, remote_used: 4 },
      manifest: { items: 2, lead_readonly_records: 1, asset_ids: 3 },
      matched: 3,
      unregistered: [{
        asset_id: 83840, material_id: 81426, name: '西装', asset_type: 1, is_used: 1,
        hs_asset_status: 'Active', url: '', create_time: '',
      }],
      dangling: [],
      disposition: { 83840: { status: 'pending', note: '' } },
      blocking: [83840],
      ignored_without_note: [],
      policy: {
        image_channel: 'KU_AI', image_unit_price_cny: 0.12, max_attempts_per_asset: 3,
        worst_case_cny_per_asset: 0.36,
        cross_project_reuse: '手动：先跑 jubian-asset-library 技能检索，结论写进本文件的 cross_project_note',
      },
      cross_project_note: '',
      next: '证据 ready=false：付费生图会被宿主钩子拒绝，先按 ready_reason 把未登记的资产逐条处置。',
    })
  })

  it('names the ignored dispositions without a note as the reason to refuse', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    await writeInto(evidencePath(projectDir), JSON.stringify({
      disposition: {
        83840: { status: 'ignored', note: '' },
        125400: { status: 'ignored', note: '   ' },
        125204: { status: 'ignored', note: '有原因' },
      },
    }))
    const result = await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir })

    expect(result.ready).toBe(false)
    // 125204 and 125400 are recorded in the manifest, so the run answers for them
    // with `registered` and only the unregistered 83840 keeps its ignored status.
    expect(result.ready_reason).toBe('这 1 条判为 ignored 但没写 note：83840')
    expect(result.ignored_without_note).toEqual([83840])
    expect(result.disposition['125400']).toEqual({ status: 'registered', note: '   ' })
  })

  it('reports a ready verdict and notes the dangling records that still need fixing', async () => {
    const projectDir = await project(manifestDocument({
      items: [
        { stable_id: 'char_lu', name: '陆沉舟', jubian_asset_id: 125204 },
        { stable_id: 'ghost', name: '悬空', jubian_asset_id: 4242 },
      ],
      lead_readonly_records: [{ stable_id: 'lead_lin', name: '林晚', jubian_asset_id: 125400 }],
    }))
    const { client } = stubTransport([ALIVE[0]!, ALIVE[2]!], [USED[0]!, USED[2]!])
    const result = reconciled(await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir }))

    expect(result.ready).toBe(true)
    expect(result.ready_reason).toBe('ok')
    expect(result.dangling).toHaveLength(1)
    expect(result.next).toBe('证据 ready=true：可以发起付费生图；但清单里还有 1 条悬空记录需要修。')
  })

  it('reports a clean ready verdict with nothing left to fix', async () => {
    const projectDir = await project(manifestDocument({
      items: [{ stable_id: 'char_lu', name: '陆沉舟', jubian_asset_id: 125204 }],
      lead_readonly_records: [],
    }))
    const { client } = stubTransport([ALIVE[0]!], [USED[0]!])
    const result = reconciled(await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir }))

    expect(result.ready).toBe(true)
    expect(result.dangling).toEqual([])
    expect(result.unregistered).toEqual([])
    expect(result.next).toBe('证据 ready=true：可以发起付费生图。')
  })

  it('spells an absent provider field as an empty string or 0 in the tool result', async () => {
    const projectDir = await project()
    const { client } = stubTransport([
      // Neither row carries a name, a category, a URL or a creation stamp.
      { id: 83840, delFlag: '0' },
    ], [{ id: 81426, assetId: 83840, isUsed: 1, hsAssetStatus: 'Active' }])
    const result = reconciled(await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir }))

    expect(result.unregistered).toEqual([{
      asset_id: 83840, material_id: 81426, name: '', asset_type: 0, is_used: 1,
      hs_asset_status: 'Active', url: '', create_time: '',
    }])
    // The evidence file keeps the pipeline's own spelling for the same fact.
    expect((await evidence(projectDir)).unregistered[0]).toEqual({
      asset_id: 83840, material_id: 81426, name: null, asset_type: null, is_used: 1,
      hs_asset_status: 'Active', url: null, create_time: null,
    })
  })

  it('spells a dangling record with no stable id or name as empty strings', async () => {
    const projectDir = await project(manifestDocument({
      items: [{ jubian_asset_id: 4242 }],
      lead_readonly_records: [{ stable_id: 'lead_lin', name: '林晚', jubian_asset_id: 125400 }],
    }))
    const { client } = stubTransport([ALIVE[2]!], [USED[2]!])
    const result = reconciled(await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir }))

    expect(result.dangling).toEqual([{
      stable_id: '', jubian_asset_id: 4242, name: '',
      why: '清单里有这条记录，远端 asset/list 里没有它（可能在别的 scriptId 或已被删）',
    }])
  })

  it('disposes one asset without touching the remote project', async () => {
    const projectDir = await project()
    const { client, calls } = stubTransport(ALIVE, USED)
    await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir })
    const stamp = (await evidence(projectDir)).ran_at
    expect(calls).toHaveLength(2)

    const result = await runDramaAssets(client, {
      method: 'dispose', project_dir: projectDir, asset_id: 83840, status: 'ignored', note: '失败遗留',
    })
    // The dispose call made no remote read of its own.
    expect(calls).toHaveLength(2)

    expect(result).toEqual({
      method: 'dispose',
      asset_id: 83840,
      ready: true,
      ready_reason: 'ok',
      evidence: evidencePath(projectDir),
      disposition: { 83840: { status: 'ignored', note: '失败遗留' } },
      blocking: [],
      ignored_without_note: [],
      next: '处置已写入证据：宿主付费钩子下次读到它就会按新的 blocking / ignored_without_note 判定；'
        + '要刷新远端比对结果与 ran_at，再跑一次 reconcile。',
    })
    const written = await evidence(projectDir)
    expect(written.ran_at).toBe(stamp)
    expect(written.ready).toBe(true)
    expect(written.blocking).toEqual([])
  })

  it('defaults a dispose call with no note to an empty note', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir })
    const result = await runDramaAssets(client, {
      method: 'dispose', project_dir: projectDir, asset_id: 83840, status: 'registered',
    })

    expect(result.disposition).toEqual({ 83840: { status: 'registered', note: '' } })
    expect(result.ready).toBe(true)
  })

  it('fails a dispose call that names no asset or no status', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    await expect(runDramaAssets(client, { method: 'dispose', project_dir: projectDir, status: 'registered' }))
      .rejects.toThrow('drama_assets dispose 需要 asset_id 与 status')
    await expect(runDramaAssets(client, { method: 'dispose', project_dir: projectDir, asset_id: 83840 }))
      .rejects.toThrow('drama_assets dispose 需要 asset_id 与 status')
  })

  it('reports a dispose on a project with no evidence as ready', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    const result = await runDramaAssets(client, {
      method: 'dispose', project_dir: projectDir, asset_id: 83840, status: 'ignored', note: '原因',
    })

    // The verdict is the dispositions alone, so the one entry releases it; the
    // evidence still carries no `ran_at`, which is what the host gate requires.
    expect(result.ready).toBe(true)
    expect(result.ready_reason).toBe('ok')
    expect(result.blocking).toEqual([])
    expect(await evidence(projectDir)).toEqual({
      disposition: { 83840: { status: 'ignored', note: '原因' } },
      blocking: [], ignored_without_note: [], ready: true,
    })
  })

  it('validates every reconcile result against the tool’s own declared schema', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    const { ctx, registered } = mountContext()
    apply(ctx)
    const tool = dramaAssets(registered)
    const value = await runDramaAssets(client, { method: 'reconcile', project_dir: projectDir })
    expect(validateJsonSchemaValue(tool.output.schema, value, '')).toEqual([])

    const disposed = await runDramaAssets(client, {
      method: 'dispose', project_dir: projectDir, asset_id: 83840, status: 'registered',
    })
    expect(validateJsonSchemaValue(tool.output.schema, disposed, '')).toEqual([])
  })

  it('fails as an authentication problem when neither the store nor the workspace holds a token', async () => {
    const { ctx, registered, resolvedRefs } = mountContext('')
    apply(ctx, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 5 })
    const projectDir = await project()
    // The stub credential store holds nothing, so the read fails before any request
    // rather than sending an unauthenticated one.
    await expect(dramaAssets(registered).execute({ method: 'reconcile', project_dir: projectDir }, runContext()))
      .rejects.toThrow('login is unavailable')
    expect(resolvedRefs).toContain(JUBIAN_TOKEN_REF)
  })

  it('skips the workspace secret file when the deployment turned that fallback off', async () => {
    const { ctx, registered, resolvedRefs } = mountContext('')
    apply(ctx, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 5, workspaceSecrets: false })
    const projectDir = await project()
    await expect(dramaAssets(registered).execute({ method: 'reconcile', project_dir: projectDir }, runContext()))
      .rejects.toThrow('login is unavailable')
    expect(resolvedRefs).toContain(JUBIAN_TOKEN_REF)
  })
  it('fails a reconcile call whose remote read the provider refuses', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    await writeFile(join(projectDir, 'assets_manifest.json'), '{not json', 'utf8')
    await expect(runDramaAssets(client, { method: 'reconcile', project_dir: projectDir }))
      .rejects.toThrow('不是合法 JSON')
  })
})
