/** Approved source consumers retain cancellation, final publication and project ownership. */
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ApprovedVideoSourceAdmission, ApprovedVideoSourceLease, VideoRecoveryDigest } from '../src/types.ts'
import * as Recovery from '../src/video-recovery.ts'
import * as Episode from '../src/episode-delivery.ts'
import { createVideoRecoveryFixture } from './fixtures/video-recovery-service.ts'

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { vi.restoreAllMocks() })

async function approvedFixture() {
  const f = await createVideoRecoveryFixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'approve' })
  return { ...f, request: { items: [f.input], metadataMaxBytes: 65536 },
    source: join(f.directory, 'original-' + hash('approved bytes') + '.mp4') }
}

async function capturedAdmission(f: Awaited<ReturnType<typeof approvedFixture>>): Promise<ApprovedVideoSourceAdmission> {
  return f.service.withApprovedSources(f.request, new AbortController().signal, async lease => lease.admission)
}

it('admits a readiness token after its lease ends using metadata and file versions without hashing media again', async () => {
  const f = await approvedFixture(), admission = await capturedAdmission(f)
  const sourceHash = vi.spyOn(Recovery, 'verifyApprovedVideoSource'), episodeHash = vi.spyOn(Episode, 'hashEpisodeFile')
  const prepared = join(f.root, 'admission-prepared'), published = join(f.root, 'admission-published')
  await writeFile(prepared, 'tiny original claim')
  expect(await f.service.admitApprovedSources(admission, new AbortController().signal, async (signal) => {
    expect(signal.aborted).toBe(false)
    await expect(f.service.admitApprovedSources(admission, signal, async () => 'nested')).rejects.toThrow(/cannot be nested/u)
    await link(prepared, published)
    return 'admitted'
  })).toBe('admitted')
  expect(await readFile(published, 'utf8')).toBe('tiny original claim')
  expect(sourceHash).not.toHaveBeenCalled()
  expect(episodeHash).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rejects a copied token and a token belonging to a different recovery owner', async () => {
  const first = await approvedFixture(), second = await approvedFixture(), admission = await capturedAdmission(first)
  let publications = 0
  const publish = async () => { publications++; return 'unexpected' }
  const copied = { sources: admission.sources, signal: admission.signal }
  await expect(first.service.admitApprovedSources(copied, new AbortController().signal, publish))
    .rejects.toThrow(/not captured by this recovery owner/u)
  await expect(second.service.admitApprovedSources(admission, new AbortController().signal, publish))
    .rejects.toThrow(/not captured by this recovery owner/u)
  expect(publications).toBe(0)
  expect(first.fetch).not.toHaveBeenCalled()
  expect(second.fetch).not.toHaveBeenCalled()
})

it.each(['media', 'project-config', 'approval'] as const)('rejects an admission token after its %s facts change', async (kind) => {
  const f = await approvedFixture(), admission = await capturedAdmission(f)
  if (kind === 'media') await writeFile(f.source, 'changed since readiness')
  else if (kind === 'project-config') {
    await writeFile(join(f.project, 'project_config.json'), '{"jubian_script_id":1,"local_revision":3}')
  } else {
    await writeFile(join(f.directory, hash(f.key) + '.json.decision.json'), JSON.stringify({ action: 'approve', digest: '0'.repeat(64) }))
  }
  let publications = 0
  await expect(f.service.admitApprovedSources(admission, new AbortController().signal,
    async () => { publications++; return 'unexpected' })).rejects.toThrow(/changed|another report/u)
  expect(publications).toBe(0)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retires readiness tokens when the selected generation is replaced even by the same project', async () => {
  const f = await approvedFixture(), admission = await capturedAdmission(f)
  await f.service.configure({ enabled: false, projectDir: f.project })
  expect(admission.signal.aborted).toBe(true)
  let publications = 0
  await expect(f.service.admitApprovedSources(admission, new AbortController().signal,
    async () => { publications++; return 'unexpected' })).rejects.toThrow(/source generation changed/u)
  expect(publications).toBe(0)
  const fresh = await capturedAdmission(f)
  expect(await f.service.admitApprovedSources(fresh, new AbortController().signal, async () => 'fresh generation')).toBe('fresh generation')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retains a tiny admission committed before its caller disconnects', async () => {
  const f = await approvedFixture(), admission = await capturedAdmission(f), controller = new AbortController()
  const prepared = join(f.root, 'tiny-prepared'), published = join(f.root, 'tiny-published')
  await writeFile(prepared, 'committed tiny claim')
  expect(await f.service.admitApprovedSources(admission, controller.signal, async () => {
    await link(prepared, published)
    controller.abort(new Error('admission response lost'))
    return 'committed'
  })).toBe('committed')
  expect(await readFile(published, 'utf8')).toBe('committed tiny claim')
  expect(await stat(published)).toMatchObject({ ino: (await stat(prepared)).ino })
  expect(controller.signal.aborted).toBe(true)
})

it('publishes a verified source batch once and keeps unrelated recovery calls outside the final callback', async () => {
  const f = await approvedFixture(), control = new AbortController()
  const prepared = join(f.root, 'prepared'), published = join(f.root, 'published')
  await writeFile(prepared, 'prepared output')
  const result = await f.service.withApprovedSources(f.request, control.signal, async (lease) => {
    expect(lease.sources).toMatchObject([{ idempotencyKey: f.key, digest: f.input.digest,
      project: { directory: f.project, scriptId: 1 }, source: { path: f.source, sha256: hash('approved bytes') } }])
    expect((await f.service.review({ ...f.input, action: 'read' })).decision).toBe('approve')
    await lease.recheck()
    const value = await lease.commit(async (signal) => {
      expect(signal.aborted).toBe(false)
      await expect(lease.commit(async () => 'nested')).rejects.toThrow(/ended or committed/u)
      await expect(f.service.status()).rejects.toThrow(/cannot be nested/u)
      await expect(f.service.configure({ enabled: false })).rejects.toThrow(/cannot be nested/u)
      await link(prepared, published)
      return 'published'
    })
    return value
  })
  expect(result).toBe('published')
  expect(await readFile(published, 'utf8')).toBe('prepared output')
  expect(await stat(published)).toMatchObject({ ino: (await stat(prepared)).ino })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('releases the recovery queue while a source full-hash observation is pending', async () => {
  const f = await approvedFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const verify = Recovery.verifyApprovedVideoSource
  vi.spyOn(Recovery, 'verifyApprovedVideoSource').mockImplementationOnce(async (...args) => {
    const result = await verify(...args)
    entered.resolve(undefined); await release.promise
    return result
  })
  const operation = f.service.withApprovedSources(f.request, new AbortController().signal, async () => 'consumed')
  try {
    await entered.promise
    expect((await f.service.review({ ...f.input, action: 'read' })).decision).toBe('approve')
    release.resolve(undefined)
    expect(await operation).toBe('consumed')
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([operation])
  }
  expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses a source changed after its final full hash and before serialized publication', async () => {
  const f = await approvedFixture(), verify = Recovery.verifyApprovedVideoSource
  let checks = 0, publications = 0
  vi.spyOn(Recovery, 'verifyApprovedVideoSource').mockImplementation(async (...args) => {
    const result = await verify(...args)
    if (++checks === 2) await writeFile(f.source, 'changed after the measured full hash')
    return result
  })
  await expect(f.service.withApprovedSources(f.request, new AbortController().signal,
    async lease => lease.commit(async () => { publications++; return 'unexpected' })))
    .rejects.toThrow(/changed after hashing/u)
  expect(checks).toBe(2)
  expect(publications).toBe(0)
  expect(await readFile(f.source, 'utf8')).toBe('changed after the measured full hash')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses changed project configuration before committing prepared output', async () => {
  const f = await approvedFixture()
  let publications = 0
  await expect(f.service.withApprovedSources(f.request, new AbortController().signal, async (lease) => {
    await writeFile(join(f.project, 'project_config.json'), '{"jubian_script_id":1,"local_revision":2}')
    return lease.commit(async () => { publications++; return 'unexpected' })
  })).rejects.toThrow(/source facts changed/u)
  expect(publications).toBe(0)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retains an exclusive publication committed before the caller disconnects', async () => {
  const f = await approvedFixture(), controller = new AbortController()
  const prepared = join(f.root, 'committed-prepared'), published = join(f.root, 'committed-published')
  await writeFile(prepared, 'committed bytes')
  expect(await f.service.withApprovedSources(f.request, controller.signal, async lease => lease.commit(async () => {
    await link(prepared, published)
    controller.abort(new Error('reply disconnected'))
    return 'committed'
  }))).toBe('committed')
  expect(controller.signal.aborted).toBe(true)
  expect(await readFile(published, 'utf8')).toBe('committed bytes')
  expect(await stat(published)).toMatchObject({ ino: (await stat(prepared)).ino })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('aborts and joins the consumer even when durable cancellation intent fails', async () => {
  const f = await approvedFixture(), controller = new AbortController(), entered = Promise.withResolvers<undefined>()
  let cleaned = false
  const operation = f.service.withApprovedSources(f.request, controller.signal, async (lease) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { lease.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    cleaned = true
    lease.signal.throwIfAborted()
  }, async () => { await writeFile(join(f.root, 'absent-parent', 'intent.json'), 'cancelled', { flag: 'wx' }) })
  const rejected = expect(operation).rejects.toThrow(/cancellation intent could not be persisted/u)
  try {
    await entered.promise
    controller.abort()
    await rejected
    expect(cleaned).toBe(true)
    const errors = vi.spyOn(f.fiber.ctx.logger, 'error')
    await f.fiber.dispose()
    expect(errors.mock.calls.some(([error]) => error instanceof Error
      && error.message.includes('cancellation intent could not be persisted'))).toBe(true)
  } finally {
    controller.abort()
    await Promise.allSettled([operation, rejected])
  }
  expect(f.fetch).not.toHaveBeenCalled()
})

it('persists cancellation intent before notifying the consumer and waits for its cleanup', async () => {
  const f = await approvedFixture(), controller = new AbortController()
  const entered = Promise.withResolvers<ApprovedVideoSourceLease>(), journaling = Promise.withResolvers<undefined>()
  const releaseJournal = Promise.withResolvers<undefined>(), aborted = Promise.withResolvers<undefined>()
  const releaseCleanup = Promise.withResolvers<undefined>()
  const journal = join(f.root, 'cancellation-intent.json')
  let settled = false
  const operation = f.service.withApprovedSources(f.request, controller.signal, async (lease) => {
    entered.resolve(lease)
    await new Promise<void>((resolve) => {
      lease.signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
    })
    await releaseCleanup.promise
    lease.signal.throwIfAborted()
  }, async (reason) => {
    journaling.resolve(undefined); await releaseJournal.promise
    await writeFile(journal, JSON.stringify({ reason }), { flag: 'wx' })
  })
  const rejected = expect(operation).rejects.toThrow(/caller-cancelled/u)
  void operation.then(() => { settled = true }, () => { settled = true })
  try {
    const lease = await entered.promise
    controller.abort()
    await journaling.promise
    expect(lease.signal.aborted).toBe(false)
    expect(settled).toBe(false)
    releaseJournal.resolve(undefined); await aborted.promise
    expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({ reason: 'caller-cancelled' })
    expect(settled).toBe(false)
    releaseCleanup.resolve(undefined); await rejected
  } finally {
    controller.abort(); releaseJournal.resolve(undefined); releaseCleanup.resolve(undefined)
    await Promise.allSettled([operation, rejected])
  }
})

it('keeps a committed configuration while draining the old selected-project consumer outside the queue', async () => {
  const f = await approvedFixture(), other = join(f.root, 'other-project')
  await mkdir(other)
  await writeFile(join(other, 'project_config.json'), '{"jubian_script_id":2}')
  const entered = Promise.withResolvers<undefined>(), journaling = Promise.withResolvers<undefined>()
  const releaseJournal = Promise.withResolvers<undefined>(), aborted = Promise.withResolvers<undefined>()
  const releaseCleanup = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  let changed = false, change: ReturnType<typeof f.service.configure> | undefined
  const operation = f.service.withApprovedSources(f.request, controller.signal, async (lease) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => {
      lease.signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
    })
    await releaseCleanup.promise
    lease.signal.throwIfAborted()
  }, async (reason) => {
    expect(reason).toBe('configuration-changed')
    journaling.resolve(undefined); await releaseJournal.promise
  })
  const rejected = expect(operation).rejects.toThrow(/configuration-changed/u)
  try {
    await entered.promise
    change = f.service.configure({ enabled: false, projectDir: other })
    void change.then(() => { changed = true }, () => { changed = true })
    await journaling.promise
    expect(JSON.parse(await readFile(f.settingsPath, 'utf8'))).toEqual({ enabled: false, projectDir: other })
    expect(changed).toBe(false)
    await expect(f.service.withApprovedSources(f.request, new AbortController().signal, async () => 'unexpected'))
      .rejects.toThrow(/generation is closing/u)
    releaseJournal.resolve(undefined); await aborted.promise
    expect(changed).toBe(false)
    releaseCleanup.resolve(undefined); await rejected
    expect(await change).toMatchObject({ enabled: false, projectDir: other, reports: [] })
    await expect(f.service.withApprovedSources(f.request, new AbortController().signal, async () => 'unexpected'))
      .rejects.toThrow(/no longer belongs/u)
  } finally {
    controller.abort(); releaseJournal.resolve(undefined); releaseCleanup.resolve(undefined)
    await Promise.allSettled([operation, rejected, ...(change === undefined ? [] : [change])])
  }
  expect(f.fetch).not.toHaveBeenCalled()
})

it('holds enclosing Context disposal until cancellation journaling and consumer cleanup settle', async () => {
  const f = await approvedFixture(), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), journaling = Promise.withResolvers<undefined>()
  const releaseJournal = Promise.withResolvers<undefined>(), aborted = Promise.withResolvers<undefined>()
  const releaseCleanup = Promise.withResolvers<undefined>()
  const journal = join(f.root, 'dispose-intent.json'), cleanup = join(f.root, 'consumer-cleanup.txt')
  let disposed = false, disposal: Promise<void> | undefined
  const operation = f.service.withApprovedSources(f.request, controller.signal, async (lease) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => {
      lease.signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
    })
    await releaseCleanup.promise
    await writeFile(cleanup, 'consumer settled', { flag: 'wx' })
    lease.signal.throwIfAborted()
  }, async (reason) => {
    expect(reason).toBe('provider-disposed')
    journaling.resolve(undefined); await releaseJournal.promise
    await writeFile(journal, JSON.stringify({ reason }), { flag: 'wx' })
  })
  const rejected = expect(operation).rejects.toThrow(/provider-disposed/u)
  try {
    await entered.promise
    disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
    await journaling.promise
    expect(disposed).toBe(false)
    releaseJournal.resolve(undefined); await aborted.promise
    expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({ reason: 'provider-disposed' })
    expect(disposed).toBe(false)
    releaseCleanup.resolve(undefined); await Promise.all([rejected, disposal])
    expect(await readFile(cleanup, 'utf8')).toBe('consumer settled')
    expect(disposed).toBe(true)
  } finally {
    controller.abort(); releaseJournal.resolve(undefined); releaseCleanup.resolve(undefined)
    await Promise.allSettled([operation, rejected, ...(disposal === undefined ? [] : [disposal])])
  }
})

it('captures two original approvals as one batch and refuses publishing if either source changes', async () => {
  const f = await approvedFixture(), key = 'another-original-video'
  const preview = join(f.project, 'video_tasks', 'second-preview.json')
  await writeFile(preview, '{}')
  await f.ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'second-original',
    scriptId: 1, beforeTaskIds: [], videoPreviewPath: preview })
  const bytes = 'second approved bytes', sha256 = hash(bytes)
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 43, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + sha256, video: true, audio: true }] })
  const input = { idempotencyKey: key, digest: brandString<VideoRecoveryDigest>(hash(evidence)) }
  await writeFile(join(f.directory, hash(key) + '.json'), evidence)
  const source = join(f.directory, 'original-' + sha256 + '.mp4')
  await writeFile(source, bytes)
  await f.service.review({ ...input, action: 'approve' })
  let publications = 0
  await expect(f.service.withApprovedSources({ ...f.request, items: [f.input, input] }, new AbortController().signal, async (lease) => {
    expect(lease.sources.map(row => row.idempotencyKey)).toEqual([f.key, key])
    await writeFile(source, 'changed second input')
    return lease.commit(async () => { publications++; return 'unexpected' })
  })).rejects.toThrow(/current approved source changed/u)
  expect(publications).toBe(0)
  expect(await readFile(f.source, 'utf8')).toBe('approved bytes')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retires a lease after its consumer returns and refuses a stale approval digest before consuming', async () => {
  const f = await approvedFixture(), captured = Promise.withResolvers<ApprovedVideoSourceLease>()
  await f.service.withApprovedSources(f.request, new AbortController().signal, async (lease) => { captured.resolve(lease) })
  const lease = await captured.promise
  await expect(lease.recheck()).rejects.toThrow(/ended or committed/u)
  await expect(lease.commit(async () => 'unexpected')).rejects.toThrow(/ended or committed/u)
  let consumed = false
  await expect(f.service.withApprovedSources({ ...f.request, items: [{ ...f.input,
    digest: brandString<VideoRecoveryDigest>('0'.repeat(64)) }] }, new AbortController().signal,
  async () => { consumed = true })).rejects.toThrow(/approval changed/u)
  expect(consumed).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled()
})
