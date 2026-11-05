/** Real Loader, original-key reads, managed FFmpeg and explicit local operator delivery. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { buildNativeVideoPreview } = await importSnapshotModule(new URL('../../../packages/jubian/jubian-api/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/jubian-api/lib/index.js', import.meta.url))
const { JubianClient, JubianLedger } = await importSnapshotModule(new URL('../../../packages/jubian/jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/jubian/lib/index.js', import.meta.url))

/** Deterministic frozen submission evidence; no charge is dispatched to create it. */
export function previewFixture() {
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/recovery-lead.jpg'
  const model = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, genNum: 1,
    ratio: '9:16', resolution: '720p', prompt: '@[Lead](lead)', materialList: [], backupModelList: [] }
  return buildNativeVideoPreview({ createdAt: '2026-11-05T00:00:00Z',
    storyboard: { id: 1, scriptId: 2708, episodeId: 9, episodeCount: 1, modelConfig: JSON.stringify(model),
      storyboardMaterialList: [{ assetId: 'lead-id', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
        materialType: 'image', materialUrl: url, sortOrder: 1 }] },
    assets: [{ id: 81285, scriptId: 2708, assetUrl: url, hsAssetId: 'lead-id', hsAssetStatus: 'Active',
      isUsed: 1, official: true, asset_status: 'confirmed' }],
    models: [{ ...model, id: 11, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }] })
}

export const name = 'snapshot-muse-video-recovery'
export const inject = ['subprocess', 'llm', 'tools', 'sessions', 'credentials']

/**
 * Keep production recovery and media paths real; provide only local provider data and CDN bytes.
 * @param ctx - Shipped Headless profile context.
 */
export async function apply(ctx) {
  const jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
  const recovery = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/video-recovery.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/types/video-recovery.js', import.meta.url))
  const media = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/video-media-check.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/types/video-media-check.js', import.meta.url))
  const cwd = process.cwd(), project = join(cwd, '.dsh', 'recovery-project'), tasks = join(project, 'video_tasks')
  await mkdir(tasks, { recursive: true })
  const canonical = await realpath(project)
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":2708}\n')
  const preview = previewFixture(), key = preview.idempotencyKey
  const previewPath = join(canonical, 'video_tasks', 'original.storyboard-native.prepared.json')
  await writeFile(previewPath, JSON.stringify(preview) + '\n')
  const ledgerRoot = join(cwd, '.dsh', 'recovery-ledger'), ledger = new JubianLedger({ root: ledgerRoot })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 2708,
    requestSha256: 'sha256:' + createHash('sha256').update(JSON.stringify(preview.payload)).digest('hex'),
    beforeTaskIds: [], videoPreviewPath: previewPath })
  const originalRecords = await ledger.records()
  const ffmpegPath = await ctx.subprocess.resolveExecutable(process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH ?? 'ffmpeg')
  const source = join(tasks, 'source.mp4')
  const generator = ctx.subprocess.spawn({ argv: [ffmpegPath, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'color=black:size=32x32:rate=10', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], cwd: canonical, graceMs: 100,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
  const generated = await generator.done
  assert.equal(await generator.waitForExit(), true)
  assert.equal(generated.exitCode, 0, generator.collected.stderr?.readFrom(0).text)
  const bytes = await readFile(source), sha = createHash('sha256').update(bytes).digest('hex')
  const outputUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/recovery-original.mp4'
  let baseUrl, rejected, mediaReads = 0
  const calls = []
  const task = { id: 42, scriptId: 2708, episodeId: 9, episodeCount: 1, taskType: 1, taskStatus: 'succeeded' }
  const child = { id: 51, aigcVideoTaskId: 42, storyboardId: 1, taskStatus: 'succeeded',
    imageMaterials: preview.payload.storyboardMaterialList, modelConfig: preview.payload.modelConfig,
    resultList: [{ firstResultId: 151, taskType: 1, resultStatus: 'succeeded', lastTaskType: 1,
      lastResultStatus: 'succeeded', tosVideoUrl: outputUrl, lastTosVideoUrl: outputUrl }] }
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-recovery-provider', onCleanup() {},
    onListening: address => { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener(request, response) {
      let body = ''
      request.on('data', part => { body += part.toString('utf8') })
      request.once('end', () => {
        try {
          const url = new URL(request.url, baseUrl)
          calls.push({ method: request.method, path: url.pathname })
          let data
          if (request.method === 'GET' && url.pathname === '/admin/aigc/video/task/list') data = { total: 1, rows: [task] }
          else if (request.method === 'GET' && url.pathname === '/admin/aigc/video/task/42') data = task
          else if (request.method === 'POST' && url.pathname === '/admin/aigc/video/task/sub/list') {
            const input = JSON.parse(body)
            assert.deepEqual(Object.keys(input), ['aigcVideoTaskId'])
            assert.equal(String(input.aigcVideoTaskId), '42')
            data = { total: 1, rows: [child] }
          } else throw new Error('Recovery attempted an unapproved provider operation')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 200, data }))
        } catch (error) {
          rejected = error
          response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"code":500}')
        }
      })
    },
  })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url === outputUrl) {
        assert.ok(init?.method === undefined || init.method === 'GET'); mediaReads++
        return new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } })
      }
      assert.equal(new URL(url).origin, baseUrl, 'The fixture cannot call an external account or model')
      return original(input, init)
    }
    return () => { globalThis.fetch = original }
  })
  const decoder = { subprocess: ctx.subprocess, ffmpegPath, timeoutMs: 5000, graceMs: 100, maxOutputBytes: 4096 }
  const client = new JubianClient({ credential: async () => 'offline-recovery', baseUrl })
  await recovery.runVideoRecovery(client, ledger, canonical, [key], 10, AbortSignal.timeout(10000),
    () => { throw new Error('The real recovery worker could not finish its local provider check') },
    (url, signal) => media.checkVideoMedia(url, decoder, signal))
  assert.equal(rejected, undefined)
  assert.equal(mediaReads, 1)
  const evidence = await recovery.reviewRecoveredVideo(canonical, key)
  assert.equal(evidence.evidence.media_checks[0].sha256, 'sha256:' + sha)
  assert.equal(evidence.evidence.media_checks[0].video, true)
  assert.equal(evidence.evidence.media_checks[0].audio, true)
  await ctx.plugin(jubian, { baseUrl, ledgerRoot, workspaceSecrets: false, videoRecoverySettings: true,
    videoRecoveryFfmpegPath: ffmpegPath, videoRecoveryDecodeTimeoutMs: 5000, videoRecoveryDecodeGraceMs: 100 }).await()
  let operator
  await ctx.inject(['jubianVideoRecovery'], scope => { operator = scope.jubianVideoRecovery }).await()
  await operator.configure({ enabled: false, projectDir: canonical })
  let successful = 0
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['jubian_storyboard'], includeOwn: true }))
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') {
      assert.notEqual(event.data.message.isError, true)
      assert.ok(JSON.stringify(event.data.message.content).includes('submitted'))
      successful++
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, 'deepseek-official')
    assert.ok(options.tools.some(tool => tool.name === 'jubian_storyboard' || tool.name === 'run_code'))
    yield* next()
  })
  ctx.on('agent/turn-stopping', async () => {
    assert.equal(successful, 1)
    assert.equal(rejected, undefined)
    assert.deepEqual(await ledger.records(), originalRecords)
    const selected = (await operator.status()).reports[0]
    assert.equal(selected.idempotencyKey, key)
    await operator.review({ action: 'approve', idempotencyKey: key, digest: selected.digest })
    const delivered = await operator.deliverApprovedMp4({ idempotencyKey: key, digest: selected.digest })
    const initialMediaReads = mediaReads
    const path = join(canonical, delivered.directDelivery.path)
    assert.deepEqual(await readFile(path), bytes)
    const identity = await stat(path)
    await unlink(join(tasks, 'review', 'original-' + sha + '.mp4'))
    await operator.deliverApprovedMp4({ idempotencyKey: key, digest: selected.digest })
    await unlink(join(tasks, 'review', selected.digest + '.direct-delivery.json'))
    await operator.deliverApprovedMp4({ idempotencyKey: key, digest: selected.digest })
    const repeated = await stat(path)
    assert.equal(repeated.dev, identity.dev); assert.equal(repeated.ino, identity.ino)
    assert.equal(mediaReads, initialMediaReads, 'Existing approved output cannot trigger another provider download')
    assert.deepEqual(await ledger.records(), originalRecords)
    assert.ok(calls.every(call => call.method === 'GET' || (call.method === 'POST' && call.path === '/admin/aigc/video/task/sub/list')))
    await writeFile(join(cwd, 'recovery-proof.json'), JSON.stringify({ originalIntentCount: 1, newIntents: 0,
      generationPuts: 0, nativeResult: 'submitted', providerReadsOnly: true, decodedTracks: ['video', 'audio'],
      sameFileBytes: true, offlineReplay: true, receiptRepaired: true, existingInodePreserved: true }, null, 2) + '\n')
  })
}
