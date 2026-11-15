/** Controlled local session; downloading or refreshing authorization is forbidden in this owner. */
import assert from 'node:assert/strict'
import { lstat } from 'node:fs/promises'

export const calls = []
export const sessions = []
export const privateMarker = 'PRIVATE_HEALTH_DEVICE_PROOF_VALUE'
export class V2Session {
  constructor(_subprocess, _config, paths) {
    this.paths = paths
    this.sourceIdentity = '3'.repeat(64)
    this.privateValue = privateMarker
    sessions.push(this)
  }
  async start(signal) { signal.throwIfAborted(); calls.push({ method: 'start' }) }
  async health(signal) {
    signal.throwIfAborted(); calls.push({ method: 'health' })
    return { sourceIdentity: this.sourceIdentity,
      engine: { engineVersion: 'fixture-hongguo-v2', protocol: 2, build: 15 },
      localLicenseStatus: { mode: 'Checking', reason: 'checking', refreshed: false } }
  }
  async catalog(id, signal) {
    signal.throwIfAborted(); calls.push({ method: 'catalog', id })
    return { seriesId: id, title: '虚构健康检查剧目', source: 'hongguo-v2', episodeCount: 2,
      episodes: [1, 2].map(index => ({ index, vid: `${id}:${index}`, title: `第 ${index} 集`, durationSeconds: 10 })) }
  }
  async download() { calls.push({ method: 'download' }); throw new Error('Health must never download') }
  async refresh() { calls.push({ method: 'refresh' }); throw new Error('Health must never refresh authorization') }
  async authorize() { calls.push({ method: 'authorize' }); throw new Error('Health must never authorize a series') }
  async dispose() {
    assert.equal((await lstat(this.paths.runDir)).isDirectory(), true)
    calls.push({ method: 'dispose' })
  }
}
