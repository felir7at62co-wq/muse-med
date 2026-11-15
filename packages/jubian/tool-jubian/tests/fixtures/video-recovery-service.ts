/** Real local A recovery service and original recorded source for shared Host tests. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { onTestFinished, vi } from 'vitest'
import { JubianVideoRecovery } from '../../src/video-recovery-service.ts'
import type { VideoRecoveryDigest } from '../../src/types.ts'

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

/**
 * Mount real recovery/ledger/subprocess owners in one private temporary project.
 * @param input - Optional actual source media; omission uses local deterministic bytes.
 * @returns Original project/ledger facts and private resources, without mounting a recovery provider.
 */
export async function createVideoRecoveryProjectFixture(input: { readonly sourceBytes?: Buffer } = {}) {
  const sourceBytes = input.sourceBytes ?? Buffer.from('approved bytes')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-recovery-service-')))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SubprocessLocal)
  const project = join(root, 'project'), directory = join(project, 'video_tasks', 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
  const preview = join(project, 'video_tasks', 'preview.json')
  await writeFile(preview, '{}')
  const ledger = new JubianLedger({ root: join(root, 'ledger') }), key = 'original-video'
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'original', scriptId: 1,
    beforeTaskIds: [], videoPreviewPath: preview })
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash(sourceBytes), video: true, audio: true }] })
  await writeFile(join(directory, hash(key) + '.json'), evidence)
  await writeFile(join(directory, 'original-' + hash(sourceBytes) + '.mp4'), sourceBytes)
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No new provider operation is allowed') })
  const settingsPath = join(root, 'recovery.json')
  const options = { ledger, settingsPath, clientForProject: () => new JubianClient({ credential: async () => 'fixture', fetch }),
    ffmpegPath: process.execPath, intervalMs: 100, decodeTimeoutMs: 1000, decodeGraceMs: 50, decodeMaxOutputBytes: 4096 }
  const selection = { idempotencyKey: key, digest: brandString<VideoRecoveryDigest>(hash(evidence)) }
  return { root, project, directory, preview, ledger, key, settingsPath, options, ctx, input: selection, fetch, sourceBytes }
}

/**
 * Mount the real recovery service on the shared original project fixture.
 * @param input - Optional actual source media for provider integration owners.
 * @returns Recorded project, actual recovery owner and private cleanup resources.
 */
export async function createVideoRecoveryFixture(input: { readonly sourceBytes?: Buffer } = {}) {
  const project = await createVideoRecoveryProjectFixture(input)
  const fiber = project.ctx.plugin(JubianVideoRecovery, project.options)
  await fiber.await()
  return { ...project, fiber, service: project.ctx.jubianVideoRecovery }
}
