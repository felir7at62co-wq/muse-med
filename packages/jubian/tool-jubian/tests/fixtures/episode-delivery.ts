/** Actual recovery and episode services with a controlled local renderer provider. */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createVideoRecoveryFixture } from './video-recovery-service.ts'
import { JubianEpisodeDelivery } from '../../src/episode-delivery-service.ts'
import { hashEpisodeFile } from '../../src/episode-delivery.ts'
import type { ApprovedEpisodeRenderer, EpisodeRendererGeneration, ExecutionDrain, ExecutionIdentity, Sha256 } from '../../src/episode-delivery.ts'

/**
 * Mount both actual services and an owned deterministic local renderer with an explicit render barrier.
 * @returns Real project/ledger/services, authored inputs, local renderer controls and owned cleanup.
 */
export async function createEpisodeDeliveryFixture() {
  const fixture = await createVideoRecoveryFixture()
  const { ctx, project, directory } = fixture
  await fixture.service.configure({ enabled: false, projectDir: project })
  await fixture.service.review({ ...fixture.input, action: 'approve' })
  const editing = join(project, 'editing'); await mkdir(editing)
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({ schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: fixture.key, review_digest: fixture.input.digest }],
    timeline: 'editing/timeline.json', subtitle_srt: 'editing/subtitles.srt', mix_profile: 'editing/mix.json' }))
  await writeFile(join(editing, 'timeline.json'), JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 1 }))
  await writeFile(join(editing, 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nLocal fixture\n')
  await writeFile(join(editing, 'mix.json'), '{"schema_version":1,"mode":"no_bgm"}')
  let enter: () => void = () => {}, release: () => void = () => {}
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const providerLifetime = new AbortController()
  const renderer = { calls: 0, encodes: 0, captures: 0, mode: 'complete' as 'complete' | 'unknown' | 'failed' | 'retry-required', entered,
    release, dispose: () => { providerLifetime.abort(new Error('Controlled renderer disposed')) } }
  const digest = (value: string): Sha256 => brandString<Sha256>(createHash('sha256').update(value).digest('hex'))
  const provider: ApprovedEpisodeRenderer = {
    capture: async () => {
      renderer.captures++
      return { identity: { generation: brandString<EpisodeRendererGeneration>(randomUUID()),
        configurationSha256: digest('configuration'), codeSha256: digest('code') }, runtimeInputs: [], signal: providerLifetime.signal,
      render: async (input, signal) => {
        renderer.calls++; enter()
        const previous = await input.job.read()
        if (previous?.executionRef !== null && previous?.executionRef !== undefined) {
          const { readEpisodeRecord, executionDrainSchema } = await import('../../src/episode-delivery.ts')
          const raw = await readEpisodeRecord(join(input.job.attemptRoot, 'drained-' + previous.executionRef.identity.execution + '.json'), 1000000)
          if (raw !== undefined) {
            const proof = executionDrainSchema.parse(raw)
            if (renderer.mode === 'retry-required' && proof.result !== 'completed') return { kind: 'retry-required', proof }
            if (proof.result === 'completed') {
              const admitted = await input.job.readExecution(proof.identity.execution)
              if (admitted === undefined) throw new Error('Fixture lost completed admission')
              return { kind: 'reconcile', proof, candidate: { path: admitted.candidatePath, sha256: proof.candidate.outputSha256,
                bytes: proof.candidate.outputBytes, width: 1080, height: 1920, durationUs: 1000000, video: true, audio: true } }
            }
          }
        }
        const source = input.sources[0]
        if (source === undefined) throw new Error('Fixture has no approved source')
        const inputsRoot = join(input.job.attemptRoot, 'inputs'); await mkdir(inputsRoot, { recursive: true })
        const staged = join(inputsRoot, 'source.mp4')
        await copyFile(source.path, staged)
        const stagedFacts = await hashEpisodeFile(staged, signal)
        await input.job.admit({ approvals: [{ idempotencyKey: source.idempotencyKey, digest: source.digest, sha256: source.sha256 }],
          inputs: [{ path: staged, sha256: stagedFacts.sha256, bytes: stagedFacts.bytes }] })
        const descriptorPath = join(input.stageRoot, 'descriptor.json'), descriptor = JSON.stringify({ identity: input.identity, execution: input.execution })
        await writeFile(descriptorPath, descriptor)
        const identity: ExecutionIdentity = { ...input.identity, execution: input.execution, descriptorSha256: digest(descriptor) }
        const candidatePath = join(input.stageRoot, 'candidate.mp4')
        await input.job.admitExecution({ identity, descriptorPath, candidatePath, retry: input.retry })
        const running = { version: 1 as const, kind: 'running' as const, identity, guardianPid: process.pid }
        await input.job.assertAdmission(identity); await input.job.armExecution(running)
        renderer.encodes++
        await writeFileAtomic(join(input.job.attemptRoot, 'execution.json'), JSON.stringify(running), { mode: 0o600 })
        await Promise.race([barrier, new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve() }, { once: true }) })])
        if (renderer.mode === 'unknown') return { kind: 'unknown', previous: running, diagnostic: 'Controlled unknown guardian outcome' }
        if (signal.aborted) {
          const proof: ExecutionDrain = { ...running, kind: 'drained', commands: 0, result: 'cancelled' }
          await writeFileAtomic(join(input.job.attemptRoot, 'drained-' + input.execution + '.json'), JSON.stringify(proof), { mode: 0o600 })
          return { kind: 'drained', proof }
        }
        if (renderer.mode === 'failed') {
          const proof: ExecutionDrain = { ...running, kind: 'drained', commands: 1, result: 'failed' }
          await writeFileAtomic(join(input.job.attemptRoot, 'drained-' + input.execution + '.json'), JSON.stringify(proof), { mode: 0o600 })
          return { kind: 'drained', proof }
        }
        await writeFile(candidatePath, 'full episode fixture bytes')
        const actual = await hashEpisodeFile(candidatePath, signal)
        const proof: ExecutionDrain = { ...running, kind: 'drained', commands: 1, result: 'completed',
          candidate: { outputSha256: actual.sha256, outputBytes: actual.bytes } }
        await writeFileAtomic(join(input.job.attemptRoot, 'drained-' + input.execution + '.json'), JSON.stringify(proof), { mode: 0o600 })
        return { kind: 'drained', proof, candidate: { path: candidatePath, sha256: actual.sha256, bytes: actual.bytes,
          width: 1080, height: 1920, durationUs: 1000000, video: true, audio: true } }
      } }
    },
  }
  const removeRenderer = ctx.effect(() => ctx.provide('approvedEpisodeRenderer', provider))
  const episodeOptions = { metadataMaxBytes: 1000000, recordBytes: 1000000, lockWaitMs: 1000 }
  const fiber = ctx.plugin(JubianEpisodeDelivery, episodeOptions)
  await fiber.await()
  return { ...fixture, recovery: fixture.service, service: ctx.jubianEpisodeDelivery, episodeFiber: fiber,
    planInput: { projectDir: project, episode: 1 }, renderer, provider, removeRenderer, episodeOptions, sourceBytes: Buffer.from('approved bytes'), directory }
}
