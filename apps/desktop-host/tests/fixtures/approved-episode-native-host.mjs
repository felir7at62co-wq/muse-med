/** Normal profile consuming production Jubian composition and the actual configured renderer. */
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import * as ToolJubian from '@deepseek-ai/dsh-tool-jubian'
import { createConfiguredEpisodeRenderer } from '../../src/approved-episode-render.ts'
import { parseEpisodeRendererConfig } from '../../src/episode-render-descriptor.ts'

export const name = 'approved-episode-native-host-fixture'
export const inject = ['tools', 'credentials', 'subprocess', 'appReady', 'appExit']

/** The fixture supplies only private installation/data paths and a local media input. */
export function apply(ctx, config) {
  const lifetime = new AbortController()
  let renderer, operation = Promise.resolve(), fetchCalls = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { fetchCalls++; throw new Error('No provider or model network operation is allowed in the native fixture') }
  ctx.effect(() => async () => {
    lifetime.abort()
    await operation
    await renderer?.dispose()
    process.stdin.pause()
    globalThis.fetch = previousFetch
  })
  ctx.effect(() => ctx.appReady.onReady(() => {
    operation = (async () => {
      await ctx.plugin(ToolJubian, { ledgerRoot: config.ledgerRoot, videoRecoverySettings: true, workspaceSecrets: false,
        videoRecoveryFfmpegPath: config.ffmpeg, videoRecoveryDecodeTimeoutMs: 30000,
        videoRecoveryDecodeGraceMs: 100, videoRecoveryDecodeMaxOutputBytes: 131072,
        episodeDeliveryRecordBytes: 2097152, episodeDeliveryMetadataMaxBytes: 1048576, episodeDeliveryLockWaitMs: 30000 }).await()
      const recovery = ctx.get('jubianVideoRecovery')
      const episode = ctx.get('jubianEpisodeDelivery')
      if (recovery === undefined || episode === undefined) throw new Error('Production ToolJubian did not mount both actual services')
      await recovery.configure({ enabled: false, projectDir: config.project })
      if (!config.resume) await recovery.review({ ...config.review, action: 'approve' })
      const text = await readFile(new URL('../../presets/creation/agent.cordis.yml', import.meta.url), 'utf8')
      const rows = parseYaml(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] })
      const selected = rows.filter(row => row.id === 'tool-episode-render')
      if (selected.length !== 1) throw new Error('Native fixture has no unique actual creation renderer')
      const rendererConfig = parseEpisodeRendererConfig(interpolate(ctx, selected[0].config))
      renderer = await createConfiguredEpisodeRenderer({ rendererConfig, carrier: config.carrier, endingAssetRoot: config.endingAssetRoot,
        codeFiles: [fileURLToPath(new URL('../../src/approved-episode-render.ts', import.meta.url)),
          fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-episode-render')),
          fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-jubian/episode-delivery')), config.carrier.workerEntry],
        limits: config.limits, resolveExecutable: command => ctx.subprocess.resolveExecutable(command), verifyConfiguration: async () => {} }, lifetime.signal)
      ctx.provide('approvedEpisodeRenderer', renderer)
      // Optional provider replacement may retire the earlier service instance.
      const current = ctx.get('jubianEpisodeDelivery')
      if (current === undefined) throw new Error('Production episode service is unavailable after renderer publication')
      const ready = await current.episodeReadiness({ projectDir: config.project, episode: 1 })
      if (!ready.ready || ready.digest === null) throw new Error('Native episode was not ready: ' + ready.issues.join('; '))
      const request = { projectDir: config.project, episode: 1, digest: ready.digest }
      const admitted = await current.admitEpisode({ ...request, ...(config.resume ? { resume: true } : {}) })
      console.log(JSON.stringify({ kind: 'admitted', ...admitted }))
      let status = admitted, previous = ''
      while (!['completed', 'failed', 'cancelled', 'unknown'].includes(status.state)) {
        lifetime.signal.throwIfAborted()
        status = await current.episodeStatus(request)
        if (status.state !== previous) { previous = status.state; console.log(JSON.stringify({ kind: 'state', ...status })) }
        if (!['completed', 'failed', 'cancelled', 'unknown'].includes(status.state)) await delay(25, undefined, { signal: lifetime.signal })
      }
      await writeFile(config.result, JSON.stringify({ productionComposition: true, ready, admitted, status, fetchCalls }) + '\n')
      ctx.appExit(status.state === 'completed' ? 0 : 1)
    })().catch(error => { console.error(error); ctx.appExit(1) })
  }))
}
