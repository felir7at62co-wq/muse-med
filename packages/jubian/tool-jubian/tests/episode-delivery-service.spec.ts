/** Real service admission, source ownership and publication with a controlled local renderer. */
import { chmod, cp, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import * as Files from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import type { VideoArtifactSha256 } from '../src/types.ts'
import { describe, expect, it, vi } from 'vitest'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import * as library from '../src/episode-delivery.ts'
import * as Recovery from '../src/video-recovery.ts'
import { VideoMediaDrainError } from '../src/video-media-check.ts'
import type { EpisodeRenderResult, ApprovedEpisodeRenderInput, ApprovedEpisodeRendererCapture } from '../src/episode-delivery.ts'
import { z } from 'zod'
import { JubianEpisodeDelivery, resolveEpisodeDelivery } from '../src/episode-delivery-service.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function selection(f: Awaited<ReturnType<typeof createEpisodeDeliveryFixture>>) {
  const ready = await f.service.episodeReadiness(f.planInput)
  expect(ready.ready, ready.issues.join('; ')).toBe(true)
  if (ready.digest === null) throw new Error('Expected readiness digest')
  return { ...f.planInput, digest: ready.digest }
}

function observeRenderer(f: Awaited<ReturnType<typeof createEpisodeDeliveryFixture>>,
  observe: (result: EpisodeRenderResult, input: ApprovedEpisodeRenderInput) => Promise<EpisodeRenderResult>) {
  const capture = f.provider.capture.bind(f.provider)
  return vi.spyOn(f.provider, 'capture').mockImplementation(async (input, signal) => {
    const actual = await capture(input, signal)
    return { ...actual, render: async (request, control) => observe(await actual.render(request, control), request) }
  })
}

describe('approved episode service', () => {
  it.each(['admitted', 'armed'] as const)('retains the %s job when its renderer fails before publishing a running record', async (phase) => {
    const f = await createEpisodeDeliveryFixture(), capture = f.provider.capture.bind(f.provider)
    const failure = new Error(`Controlled renderer failed after job ${phase}`)
    let completedPhase = false
    vi.spyOn(f.provider, 'capture').mockImplementation(async (input, signal) => {
      const actual = await capture(input, signal)
      return { ...actual, render: async (request, control) => {
        const admit = request.job.admit.bind(request.job), arm = request.job.armExecution.bind(request.job)
        const interrupted = phase === 'admitted'
          ? vi.spyOn(request.job, 'admit').mockImplementation(async (admission) => {
            await admit(admission); completedPhase = true; throw failure
          })
          : vi.spyOn(request.job, 'armExecution').mockImplementation(async (running) => {
            await arm(running); completedPhase = true; throw failure
          })
        try { return await actual.render(request, control) } finally { interrupted.mockRestore() }
      } }
    })
    const input = await selection(f), admitted = await f.service.admitEpisode(input)
    if (admitted.attempt === null) throw new Error('Expected an admitted episode')
    const state = phase === 'admitted' ? 'failed' : 'unknown'
    await vi.waitFor(async () => {
      expect(await f.service.episodeStatus(input)).toMatchObject({ state, problem: failure.message,
        attempt: admitted.attempt, canResume: phase === 'admitted' })
      expect(f.service.hasActiveWork()).toBe(phase === 'armed')
    })
    const root = join(f.project, '.muse', 'episode-delivery', admitted.attempt)
    const jobBytes = await readFile(join(root, 'job.json'))
    const job = library.parseEpisodeDeliveryJobRecord(JSON.parse(jobBytes.toString('utf8')))
    if (phase === 'admitted') expect(job.executionRef).toBeNull()
    else expect(job.executionRef).toMatchObject({ identity: { attempt: admitted.attempt } })
    await expect(stat(join(root, 'execution.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(f.project, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.service.admitEpisode(phase === 'armed' ? { ...input, resume: true } : input)).toMatchObject({ state,
      attempt: admitted.attempt, canResume: phase === 'admitted' })
    expect(await readFile(join(root, 'job.json'))).toEqual(jobBytes)
    expect(completedPhase).toBe(true)
    expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('refuses publication when the captured renderer input revalidation fails', async () => {
    const f = await createEpisodeDeliveryFixture()
    const capture = f.provider.capture.bind(f.provider)
    const revalidate = vi.fn(async () => { throw new Error('Captured subtitle clock changed') })
    vi.spyOn(f.provider, 'capture').mockImplementation(async (input, signal) => ({
      ...await capture(input, signal), revalidate,
    }))
    const input = await selection(f)
    await f.service.admitEpisode(input)
    f.renderer.release()
    await vi.waitFor(async () => {
      const status = await f.service.episodeStatus(input)
      expect(status.state).toBe('unknown')
      expect(status.problem).toContain('Captured subtitle clock changed')
    })
    expect(revalidate).toHaveBeenCalledOnce()
    const output = join(f.project, 'exports', `Muse-episode-01-${input.digest}.mp4`)
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps the renderer publication scope held through the actual source-owner publish', async () => {
    const f = await createEpisodeDeliveryFixture()
    const capture = f.provider.capture.bind(f.provider)
    let active = false, released = false, scopes = 0
    const withPublication: NonNullable<ApprovedEpisodeRendererCapture['withPublication']> = async (signal, publish) => {
      signal.throwIfAborted(); scopes++; active = true
      try { return await publish(signal) } finally { active = false; released = true }
    }
    vi.spyOn(f.provider, 'capture').mockImplementation(async (input, signal) => ({
      ...await capture(input, signal), withPublication,
    }))
    const input = await selection(f), output = join(f.project, 'exports', `Muse-episode-01-${input.digest}.mp4`)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let observed = false
    const linked = vi.spyOn(Files, 'link').mockImplementation(async (...args: Parameters<typeof actual.link>) => {
      if (args[1] === output) { expect(active).toBe(true); observed = true }
      return actual.link(...args)
    })
    try {
      await f.service.admitEpisode(input); f.renderer.release()
      await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
      expect(observed).toBe(true); expect(scopes).toBe(1); expect(released).toBe(true)
      expect(await readFile(output, 'utf8')).toBe('full episode fixture bytes')
      expect(f.fetch).not.toHaveBeenCalled()
    } finally { linked.mockRestore() }
  })

  it.each(['refused', 'cancelled'] as const)('retains the candidate when renderer publication is %s', async (failure) => {
    const f = await createEpisodeDeliveryFixture(), capture = f.provider.capture.bind(f.provider)
    let released = false
    const withPublication: NonNullable<ApprovedEpisodeRendererCapture['withPublication']> = async (_signal, publish) => {
      try {
        if (failure === 'refused') throw new Error('Source-review owner is unavailable')
        const cancelled = new AbortController(); cancelled.abort(new Error('Source-review owner revoked'))
        return await publish(cancelled.signal)
      } finally { released = true }
    }
    vi.spyOn(f.provider, 'capture').mockImplementation(async (input, signal) => ({
      ...await capture(input, signal), withPublication,
    }))
    const input = await selection(f)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => {
      const status = await f.service.episodeStatus(input)
      expect(status.state).toBe('unknown'); expect(status.problem).toContain(failure === 'refused' ? 'unavailable' : 'revoked')
    })
    expect(released).toBe(true); expect(f.renderer.encodes).toBe(1)
    await expect(stat(join(f.project, 'exports', `Muse-episode-01-${input.digest}.mp4`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('preserves completed state across a platform-specific atomic state observation', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    const admitted = await f.service.admitEpisode(input)
    await f.renderer.entered
    if (admitted.attempt === null) throw new Error('Expected original attempt')
    const statePath = join(f.project, '.muse', 'episode-delivery', admitted.attempt, 'state.json')
    const before = await stat(statePath), opening = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let held = false
    const spy = vi.spyOn(Files, 'open').mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      if (args[0] === statePath && !held) {
        held = true; opening.resolve(undefined); await proceed.promise
      }
      return actual.open(...args)
    })
    const observation = f.service.episodeStatus(input).then(status => ({ status }), (error: unknown) => ({ error }))
    try {
      await opening.promise
      f.renderer.release()
      await vi.waitFor(async () => {
        const state: unknown = JSON.parse(await readFile(statePath, 'utf8'))
        expect(state).toMatchObject({ state: 'completed', attempt: admitted.attempt })
      })
      expect((await stat(statePath)).ino).not.toBe(before.ino)
      proceed.resolve(undefined)
      const result = await observation
      if (process.platform === 'win32') {
        expect(result).toMatchObject({ error: new Error('Episode journal changed while opening') })
      } else {
        if ('error' in result) throw result.error
        expect(result.status).toMatchObject({ state: 'completed', attempt: admitted.attempt, canResume: false })
      }
      spy.mockRestore()
      expect(await f.service.episodeStatus(input)).toMatchObject({ state: 'completed', attempt: admitted.attempt, canResume: false })
      expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
      expect(f.fetch).not.toHaveBeenCalled()
    } finally { proceed.resolve(undefined); await observation; spy.mockRestore() }
  })
  it('admits once and returns while real render is held; targeted status never recaptures', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    const first = await f.service.admitEpisode(input)
    expect(first.state).toBe('queued')
    await f.renderer.entered
    expect((await f.service.admitEpisode(input)).attempt).toBe(first.attempt)
    expect((await f.service.episodeStatus(input)).state).toBe('running')
    expect(f.renderer.calls).toBe(1)
    expect(f.renderer.captures).toBe(1)
    expect(f.fetch).not.toHaveBeenCalled()
    f.renderer.release()
    await vi.waitFor(async () => { const status = await f.service.episodeStatus(input); expect(status.state, status.problem).toBe('completed') })
    const done = await f.service.episodeStatus(input)
    expect(done.output?.bytes).toBe(Buffer.byteLength('full episode fixture bytes'))
    expect(await readFile(join(f.project, done.output?.path ?? ''), 'utf8')).toBe('full episode fixture bytes')
    expect(f.service.hasActiveWork()).toBe(false)
  })
  it('does not combine a copied project plan with the currently selected project approvals', async () => {
    const f = await createEpisodeDeliveryFixture(), other = join(f.root, 'other')
    await cp(f.project, other, { recursive: true })
    const ready = await f.service.episodeReadiness({ projectDir: other, episode: 1 })
    expect(ready.ready).toBe(false)
    expect(ready.issues.join()).toContain('another selected project')
    expect(f.renderer.calls).toBe(0)
  })
  it('refuses readiness captured before a project generation replacement', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.recovery.configure({ enabled: false, projectDir: f.project })
    await expect(f.service.admitEpisode(input)).rejects.toThrow('generation')
    expect((await f.service.episodeStatus(input)).state).toBe('not-admitted')
    expect(f.renderer.calls).toBe(0)
  })
  it('does not change the logical digest when a renderer capture has a new generation', async () => {
    const f = await createEpisodeDeliveryFixture(), first = await f.service.episodeReadiness(f.planInput)
    const second = await f.service.episodeReadiness(f.planInput)
    expect(second.renderer?.generation).not.toBe(first.renderer?.generation)
    expect(second.digest).toBe(first.digest)
  })
  it('pauses admission synchronously without cancelling accepted work', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    f.service.pauseAdmission()
    await expect(f.service.admitEpisode(input)).rejects.toThrow('paused')
    f.service.resumeAdmission(); await f.service.admitEpisode(input); await f.renderer.entered
    f.service.pauseAdmission(); expect(f.service.hasActiveWork()).toBe(true)
    f.renderer.release()
    await vi.waitFor(async () => { const status = await f.service.episodeStatus(input); expect(status.state, status.problem).toBe('completed') })
  })
  it('keeps an unknown guardian fenced on repeated admission and status', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    f.renderer.mode = 'unknown'; await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { const status = await f.service.episodeStatus(input); expect(status.state, status.problem).toBe('unknown') })
    await f.service.admitEpisode(input)
    expect(f.renderer.calls).toBe(1); expect(f.service.hasActiveWork()).toBe(true)
  })
  it('reports unadmitted targets without preparing a renderer or source inventory', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    expect((await f.service.episodeStatus(input)).state).toBe('not-admitted')
    expect(f.renderer.captures).toBe(1); expect(f.renderer.calls).toBe(0)
  })
  it('rejects a changed destination and preserves its bytes', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await mkdir(join(f.project, 'exports'))
    const path = join(f.project, 'exports', `Muse-episode-01-${input.digest}.mp4`)
    await writeFile(path, 'occupied')
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { const status = await f.service.episodeStatus(input); expect(status.state, status.problem).toBe('unknown') })
    expect(await readFile(path, 'utf8')).toBe('occupied')
  })
  it('repairs a missing publication receipt offline without source IO or a second encode', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    const done = await f.service.episodeStatus(input)
    if (done.attempt === null || done.output === undefined) throw new Error('Expected completed publication')
    const path = join(f.project, done.output.path), before = await stat(path)
    await unlink(join(f.project, '.muse', 'episode-delivery', done.attempt, 'receipt.json'))
    const original = (await import('node:fs/promises')).readdir(f.directory)
    for (const name of await original) if (name.startsWith('original-')) await unlink(join(f.directory, name))
    const recoverable = await f.service.episodeStatus(input)
    expect(recoverable.canResume).toBe(true)
    expect((await f.service.admitEpisode({ ...input, resume: true })).attempt).toBe(done.attempt)
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    expect((await stat(path)).ino).toBe(before.ino)
    expect(f.renderer.calls).toBe(1); expect(f.renderer.captures).toBe(1)
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.service.hasActiveWork()).toBe(false)
  })
  it('restarts the service and reconciles a completed old execution without encoding it again', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    const done = await f.service.episodeStatus(input)
    if (done.output === undefined) throw new Error('Expected output')
    await unlink(join(f.project, done.output.path))
    // Lost state after a completed guardian is recoverable only through the explicit original task.
    await f.episodeFiber.dispose()
    await f.ctx.plugin(JubianEpisodeDelivery, f.episodeOptions).await()
    const service = f.ctx.jubianEpisodeDelivery
    // A complete receipt is a historical measurement, so status does not perform a media scan.
    expect((await service.episodeStatus(input)).state).toBe('completed')
    expect((await service.episodeStatus(input)).canResume).toBe(true)
    await service.admitEpisode({ ...input, resume: true })
    await vi.waitFor(async () => { const state = await service.episodeStatus(input); expect(state.state, state.problem).toBe('completed') })
    expect((await service.episodeStatus(input)).attempt).toBe(done.attempt)
    expect(f.renderer.encodes).toBe(1)
    expect(service.hasActiveWork()).toBe(false)
  })

  it('preserves unknown footprints when the original intent alone is removed', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    const admitted = await f.service.admitEpisode(input); await f.renderer.entered
    if (admitted.attempt === null) throw new Error('Expected attempt')
    const root = join(f.project, '.muse', 'episode-delivery', admitted.attempt)
    await vi.waitFor(async () => { expect(await readdir(root)).toContain('execution.json') })
    await unlink(join(root, 'intent.json'))
    const status = await f.service.episodeStatus(input)
    expect(status).toMatchObject({ state: 'unknown', attempt: admitted.attempt, canResume: false })
    await expect(f.service.admitEpisode(input)).rejects.toThrow('evidence')
    expect(f.renderer.calls).toBe(1)
    expect(await readdir(root)).toContain('execution.json')
    f.renderer.release()
  })
  it('clears a second observer fence only after the original guardian drains and publication is recorded', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); await f.renderer.entered
    const scope = f.ctx.isolate('jubianEpisodeDelivery')
    const fiber = scope.plugin(JubianEpisodeDelivery, f.episodeOptions); await fiber.await()
    const observer = scope.jubianEpisodeDelivery
    expect((await observer.episodeStatus(input)).state).toBe('unknown')
    expect(observer.hasActiveWork()).toBe(true)
    f.renderer.release()
    await vi.waitFor(async () => { expect((await observer.episodeStatus(input)).state).toBe('completed') })
    expect(observer.hasActiveWork()).toBe(false)
  })
  it('rejects a prepared publication whose ctime changes after its full hash', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), actualHash = library.hashEpisodeFile
    const spy = vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
      const version = await actualHash(path, signal)
      if (path.includes(sep + 'publish-')) await chmod(path, 0o400)
      return version
    })
    try {
      await f.service.admitEpisode(input); f.renderer.release()
      await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('unknown') })
      const files = await readdir(join(f.project, 'exports'))
      expect(files).toEqual([])
    } finally { spy.mockRestore() }
  })
  it('keeps the recovery queue free while a real admission file lock is held', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), originalLock = atomic.withFileLock
    let release: () => void = () => {}, entered: () => void = () => {}, target = ''
    const held = new Promise<void>((resolve) => { release = resolve }), locked = new Promise<void>((resolve) => { entered = resolve })
    const controller = new AbortController()
    let holding: Promise<void> | undefined
    const spy = vi.spyOn(atomic, 'withFileLock').mockImplementation(async (path, action, options) => {
      if (path.endsWith(sep + 'intent.json') && target === '') {
        target = path
        holding = originalLock(path, async () => { entered(); await held }, options)
        await locked
      }
      return originalLock(path, action, options)
    })
    const admission = f.ctx.extend({ invocation: {
      request: { namespace: 'jubianEpisodeDelivery', method: 'admitEpisode', args: input }, service: 'jubianEpisodeDelivery',
      peer: { id: brandString<PeerId>('episode-test-peer'), ctx: f.ctx, dispose: async () => {} },
      signal: controller.signal, async *uplink() {},
    } }).jubianEpisodeDelivery.admitEpisode(input)
    const rejected = expect(admission).rejects.toThrow()
    try {
      await locked
      await f.recovery.configure({ enabled: false, projectDir: f.project })
      controller.abort(new Error('Admission client disconnected'))
      release(); await rejected
      expect((await f.service.episodeStatus(input)).state).toBe('not-admitted')
      expect(f.renderer.calls).toBe(0)
    } finally { release(); await holding; spy.mockRestore() }
  })
  it('allows an explicitly cancelled queued task to resume its original attempt without inventing a new intent', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    const planPath = join(f.project, 'editing', '01-episode-delivery.json')
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Record<string, string | number | object>
    await writeFile(join(f.project, 'editing', '02-episode-delivery.json'), JSON.stringify({ ...plan, episode: 2 }))
    const secondReady = await f.service.episodeReadiness({ projectDir: f.project, episode: 2 })
    if (secondReady.digest === null) throw new Error(secondReady.issues.join())
    const secondInput = { projectDir: f.project, episode: 2, digest: secondReady.digest }
    await f.service.admitEpisode(input); await f.renderer.entered
    const second = await f.service.admitEpisode(secondInput)
    await f.recovery.configure({ enabled: false, projectDir: f.project })
    const cancelled = await f.service.episodeStatus(secondInput)
    expect(cancelled).toMatchObject({ state: 'cancelled', canResume: true, attempt: second.attempt })
    expect(f.renderer.encodes).toBe(1)
    await f.service.admitEpisode({ ...secondInput, resume: true }); f.renderer.release()
    await vi.waitFor(async () => { const state = await f.service.episodeStatus(secondInput); expect(state.state, state.problem).toBe('completed') })
    expect((await f.service.episodeStatus(secondInput)).attempt).toBe(second.attempt)
    expect(f.renderer.encodes).toBe(2); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('resolves bounded deployment options and refuses invalid configuration', () => {
    expect(resolveEpisodeDelivery({})).toEqual({ metadataMaxBytes: 1048576, recordBytes: 1048576, lockWaitMs: 30000,
      historyScanLimit: 1000, historyResultLimit: 50, historyMetadataMaxBytes: 4194304 })
    expect(resolveEpisodeDelivery({ episodeDeliveryMetadataMaxBytes: 1, episodeDeliveryRecordBytes: 2, episodeDeliveryLockWaitMs: 3 }))
      .toEqual({ metadataMaxBytes: 1, recordBytes: 2, lockWaitMs: 3,
        historyScanLimit: 1000, historyResultLimit: 50, historyMetadataMaxBytes: 4194304 })
    for (const field of ['episodeDeliveryMetadataMaxBytes', 'episodeDeliveryRecordBytes', 'episodeDeliveryLockWaitMs']) {
      for (const value of [0, -1, 0.5, Number.NaN, 16777217]) expect(() => resolveEpisodeDelivery({ [field]: value })).toThrow('bounded')
    }
  })

  it('keeps the namespace available with an absent or failed renderer', async () => {
    const f = await createEpisodeDeliveryFixture()
    const failed = vi.spyOn(f.provider, 'capture').mockRejectedValueOnce('renderer unavailable')
    expect((await f.service.episodeReadiness(f.planInput)).issues).toContain('renderer unavailable')
    failed.mockRestore(); await f.removeRenderer()
    expect((await f.service.episodeReadiness(f.planInput)).issues).toContain('Episode renderer is unavailable')
    f.service.pauseAdmission()
    expect((await f.service.episodeReadiness(f.planInput)).issues).toContain('Episode admission is paused')
  })
  it('rejects relative paths, file projects and admission without matching readiness', async () => {
    const f = await createEpisodeDeliveryFixture()
    await expect(f.service.episodeReadiness({ projectDir: 'relative', episode: 1 })).rejects.toThrow('absolute')
    await expect(f.service.episodeReadiness({ projectDir: join(f.project, 'project_config.json'), episode: 1 })).rejects.toThrow('directory')
    await expect(f.service.admitEpisode({ ...f.planInput, digest: brandString<VideoArtifactSha256>('f'.repeat(64)) })).rejects.toThrow('readiness')
    const input = await selection(f)
    await expect(f.service.admitEpisode({ ...input, digest: brandString<VideoArtifactSha256>('f'.repeat(64)) })).rejects.toThrow('readiness')
    expect(f.renderer.calls).toBe(0)
  })
  it('rejects a symlinked private job directory without writing an external intent', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), external = join(f.root, 'external-private')
    await mkdir(external)
    await (await import('node:fs/promises')).symlink(external, join(f.project, '.muse'))
    await expect(f.service.admitEpisode(input)).rejects.toThrow('canonical')
    expect(await readdir(external)).toEqual([])
  })
  it('refuses an undersized journal budget before any logical intent commits', async () => {
    const f = await createEpisodeDeliveryFixture(), scope = f.ctx.isolate('jubianEpisodeDelivery')
    await scope.plugin(JubianEpisodeDelivery, { ...f.episodeOptions, recordBytes: 1 }).await()
    const service = scope.jubianEpisodeDelivery, ready = await service.episodeReadiness(f.planInput)
    if (ready.digest === null) throw new Error('Expected readiness')
    const target = { ...f.planInput, digest: ready.digest }
    await expect(service.admitEpisode(target)).rejects.toThrow('budget')
    expect((await service.episodeStatus(target)).state).toBe('not-admitted')
  })
  it('refuses invalid service options and new work after actual provider disposal', async () => {
    const f = await createEpisodeDeliveryFixture(), scope = f.ctx.isolate('jubianEpisodeDelivery')
    await expect(scope.plugin(JubianEpisodeDelivery, { ...f.episodeOptions, recordBytes: 0 }).await()).rejects.toThrow('positive')
    await f.episodeFiber.dispose(); f.service.resumeAdmission()
    await expect(f.service.episodeStatus({ ...f.planInput, digest: brandString<VideoArtifactSha256>('f'.repeat(64)) })).rejects.toThrow('closing')
  })
  it('reuses an already present exact full episode without replacing its inode', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), exports = join(f.project, 'exports')
    await mkdir(exports)
    const path = join(exports, `Muse-episode-01-${input.digest}.mp4`)
    await writeFile(path, 'full episode fixture bytes')
    const before = await stat(path)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    expect((await stat(path)).ino).toBe(before.ino)
  })
  it('repairs a missing status from its original completed receipt without touching the lost source', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    const done = await f.service.episodeStatus(input)
    await unlink(join(f.project, '.muse', 'episode-delivery', done.attempt ?? '', 'state.json'))
    for (const name of await readdir(f.directory)) if (name.startsWith('original-')) await unlink(join(f.directory, name))
    expect((await f.service.episodeStatus(input)).canResume).toBe(true)
    await f.service.admitEpisode({ ...input, resume: true })
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    expect(f.renderer.calls).toBe(1)
  })

  it('does not publish an older editing plan changed while its admitted renderer was running', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); await f.renderer.entered
    await writeFile(join(f.project, 'editing', 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nNew edit\n')
    f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('unknown') })
    expect(await readdir(join(f.project, 'exports'))).toEqual([])
    expect(f.renderer.encodes).toBe(1)
  })

  it('refuses new render and publication while its cancellation journal is held before signal abort', async () => {
    const f = await createEpisodeDeliveryFixture(), cancellation = new AbortController()
    const entered = Promise.withResolvers<undefined>(), inspect = Promise.withResolvers<undefined>()
    const checked = Promise.withResolvers<undefined>()
    const journal = Promise.withResolvers<undefined>(), releaseJournal = Promise.withResolvers<undefined>()
    const operation = f.recovery.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, cancellation.signal,
      async (lease) => {
        entered.resolve(undefined); await inspect.promise
        expect(lease.signal.aborted).toBe(false)
        const render = vi.fn(), publish = vi.fn(async () => {})
        expect(() => { lease.assertActive(); render() }).toThrow('stopping')
        await expect(lease.commit(publish)).rejects.toThrow('stopping')
        await expect(lease.recheck()).rejects.toThrow('stopping')
        expect(render).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
        expect(lease.signal.aborted).toBe(false); checked.resolve(undefined)
      }, async () => { journal.resolve(undefined); await releaseJournal.promise })
    const rejected = expect(operation).rejects.toThrow(/stopping|caller-cancelled/u)
    try {
      await entered.promise; cancellation.abort(new Error('stop current owner'))
      await journal.promise; inspect.resolve(undefined); await checked.promise; releaseJournal.resolve(undefined)
      await rejected
    } finally { inspect.resolve(undefined); releaseJournal.resolve(undefined); await Promise.allSettled([operation, rejected]) }
  })
  it('fences a commit cancelled during its outside-queue verification before final publication', async () => {
    const f = await createEpisodeDeliveryFixture(), cancellation = new AbortController(), open = Files.open
    const hashing = Promise.withResolvers<undefined>(), releaseHash = Promise.withResolvers<undefined>()
    const checked = Promise.withResolvers<undefined>()
    let signalAbortedDuringRefusal = true
    const journal = Promise.withResolvers<undefined>(), releaseJournal = Promise.withResolvers<undefined>()
    let hold = false
    const spy = vi.spyOn(Files, 'open').mockImplementation(async (...args) => {
      if (hold && String(args[0]).includes('original-')) { hold = false; hashing.resolve(undefined); await releaseHash.promise }
      return open(...args)
    })
    const publish = vi.fn(async () => {})
    const operation = f.recovery.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, cancellation.signal,
      async (lease) => {
        hold = true
        try { await lease.commit(publish) }
        finally { signalAbortedDuringRefusal = lease.signal.aborted; checked.resolve(undefined) }
      },
      async () => { journal.resolve(undefined); await releaseJournal.promise })
    const rejected = expect(operation).rejects.toThrow(/stopping|caller-cancelled/u)
    try {
      await hashing.promise; cancellation.abort(new Error('stop during verification')); await journal.promise
      releaseHash.resolve(undefined); await checked.promise
      expect(signalAbortedDuringRefusal).toBe(false)
      releaseJournal.resolve(undefined); await rejected
      expect(publish).not.toHaveBeenCalled()
    } finally {
      releaseHash.resolve(undefined); releaseJournal.resolve(undefined)
      await Promise.allSettled([operation, rejected]); spy.mockRestore()
    }
  })

  it('retains a media failure and a later explicit retry refusal as original-task observations', async () => {
    const f = await createEpisodeDeliveryFixture()
    f.renderer.mode = 'failed'
    const input = await selection(f), admitted = await f.service.admitEpisode(input)
    f.renderer.release()
    await vi.waitFor(async () => {
      expect((await f.service.episodeStatus(input)).state).toBe('failed')
      expect(f.service.hasActiveWork()).toBe(false)
    })
    f.renderer.mode = 'retry-required'
    await f.service.admitEpisode({ ...input, resume: true })
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('unknown') })
    const refused = await f.service.episodeStatus(input)
    expect(refused.attempt).toBe(admitted.attempt)
    expect(refused.problem).toContain('explicit reconciliation')
    expect(f.renderer.encodes).toBe(1)
  })
  it.each(['foreign-proof', 'changed-drain', 'outside-candidate', 'changed-candidate', 'changed-candidate-facts'] as const)(
    'refuses %s after the controlled renderer has produced actual durable proof and candidate bytes', async (fault) => {
      const f = await createEpisodeDeliveryFixture()
      const spy = observeRenderer(f, async (result, input) => {
        if (result.kind === 'unknown' || result.kind === 'retry-required' || result.proof.result !== 'completed' || result.candidate === undefined) {
          throw new Error('Expected completed local fixture data')
        }
        const drain = join(input.job.attemptRoot, 'drained-' + result.proof.identity.execution + '.json')
        if (fault === 'changed-drain') {
          await writeFile(drain, JSON.stringify({ ...result.proof, commands: result.proof.commands + 1 }))
          return result
        }
        if (fault === 'foreign-proof') {
          const record = JSON.parse(await readFile(drain, 'utf8')) as Record<string, object | string | number>
          const identity = library.executionIdentitySchema.parse(result.proof.identity)
          await writeFile(drain, JSON.stringify({ ...record, identity: { ...identity, attempt: '11111111-1111-4111-a111-111111111111' } }))
          const proof = library.executionDrainSchema.parse(JSON.parse(await readFile(drain, 'utf8')))
          if (proof.result !== 'completed') throw new Error('Expected completed proof')
          return { kind: 'drained', proof, candidate: result.candidate }
        }
        if (fault === 'outside-candidate') {
          const outside = join(f.root, 'outside.mp4'); await cp(result.candidate.path, outside)
          return { kind: 'drained', proof: result.proof, candidate: { ...result.candidate, path: outside } }
        }
        if (fault === 'changed-candidate') {
          await writeFile(result.candidate.path, 'changed bytes after provider verification')
          return result
        }
        const facts = join(input.stageRoot, 'candidate-facts.json')
        await writeFile(facts, JSON.stringify({ sha256: 'f'.repeat(64) }))
        const decoded = z.strictObject({ sha256: library.episodeHashSchema }).parse(JSON.parse(await readFile(facts, 'utf8')))
        return { kind: 'drained', proof: result.proof, candidate: { ...result.candidate, sha256: decoded.sha256 } }
      })
      try {
        const input = await selection(f); await f.service.admitEpisode(input); f.renderer.release()
        await vi.waitFor(async () => {
          const status = await f.service.episodeStatus(input).catch(() => undefined)
          expect(status === undefined || status.state === 'unknown').toBe(true)
        })
        expect(f.renderer.encodes).toBe(1); expect(f.fetch).not.toHaveBeenCalled()
        const exports = await readdir(join(f.project, 'exports')).catch(() => [])
        expect(exports).toEqual([])
      } finally { spy.mockRestore() }
    },
  )

  it('keeps one original claim when two real service instances pass inventory before its file lock releases', async () => {
    const f = await createEpisodeDeliveryFixture(), firstInput = await selection(f), scope = f.ctx.isolate('jubianEpisodeDelivery')
    await scope.plugin(JubianEpisodeDelivery, f.episodeOptions).await()
    const other = scope.jubianEpisodeDelivery, ready = await other.episodeReadiness(f.planInput)
    expect(ready.digest).toBe(firstInput.digest)
    const originalLock = atomic.withFileLock, held = Promise.withResolvers<undefined>()
    const locked = Promise.withResolvers<undefined>(), secondWaiting = Promise.withResolvers<undefined>()
    let count = 0, owner: Promise<void> | undefined
    const spy = vi.spyOn(atomic, 'withFileLock').mockImplementation(async (path, run, options) => {
      if (path.endsWith(sep + 'intent.json')) {
        count++
        if (count === 1) {
          owner = originalLock(path, async () => { locked.resolve(undefined); await held.promise }, options)
          await locked.promise
        } else secondWaiting.resolve(undefined)
      }
      return originalLock(path, run, options)
    })
    const first = f.service.admitEpisode(firstInput), second = other.admitEpisode(firstInput)
    try {
      await secondWaiting.promise; held.resolve(undefined)
      const admissions = await Promise.all([first, second])
      expect(admissions[0]?.attempt).toBe(admissions[1]?.attempt)
      await f.renderer.entered; expect(f.renderer.calls).toBe(1)
      f.renderer.release()
      await vi.waitFor(async () => { expect((await other.episodeStatus(firstInput)).state).toBe('completed') })
    } finally { held.resolve(undefined); f.renderer.release(); await Promise.allSettled([first, second]); await owner; spy.mockRestore() }
  })
  it('refuses a changed original ledger intent after its tiny claim and before source consumption', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), write = atomic.writeFileAtomic
    let changed = false
    const spy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (...args) => {
      await write(...args)
      if (!changed && args[0].endsWith(sep + 'state.json') && String(args[1]).includes('"queued"')) {
        changed = true
        for (const name of await readdir(f.ledger.root)) {
          if (!name.endsWith('.ndjson')) continue
          const path = join(f.ledger.root, name), lines = (await readFile(path, 'utf8')).trim().split('\n')
          const records = lines.map(line => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
          for (const record of records) if (record.phase === 'begin' && record.idempotency_key === f.key) record.request_sha256 = 'changed-original-intent'
          await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
        }
      }
    })
    try {
      await f.service.admitEpisode(input)
      await vi.waitFor(async () => {
        const status = await f.service.episodeStatus(input)
        expect(status.state).toBe('failed'); expect(status.problem).toContain('original approved sources changed')
      })
      expect(f.renderer.calls).toBe(0); expect(changed).toBe(true)
    } finally { spy.mockRestore() }
  })
  it.each([false, true])('retains a renderer reply failure after drain (oversized=%s)', async (oversized) => {
    const f = await createEpisodeDeliveryFixture()
    const missingReply = vi.fn<(result: EpisodeRenderResult, input: ApprovedEpisodeRenderInput) => Promise<EpisodeRenderResult>>()
      .mockRejectedValue(oversized ? new Error('x'.repeat(f.episodeOptions.recordBytes + 1)) : 'Renderer reply stream ended')
    const spy = observeRenderer(f, missingReply)
    try {
      const input = await selection(f); await f.service.admitEpisode(input); f.renderer.release()
      await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('unknown') })
      const status = await f.service.episodeStatus(input)
      expect(status.problem).toContain(oversized ? 'state exceeds' : 'Renderer reply stream ended')
      expect(f.renderer.encodes).toBe(1)
    } finally { spy.mockRestore() }
  })

  it('does not convert an owned running snapshot to unknown when completion wins during its state read', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), read = library.readEpisodeStateSnapshot
    await f.service.admitEpisode(input); await f.renderer.entered
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let held = false
    const spy = vi.spyOn(library, 'readEpisodeStateSnapshot').mockImplementation(async (...args) => {
      const value = await read(...args)
      if (!held && args[0].endsWith(sep + 'state.json') && z.object({ state: z.string() }).safeParse(value).data?.state === 'running') {
        held = true; entered.resolve(undefined); await release.promise
      }
      return value
    })
    const delayed = f.service.episodeStatus(input)
    try {
      await entered.promise; f.renderer.release()
      await vi.waitFor(() => { expect(f.service.hasActiveWork()).toBe(false) })
      release.resolve(undefined)
      const status = await delayed
      expect(['running', 'completed']).toContain(status.state)
      expect(status.canResume).toBe(false)
      expect(f.service.hasActiveWork()).toBe(false)
      expect((await f.service.episodeStatus(input)).state).toBe('completed')
    } finally { release.resolve(undefined); f.renderer.release(); await delayed.catch(() => {}); spy.mockRestore() }
  })

  it('keeps a queued snapshot coherent when a new local recovery is admitted and completes during its read', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f)
    await f.service.admitEpisode(input); f.renderer.release()
    await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).state).toBe('completed') })
    const first = await f.service.episodeStatus(input)
    await unlink(join(f.project, '.muse', 'episode-delivery', first.attempt ?? '', 'receipt.json'))
    const queued = Promise.withResolvers<undefined>(), releaseClaim = Promise.withResolvers<undefined>()
    const stateRead = Promise.withResolvers<undefined>(), releaseRead = Promise.withResolvers<undefined>()
    const write = atomic.writeFileAtomic, read = library.readEpisodeStateSnapshot
    let held = false
    const writeSpy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (...args) => {
      await write(...args)
      if (args[0].endsWith(sep + 'state.json') && String(args[1]).includes('"queued"')) {
        queued.resolve(undefined); await releaseClaim.promise
      }
    })
    const readSpy = vi.spyOn(library, 'readEpisodeStateSnapshot').mockImplementation(async (...args) => {
      const value = await read(...args)
      if (!held && args[0].endsWith(sep + 'state.json') && z.object({ state: z.string() }).safeParse(value).data?.state === 'queued') {
        held = true; stateRead.resolve(undefined); await releaseRead.promise
      }
      return value
    })
    const admission = f.service.admitEpisode({ ...input, resume: true })
    let delayed: ReturnType<typeof f.service.episodeStatus> | undefined
    try {
      await queued.promise; delayed = f.service.episodeStatus(input); await stateRead.promise
      releaseClaim.resolve(undefined); await admission
      await vi.waitFor(() => { expect(f.service.hasActiveWork()).toBe(false) })
      releaseRead.resolve(undefined)
      const observed = await delayed
      expect(['queued', 'completed']).toContain(observed.state)
      expect(observed.canResume).toBe(false)
      expect((await f.service.episodeStatus(input)).state).toBe('completed')
    } finally {
      releaseClaim.resolve(undefined); releaseRead.resolve(undefined)
      await Promise.allSettled([admission, ...(delayed === undefined ? [] : [delayed])])
      writeSpy.mockRestore(); readSpy.mockRestore()
    }
  })

  it('preserves a targeted attempt-directory inspection failure instead of reporting an absent admission', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), lstat = Files.lstat
    const denial = Object.assign(new Error('Attempt directory inspection denied'), { code: 'EACCES' })
    const spy = vi.spyOn(Files, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${sep}.muse${sep}episode-delivery${sep}`)) throw denial
      return lstat(...args)
    })
    try { await expect(f.service.episodeStatus(input)).rejects.toBe(denial) }
    finally { spy.mockRestore() }
  })
  it('refuses source bytes changed between lease verification and renderer staging', async () => {
    const f = await createEpisodeDeliveryFixture(), input = await selection(f), hashFile = library.hashEpisodeFile
    let reads = 0
    const spy = vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
      if (path.includes(sep + 'original-') && ++reads === 2) await writeFile(path, 'changed source before staging')
      return hashFile(path, signal)
    })
    try {
      await f.service.admitEpisode(input)
      await vi.waitFor(async () => { expect((await f.service.episodeStatus(input)).problem).toContain('source changed before staging') })
      expect(f.renderer.calls).toBe(0); expect(f.fetch).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('keeps an ignored failed source recheck from becoming a healthy consumer result', async () => {
    const f = await createEpisodeDeliveryFixture()
    const operation = f.recovery.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, new AbortController().signal,
      async (lease) => {
        const source = lease.sources[0]
        if (source === undefined) throw new Error('Expected one captured source')
        await writeFile(source.source.path, 'temporary replacement')
        await expect(lease.recheck()).rejects.toThrow('changed')
        await writeFile(source.source.path, f.sourceBytes)
        await lease.recheck()
      })
    await expect(operation).rejects.toThrow('changed')
  })
  it('journals cancellation for an already retired admission without starting its consumer', async () => {
    const f = await createEpisodeDeliveryFixture(), signal = new AbortController().signal
    const request = { items: [f.input], metadataMaxBytes: 1000000 }
    const token = await f.recovery.withApprovedSources(request, signal, async lease => lease.admission)
    await f.recovery.configure({ enabled: false, projectDir: f.project })
    const consume = vi.fn(async () => {}), journal = vi.fn(async (reason: string) => { await writeFile(join(f.root, 'retired.json'), reason) })
    await expect(f.recovery.withApprovedSources(request, signal, consume, journal, token)).rejects.toThrow()
    expect(consume).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, 'retired.json'), 'utf8')).toBe('configuration-changed')
  })
  it('retains committed configuration and refuses activation after its old source cancellation journal fails', async () => {
    const f = await createEpisodeDeliveryFixture(), other = join(f.root, 'new-project'), entered = Promise.withResolvers<undefined>()
    await cp(f.project, other, { recursive: true })
    const operation = f.recovery.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, new AbortController().signal,
      async (lease) => {
        entered.resolve(undefined)
        await new Promise<void>((resolve) => { lease.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        lease.signal.throwIfAborted()
      }, async () => { await writeFile(join(f.root, 'absent-directory', 'cancellation.json'), '{}') })
    const rejected = expect(operation).rejects.toThrow('cancellation intent')
    await entered.promise
    await expect(f.recovery.configure({ enabled: false, projectDir: other })).rejects.toThrow('cancellation intent')
    await rejected
    expect(JSON.parse(await readFile(f.settingsPath, 'utf8'))).toMatchObject({ enabled: false, projectDir: other })
  })
  it('propagates an old owned worker drain failure after persisting the replacement switch', async () => {
    const f = await createEpisodeDeliveryFixture(), error = new VideoMediaDrainError('worker range remains unknown')
    const spy = vi.spyOn(Recovery, 'runVideoRecovery').mockImplementationOnce(async (_client, _ledger, _project, _keys, _interval, signal) => {
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(error) }, { once: true }) })
    })
    try {
      await f.recovery.configure({ enabled: true, projectDir: f.project })
      await expect(f.recovery.configure({ enabled: false })).rejects.toBe(error)
      expect(JSON.parse(await readFile(f.settingsPath, 'utf8'))).toMatchObject({ enabled: false, projectDir: f.project })
    } finally { spy.mockRestore() }
  })

})
