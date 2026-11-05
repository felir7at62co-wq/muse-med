/** Explicit read-only cloud-file acceptance using the user's existing Muse login. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { MuseMediaClient } from '../src/media.ts'
import { MuseMediaImporter } from '../src/media-import.ts'
import type { MuseMediaJobId } from '../src/media-types.ts'

it.skipIf(process.env.MUSE_MEDIA_LIVE !== '1')('imports one existing owned cloud cover without submitting a download', async () => {
  const directory = join(process.cwd(), '.artifacts/muse-company-media-20261105/live-import-workspace')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const cwd = await realpath(directory)
  const ctx = new Context()
  const client = new MuseMediaClient({ baseUrl: 'https://muse.aigc-pipeline.cn',
    sessionFile: join(homedir(), '.muse/muse-account/session.json'), requestTimeoutMs: 60_000, fileTimeoutMs: 120_000,
    maxReplyBytes: 1_048_576, maxFileBytes: 1_048_576 })
  let importer: MuseMediaImporter | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FsLocal, { cwd })
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
    await ctx.plugin(SandboxLocal)
    importer = new MuseMediaImporter(ctx, client, { directory: 'source/media/company', nodePath: process.execPath,
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', timeoutMs: 120_000, graceMs: 1_000, maxBytes: 1_048_576,
      maxOutputBytes: 65_536, maxPixels: 67_108_864, maxDurationSeconds: 60 })
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('media-live-existing-cover'), {}, { cwd })
    const receipt = await importer.import(agent, brandString<MuseMediaJobId>('28107e17-b90b-4da4-9122-8c68a9d20ffc'),
      'cover.jpg', new AbortController().signal)
    expect(receipt).toMatchObject({ state: 'local_ready', sourceJobState: 'partial', kind: 'image', bytes: 10755,
      sha256: '5f8f86a02cee5bd330b428874c2a7850555fc4396a068cbd96030ad3d68d2e72', fullDecodeVerified: true })
    expect(createHash('sha256').update(await readFile(receipt.path)).digest('hex')).toBe(receipt.sha256)
    await writeFile(join(directory, 'live-import-proof.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } finally {
    await importer?.dispose()
    await client.dispose()
    await ctx.fiber.dispose()
  }
})
