/** Authored native receipt through the real download tool; codecs and publication have separate Host tests. */
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { mediaEvidence, nativeMediaFacts } from '../../../apps/desktop-host/src/douyin-media-facts.ts'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/cli/package.json', import.meta.url))
const target = '7692443246022167851'
const url = `https://www.douyin.com/video/${target}`
const taskId = '71000000-0000-4000-8000-000000000001'
export const name = 'snapshot-douyin-player-metadata-transport'

class PublicFailure extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  spawn(spec) {
    spec.signal?.throwIfAborted()
    if (!spec.argv.some(value => basename(value) === 'download.py') || !spec.argv.includes('--public-only')) {
      throw new Error('Native receipt fixture refuses unrelated subprocesses')
    }
    const text = JSON.stringify({ status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE' })
    return { done: Promise.resolve({ exitCode: 1, signal: null }), waitForExit: async () => true,
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) } } }
  }
}

class BrowserSuccess extends Service {
  version = 3
  constructor(ctx) { super(ctx, 'douyinBrowser') }
  async download(agent, requested, signal) {
    signal.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined || requested !== url) throw new Error('Native receipt fixture refuses unrelated works')
    const evidence = mediaEvidence({ responseStatus: 206, mediaHost: 'v3.douyinvod.com', mediaUrlHash: 'a'.repeat(64),
      association: 'player-metadata-verified', currentSrcMatched: false,
      playerMetadata: { targetVideoId: target, sourceField: 'video.bitRateList.playAddr', durationMs: 34434,
        width: 3840, height: 2160, documentEpoch: 1, source: 'player-parent-awemeInfo' } }, target)
    const { duration, width, height } = nativeMediaFacts({ format: { duration: '34.41' },
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }] }, evidence)
    const path = join(cwd, 'source', 'media', 'douyin', `${target}-${taskId}.mp4`)
    return { status: 'downloaded', path, receipt: path + '.source.json', source: url,
      bytes: 13, sha256: createHash('sha256').update('fixture-media').digest('hex'),
      duration_seconds: duration, width, height, full_decode_verified: true,
      authentication: 'muse-browser', taskId, targetVideoId: target, evidence, retrieved_at: '2026-10-07T03:00:00.000Z' }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated profile context. */
export async function apply(ctx) {
  await ctx.plugin(PublicFailure)
  await ctx.plugin(BrowserSuccess)
}
