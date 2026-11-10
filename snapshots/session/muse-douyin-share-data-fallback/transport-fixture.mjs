/** Authored native receipt through the real download tool; codecs and publication have separate Host tests. */
import { basename } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import { persistDouyinReplayOwner } from '../douyin-stable-owner.mjs'
import { mediaReceipt } from '../../../third_party/plugins/muse-douyin-download/tests/task-fixtures.js'

const { mediaEvidence, nativeMediaFacts } = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/douyin-media-facts.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/types/douyin-media-facts.js', import.meta.url),
)

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/cli/package.json', import.meta.url))
const target = '7692443246022167851'
const url = `https://www.douyin.com/video/${target}`
const taskId = '71000000-0000-4000-8000-000000000001'
export const name = 'snapshot-douyin-share-data-fallback-transport'
export const inject = ['sessions', 'sessionPersistence']

class PublicFailure extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  spawn(spec) {
    spec.signal?.throwIfAborted()
    if (!spec.argv.some(value => basename(value) === 'download.py') || !spec.argv.includes('--public-only')) {
      throw new Error('Native receipt fixture refuses unrelated subprocesses')
    }
    const text = JSON.stringify({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: The official share page returned unsupported video data.' })
    return { done: Promise.resolve({ exitCode: 1, signal: null }), waitForExit: async () => true,
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) } } }
  }
}

class BrowserSuccess extends Service {
  version = 4
  constructor(ctx) { super(ctx, 'douyinBrowser') }
  async download(agent, requested, signal, _maxDownloadBytes, nativeTimeoutMs) {
    signal.throwIfAborted()
    if (nativeTimeoutMs !== 1800000) throw new Error('Missing native timeout deployment setting')
    const cwd = agent.session.header.cwd
    if (cwd === undefined || requested !== url) throw new Error('Native receipt fixture refuses unrelated works')
    const evidence = mediaEvidence({ responseStatus: 206, mediaHost: 'v3.douyinvod.com', mediaUrlHash: 'a'.repeat(64),
      association: 'player-metadata-verified', currentSrcMatched: false,
      playerMetadata: { targetVideoId: target, sourceField: 'video.bitRateList.playAddr', durationMs: 1012,
        width: 32, height: 32, documentEpoch: 1, source: 'player-parent-awemeInfo' } }, target)
    const { duration, width, height } = nativeMediaFacts({ format: { duration: '1' },
      streams: [{ codec_type: 'video', width: 16, height: 16 }] }, evidence)
    return mediaReceipt(agent, requested, {
      duration_seconds: duration, width, height, authentication: 'muse-browser', taskId, targetVideoId: target,
      evidence, retrieved_at: '2026-10-07T03:00:00.000Z',
    })
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated profile context. */
export async function apply(ctx) {
  await persistDouyinReplayOwner(ctx, 'snapshot-douyin-share-data-fallback')
  await ctx.plugin(PublicFailure)
  await ctx.plugin(BrowserSuccess)
  ctx.effect(() => ctx.provide('douyinReplayOwnerReady', true))
}
