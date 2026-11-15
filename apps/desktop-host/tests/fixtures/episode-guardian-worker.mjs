/** Controlled source-profile consumer of the real B1 job and guardian core. */
import { createHash } from 'node:crypto'
import { watch, writeFileSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createEpisodeDeliveryJob } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { installEpisodeGuardian } from '../../src/episode-render-worker-core.ts'
import { createGuardianJournal } from '../../src/episode-guardian-journal.ts'

export const name = 'episode-guardian-worker-fixture'
export const inject = ['subprocess', 'appReady', 'appExit']
const descriptorSchema = z.strictObject({ projectDir: z.string(), executionRoot: z.string(), ffmpeg: z.string(), ffprobe: z.string(),
  progress: z.string(), candidate: z.string(), beforeSpawn: z.string(), loaded: z.string(), joined: z.string(), release: z.string(),
  holdProof: z.boolean(), complete: z.boolean(), retry: z.enum(['initial', 'host-disconnect-recovery', 'explicit-retry']) })

async function waitForRelease(path) {
  const watcher = watch(join(path, '..'))
  try {
    await new Promise((resolve, reject) => {
      const check = async () => {
        try { await stat(path); resolve() } catch (error) { if (error.code !== 'ENOENT') reject(error) }
      }
      watcher.on('change', () => { void check().catch(reject) })
      watcher.once('error', reject)
      void check().catch(reject)
    })
  } finally { watcher.close() }
}

/** The fixture renderer uses only the captured media channel and private files. */
export function apply(ctx, config) {
  let descriptor, job, profileReady = false
  ctx.effect(() => ctx.appReady.onReady(() => { profileReady = true }))
  const startup = config.fixtureStartup
  let eofPublication = Promise.resolve()
  const observedEof = () => { if (startup) eofPublication = writeFile(startup.eof, 'EOF\n') }
  if (startup) { process.stdin.once('end', observedEof); ctx.effect(() => () => { process.stdin.off('end', observedEof) }) }
  installEpisodeGuardian(ctx, config, () => ({
    async load(ownerConfig, request, signal) {
      if (!profileReady) throw new Error('fixture core loaded before actual appReady')
      if (startup && !startup.fail) {
        await writeFile(startup.installed, 'input loading after actual profile readiness\n')
        await waitForRelease(startup.release)
        await eofPublication
      }
      signal.throwIfAborted()
      const bytes = await readFile(ownerConfig.descriptorPath)
      if (bytes.length > ownerConfig.descriptorBytes || createHash('sha256').update(bytes).digest('hex') !== ownerConfig.descriptorSha256
        || request.identity.descriptorSha256 !== ownerConfig.descriptorSha256) throw new Error('fixture descriptor mismatch')
      descriptor = descriptorSchema.parse(JSON.parse(bytes.toString('utf8')))
      job = await createEpisodeDeliveryJob({ projectDir: descriptor.projectDir, identity: request.identity,
        recordBytes: ownerConfig.journalBytes, lockWaitMs: ownerConfig.lockWaitMs })
      await writeFile(descriptor.loaded, JSON.stringify({ identity: request.identity, pid: process.pid }))
      return { identity: request.identity, stageRoot: descriptor.executionRoot,
        ffmpeg: descriptor.ffmpeg, ffprobe: descriptor.ffprobe, retry: descriptor.retry }
    },
    journal(execution, ownerConfig) {
      const journal = createGuardianJournal({ attemptRoot: job.attemptRoot, recordBytes: ownerConfig.journalBytes,
        assertAdmission: job.assertAdmission, armExecution: job.armExecution })
      return { ...journal, async publishDrain(proof) {
        await writeFile(descriptor.joined, JSON.stringify(proof))
        if (descriptor.holdProof) await waitForRelease(descriptor.release)
        await journal.publishDrain(proof)
      } }
    },
    async render(execution, channel, signal) {
      if (!profileReady) throw new Error('fixture renderer entered before actual appReady')
      const running = JSON.parse(await readFile(join(job.attemptRoot, 'execution.json'), 'utf8'))
      const current = await job.read()
      if (running.identity.execution !== execution.identity.execution || running.guardianPid !== process.pid) throw new Error('running record not armed')
      await writeFile(descriptor.beforeSpawn, JSON.stringify({ running, job: current }))
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10',
        '-progress', descriptor.progress, '-nostats']
      if (descriptor.complete) args.push('-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', descriptor.candidate)
      else args.push('-f', 'null', '-')
      const outcome = await channel.run(execution.ffmpeg, args)
      signal.throwIfAborted()
      if (outcome.code !== 0) throw new Error(`fixture ffmpeg failed: ${outcome.stderr}`)
      const bytes = await readFile(descriptor.candidate)
      return { outputSha256: createHash('sha256').update(bytes).digest('hex'), outputBytes: bytes.length }
    },
  }))
  if (startup?.fail) {
    writeFileSync(startup.installed, 'core installed before synchronous startup failure\n')
    throw new Error('fixture startup rejected after early EOF')
  }
}
