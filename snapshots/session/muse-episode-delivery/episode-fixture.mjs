/** Real Loader/service admission through a test-only Native/PTC bridge; controlled local renderer, no media-quality claim. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

export const name = 'snapshot-muse-episode-delivery'
export const inject = ['subprocess', 'tools', 'credentials']

/** Mount shipped Jubian and consume its real three-RPC service through one fixture-only tool. */
export async function apply(ctx) {
  const jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
  const library = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/episode-delivery.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/types/episode-delivery.js', import.meta.url))
  const { JubianLedger } = await importSnapshotModule(new URL('../../../packages/jubian/jubian/src/index.ts', import.meta.url),
    new URL('../../../packages/jubian/jubian/lib/index.js', import.meta.url))
  const { defineTool } = await importSnapshotModule(new URL('../../../packages/core/tools/src/index.ts', import.meta.url),
    new URL('../../../packages/core/tools/lib/index.js', import.meta.url))
  const hash = value => createHash('sha256').update(value).digest('hex')
  const cwd = process.cwd(), project = join(cwd, '.dsh', 'episode-project'), ledgerRoot = join(cwd, '.dsh', 'episode-ledger')
  const review = join(project, 'video_tasks', 'review'), editing = join(project, 'editing')
  await mkdir(review, { recursive: true }); await mkdir(editing, { recursive: true })
  const canonical = await realpath(project), key = 'original-approved-episode-source'
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}\n')
  const preview = join(project, 'video_tasks', 'preview.json'); await writeFile(preview, '{}')
  const sourceBytes = Buffer.from('approved original bytes'), sourceSha = hash(sourceBytes)
  await writeFile(join(review, 'original-' + sourceSha + '.mp4'), sourceBytes)
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + sourceSha, video: true, audio: true }] })
  await writeFile(join(review, hash(key) + '.json'), evidence)
  const ledger = new JubianLedger({ root: ledgerRoot })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'original', scriptId: 1,
    beforeTaskIds: [], videoPreviewPath: preview })
  const original = await ledger.records()
  let baseUrl
  const requests = []
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-episode-provider-tripwire', onCleanup() {},
    onListening: address => { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener(request, response) {
      requests.push(request.method)
      response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"code":500}')
    },
  })
  await ctx.plugin(jubian, { baseUrl, ledgerRoot, workspaceSecrets: false, videoRecoverySettings: true,
    videoRecoveryFfmpegPath: process.execPath }).await()
  let recovery
  await ctx.inject(['jubianVideoRecovery'], scope => { recovery = scope.jubianVideoRecovery }).await()
  await recovery.configure({ enabled: false, projectDir: canonical })
  await recovery.review({ idempotencyKey: key, digest: hash(evidence), action: 'approve' })
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({ schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: key, review_digest: hash(evidence) }], timeline: 'editing/timeline.json',
    subtitle_srt: 'editing/subtitles.srt', mix_profile: 'editing/mix.json' }))
  await writeFile(join(editing, 'timeline.json'), '{"clips":[{"shot":1,"start_us":0,"duration_us":1000000}],"body_end":1}')
  await writeFile(join(editing, 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nFixture\n')
  await writeFile(join(editing, 'mix.json'), '{"schema_version":1,"mode":"no_bgm"}')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('Fixture renderer disposed')) })
  let entered, release, calls = 0
  const started = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  ctx.effect(() => ctx.provide('approvedEpisodeRenderer', {
    async capture() {
      return { identity: { generation: randomUUID(), configurationSha256: hash('local configuration'), codeSha256: hash('controlled renderer') },
        runtimeInputs: [], signal: lifetime.signal,
        async render(input, signal) {
          calls++; entered()
          const source = input.sources[0], staged = join(input.job.attemptRoot, 'inputs', 'original.mp4')
          await mkdir(join(input.job.attemptRoot, 'inputs'), { recursive: true })
          await copyFile(source.path, staged)
          await input.job.admit({ approvals: [{ idempotencyKey: source.idempotencyKey, digest: source.digest, sha256: source.sha256 }],
            inputs: [{ path: staged, sha256: source.sha256, bytes: source.bytes }] })
          const descriptorPath = join(input.stageRoot, 'descriptor.json'), descriptor = JSON.stringify({ identity: input.identity, execution: input.execution })
          await writeFile(descriptorPath, descriptor)
          const identity = { ...input.identity, execution: input.execution, descriptorSha256: hash(descriptor) }
          const candidatePath = join(input.stageRoot, 'candidate.mp4')
          await input.job.admitExecution({ identity, descriptorPath, candidatePath, retry: input.retry })
          const running = { version: 1, kind: 'running', identity, guardianPid: process.pid }
          await input.job.assertAdmission(identity); await input.job.armExecution(running)
          await writeFile(join(input.job.attemptRoot, 'execution.json'), JSON.stringify(running))
          await held; signal.throwIfAborted()
          await writeFile(candidatePath, 'controlled full episode bytes')
          const actual = await library.hashEpisodeFile(candidatePath, signal)
          const proof = { ...running, kind: 'drained', commands: 0, result: 'completed',
            candidate: { outputSha256: actual.sha256, outputBytes: actual.bytes } }
          await writeFile(join(input.job.attemptRoot, 'drained-' + input.execution + '.json'), JSON.stringify(proof))
          return { kind: 'drained', proof, candidate: { path: candidatePath, sha256: actual.sha256, bytes: actual.bytes,
            width: 32, height: 32, durationUs: 1000000, video: true, audio: true } }
        } }
    },
  }))

  let service
  await ctx.inject(['jubianEpisodeDelivery'], scope => { service = scope.jubianEpisodeDelivery }).await()
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'snapshot_episode_delivery',
    description: 'Test-only bridge to actual local episode readiness, admission and targeted status.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      admitted: { type: 'boolean', required: true }, duplicateSameAttempt: { type: 'boolean', required: true },
      rendererCalls: { type: 'integer', required: true }, status: { type: 'string', required: true },
      newPaidIntents: { type: 'integer', required: true }, generationPuts: { type: 'integer', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute() {
      const readiness = await service.episodeReadiness({ projectDir: canonical, episode: 1 })
      assert.equal(readiness.ready, true, readiness.issues.join('; '))
      const target = { projectDir: canonical, episode: 1, digest: readiness.digest }
      const admitted = await service.admitEpisode(target)
      assert.equal(admitted.state, 'queued')
      await started
      const duplicate = await service.admitEpisode(target)
      assert.equal(duplicate.attempt, admitted.attempt); assert.equal(calls, 1)
      const pending = await service.episodeStatus(target)
      assert.ok(['preparing', 'running'].includes(pending.state))
      release()
      let status, deadline = Date.now() + 10000
      do { status = await service.episodeStatus(target); await new Promise(resolve => setImmediate(resolve)) }
      while (['queued', 'preparing', 'running'].includes(status.state) && Date.now() < deadline)
      assert.equal(status.state, 'completed', JSON.stringify(status))
      assert.deepEqual(await readFile(join(canonical, status.output.path)), Buffer.from('controlled full episode bytes'))
      assert.deepEqual(await ledger.records(), original)
      assert.deepEqual(requests, [], 'No provider HTTP operation is permitted')
      const result = { admitted: true, duplicateSameAttempt: true, rendererCalls: calls, status: 'completed',
        newPaidIntents: (await ledger.records()).length - original.length, generationPuts: requests.filter(method => method === 'PUT').length }
      await writeFile(join(cwd, 'episode-proof.json'), JSON.stringify(result, null, 2) + '\n')
      return result
    },
  })))
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') assert.notEqual(event.data.message.isError, true)
    if (event.type === 'tool/ptc-dispatch') assert.equal(event.data.isError, false)
  })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['snapshot_episode_delivery'], includeOwn: true }))
  })
}
