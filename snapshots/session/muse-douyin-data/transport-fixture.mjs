/** Authored page facts and separate download failures through the real data tool and agent loop. */
import { basename } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/cli/package.json', import.meta.url))

export const name = 'snapshot-douyin-data-transport'

class PublicFailure extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  spawn(spec) {
    spec.signal?.throwIfAborted()
    if (!spec.argv.some(value => basename(value) === 'download.py') || !spec.argv.includes('--public-only')) {
      throw new Error('Blocked download fixture refuses unrelated subprocesses')
    }
    const text = JSON.stringify({ status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE' })
    return { done: Promise.resolve({ exitCode: 1, signal: null }), waitForExit: async () => {},
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) } } }
  }
}

class BrowserFailure extends Service {
  version = 4
  constructor(ctx) { super(ctx, 'douyinBrowser') }
  async data(agent, selection, signal) {
    signal.throwIfAborted()
    if (agent.session.header.cwd === undefined) throw new Error('Missing initiating workspace')
    if (selection.url === 'https://www.douyin.com/video/7692443246022167851') return { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' }
    if (selection.url !== 'https://www.douyin.com/video/7660900818614324490' || selection.source !== 'public') throw new Error('Data fixture refuses unrelated works')
    return { status: 'ok', source: 'public-page', targetVideoId: '7660900818614324490', observedAt: '2026-10-06T12:00:00.000Z',
      counts: { play_count: { value: null, precision: 'unavailable', reason: 'not-exposed' },
        digg_count: { value: 12, precision: 'exact' }, comment_count: { value: 3, precision: 'exact' },
        share_count: { value: 1, precision: 'exact' }, collect_count: { value: 1, precision: 'exact' } },
      comments: { status: 'not-requested', items: [], cursor: null, hasMore: null } }
  }
  async download(agent, url, signal, _maxDownloadBytes, nativeTimeoutMs) {
    if (nativeTimeoutMs !== 1800000) throw new Error('Missing native timeout deployment setting')
    signal.throwIfAborted()
    if (agent.session.header.cwd === undefined) throw new Error('Missing initiating workspace')
    const codes = new Map([
      ['https://www.douyin.com/video/7660900818614324490', 'PLAYER_PROBE_UNAVAILABLE'],
      ['https://www.douyin.com/video/7692443246022167851', 'MEDIA_DNS_UNAVAILABLE'],
    ])
    const code = codes.get(url)
    if (code === undefined) throw new Error('Blocked download fixture refuses an unrelated video')
    return { status: 'blocked', code }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated profile context. */
export async function apply(ctx) {
  await ctx.plugin(PublicFailure)
  await ctx.plugin(BrowserFailure)
}
