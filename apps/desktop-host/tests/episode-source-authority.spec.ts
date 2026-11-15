/** Source authority uses the native Session, Workspace and committed tool-result owners. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { saveReview } from '../../../packages/perception/tool-video-inspect/src/review-state.ts'
import { createEpisodeSourceAuthorityFixture as fixture } from './fixtures/episode-source-authority.ts'

vi.mock('../src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))

const selection = { provider: 'mock', model: 'original-model' }

it('issues original and clean source reviews in one real Session without rewriting caller media', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-multi-source-authority-'))), project = join(root, 'project')
  await mkdir(project)
  const original = join(project, 'original.mp4'), clean = join(project, 'clean.mp4')
  await writeFile(original, 'original caller-owned bytes')
  await writeFile(clean, 'clean caller-owned bytes')
  const h = await fixture({ root, project,
    inputs: [{ mediaPath: original, durationSeconds: 5 }, { mediaPath: clean, durationSeconds: 5 }] })
  onTestFinished(async () => { await h.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  expect(await readFile(original, 'utf8')).toBe('original caller-owned bytes')
  expect(await readFile(clean, 'utf8')).toBe('clean caller-owned bytes')
  expect(h.reviews).toHaveLength(2)
  const authority = await h.factory(h.agent.id, project, new AbortController().signal)
  for (const { binding } of h.reviews) {
    expect(binding.sessionId).toBe(h.agent.id)
    await authority.verify(binding, new AbortController().signal)
  }
  authority.release()
})

it('holds real native ownership and verifies committed source evidence from the exact Session', async () => {
  const h = await fixture(), resolve = vi.spyOn(h.ctx.sessionController, 'resolveAgent')
  const authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  expect(resolve).toHaveBeenCalledWith(h.agent.id)
  expect(authority.binding).toMatchObject({ sessionId: h.agent.id, workspaceId: h.workspace.id,
    workspacePath: h.root, workingDirectory: h.root, model: selection })
  await authority.verify(h.binding, new AbortController().signal)
  expect(() => { h.agent.model.select({ provider: 'mock', model: 'changed' }) }).toThrow('guarded model')
  await mkdir(join(h.root, 'other'))
  await expect(h.ctx.workingDirectory.set(h.agent, 'other')).rejects.toThrow('guarded directory')
  await expect(authority.withPublication(async (signal) => {
    expect(signal.aborted).toBe(false)
    authority.assertCurrent()
    return 'published'
  })).resolves.toBe('published')
  authority.release()
  authority.release()
  h.agent.model.select({ provider: 'mock', model: 'changed' })
  await h.ctx.workingDirectory.set(h.agent, 'other')
  expect(h.agent.model.current()?.model).toBe('changed')
})

it('adopts actual Session evidence in its workspace cache for a nested project', async () => {
  const h = await fixture()
  const cache = join(h.root, '.muse', 'video-ocr')
  await mkdir(cache, { recursive: true })
  const { binding } = await h.recordReview({ mediaPath: h.binding.mediaPath,
    ocrPath: join(cache, 'ocr.json'), inspectionPath: join(cache, 'review.json') })
  const authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  try {
    await expect(authority.verify(binding, new AbortController().signal)).resolves.toBeUndefined()
    await expect(authority.verify({ ...binding, sessionId: 'another-session' }, new AbortController().signal))
      .rejects.toThrow('SOURCE_QA_SESSION')
    expect(authority.binding.workspacePath).toBe(h.root)
    expect(authority.binding.workingDirectory).toBe(h.root)
  } finally { authority.release() }
})

it('refuses signed OCR and observation artifacts outside the original workspace', async () => {
  const h = await fixture()
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'muse-source-cache-outside-')))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  const { binding } = await h.recordReview({ mediaPath: h.binding.mediaPath,
    ocrPath: join(outside, 'ocr.json'), inspectionPath: join(outside, 'review.json') })
  const authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  try {
    await expect(authority.verify(binding, new AbortController().signal)).rejects.toThrow('SOURCE_QA_PROJECT')
  } finally { authority.release() }
})

it('uses an expected binding without recapturing a newer model selection', async () => {
  const h = await fixture(), first = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const expected = first.binding
  first.release()
  const capture = vi.spyOn(h.ctx.generationWorkspaceAuthority, 'capture')
  h.agent.model.select({ provider: 'mock', model: 'later-user-selection' })
  await expect(h.factory(h.agent.id, h.project, new AbortController().signal, expected)).rejects.toThrow('does not match')
  expect(capture).not.toHaveBeenCalled()
  expect(h.agent.model.current()?.model).toBe('later-user-selection')
})

it('rejects another Session and a project outside the original workspace', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  await expect(authority.verify({ ...h.binding, sessionId: 'another-session' }, new AbortController().signal))
    .rejects.toThrow('SOURCE_QA_SESSION')
  await expect(h.factory(SessionId('another-session'), h.project, new AbortController().signal, authority.binding))
    .rejects.toThrow('SOURCE_QA_SESSION')
  authority.release()
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'muse-source-outside-')))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  await expect(h.factory(h.agent.id, outside, new AbortController().signal)).rejects.toThrow('SOURCE_QA_PROJECT')
  h.agent.model.select({ provider: 'mock', model: 'after-refusal' })
})

it('does not lend a source in a sibling project to the selected project', async () => {
  const h = await fixture(), sibling = join(h.root, 'sibling')
  await mkdir(sibling)
  const authority = await h.factory(h.agent.id, sibling, new AbortController().signal)
  await expect(authority.verify(h.binding, new AbortController().signal)).rejects.toThrow('SOURCE_QA_PROJECT')
  authority.release()
})

it('revokes held authority when the real Workspace owner archives the Session', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  await h.ctx.workspaceRegistry.archiveSession(h.agent.id, { stopActivity: false })
  expect(authority.signal.aborted).toBe(true)
  expect(() => { authority.assertCurrent() }).toThrow()
  await expect(h.factory(h.agent.id, h.project, new AbortController().signal, authority.binding)).rejects.toThrow()
})

it('rejects a replacement Workspace at the same path instead of recapturing it', async () => {
  const h = await fixture(), first = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const expected = first.binding
  first.release()
  await h.ctx.workspaceRegistry.delete(h.workspace.id)
  const replacement = await h.ctx.workspaceRegistry.create(h.root)
  await replacement.attachSession(h.agent.id)
  expect(replacement.id).not.toBe(h.workspace.id)
  await expect(h.factory(h.agent.id, h.project, new AbortController().signal, expected)).rejects.toThrow('membership changed')
})

it('monotonically revokes a source review even if its previous contents are restored', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  saveReview(h.readReviews, h.agent.session, { ...h.review, scanned_until: 1 })
  saveReview(h.readReviews, h.agent.session, h.review)
  expect(authority.signal.aborted).toBe(true)
  expect(() => { authority.assertCurrent() }).toThrow('SOURCE_QA_CHANGED')
})

it('rejects a busy maintenance owner without waiting or publishing', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const gate = Promise.withResolvers<undefined>(), publish = vi.fn(async () => 'published')
  const maintenance = h.agent.runMaintenance(async () => gate.promise)
  try { await expect(authority.withPublication(publish)).rejects.toThrow('already has active work') }
  finally { gate.resolve(undefined); await maintenance; authority.release() }
  expect(publish).not.toHaveBeenCalled()
})

it('rejects a source-review commit during publication and cancels its callback signal', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<undefined>()
  const publication = authority.withPublication(async (signal) => { entered.resolve(signal); await gate.promise })
  const rejected = expect(publication).rejects.toThrow('SOURCE_QA_CHANGED')
  const signal = await entered.promise
  saveReview(h.readReviews, h.agent.session, { ...h.review, scanned_until: 1 })
  expect(signal.aborted).toBe(true)
  gate.resolve(undefined)
  await rejected
})

it('retains a queued user turn behind the actual publication maintenance phase', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  h.queueReply('Continued after publication.')
  await authority.withPublication(async () => {
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after saving.' }], source: { kind: 'user' } }))
    expect(h.adapter.requests).toHaveLength(3)
    authority.assertCurrent()
  })
  authority.release()
  await h.agent.whenIdle()
  expect(h.adapter.requests, JSON.stringify(h.events.slice(-8))).toHaveLength(4)
  expect(h.adapter.requests[3]).toMatchObject({ provider: 'mock', model: 'original-model', sessionId: h.agent.id })
})

it('cancels verification and drains an in-flight filesystem read before scope disposal returns', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  const read = h.ctx.fs.readBytes.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maximum) => {
    if (target.displayPath === h.binding.ocrPath) { entered.resolve(undefined); await gate.promise }
    return read(target, signal, maximum)
  })
  const verifying = authority.verify(h.binding, new AbortController().signal).catch((error: unknown) => error)
  await entered.promise
  let disposed = false
  const disposal = h.scope.dispose().then(() => { disposed = true })
  await Promise.resolve(undefined)
  expect(authority.signal.aborted).toBe(true)
  expect(disposed).toBe(false)
  gate.resolve(undefined)
  expect(await verifying).toBeInstanceOf(Error)
  await disposal
  expect(disposed).toBe(true)
  h.agent.model.select({ provider: 'mock', model: 'after-disposal' })
})

it('aborts a pending publication when its operation owner cancels', async () => {
  const h = await fixture(), owner = new AbortController()
  const authority = await h.factory(h.agent.id, h.project, owner.signal)
  owner.abort(new Error('renderer stopped'))
  expect(authority.signal.aborted).toBe(true)
  await expect(authority.withPublication(async () => 'must not publish')).rejects.toThrow('renderer stopped')
  h.agent.model.select({ provider: 'mock', model: 'after-cancel' })
})

it('forwards actual Agent cancellation while its publication owns maintenance', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  const entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<undefined>()
  const publication = authority.withPublication(async (signal) => {
    entered.resolve(signal)
    await gate.promise
    signal.throwIfAborted()
  })
  const rejected = expect(publication).rejects.toMatchObject({ kind: 'user' })
  const signal = await entered.promise
  h.agent.cancel({ kind: 'user' })
  expect(signal.aborted).toBe(true)
  gate.resolve(undefined)
  await rejected
  h.agent.model.select({ provider: 'mock', model: 'after-agent-cancel' })
})

it('revokes authority when the actual Agent scope is disposed', async () => {
  const h = await fixture(), authority = await h.factory(h.agent.id, h.project, new AbortController().signal)
  await h.agent.ctx.fiber.dispose()
  expect(authority.signal.aborted).toBe(true)
  expect(() => { authority.assertCurrent() }).toThrow()
})
