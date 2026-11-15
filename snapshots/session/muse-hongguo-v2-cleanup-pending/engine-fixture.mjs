/** Controlled external engine; the real adapter still validates, hashes and publishes each file. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const box = (name, body = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(name, 4); return Buffer.concat([h, body]) }
export const media = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('v2 media fixture'))])
export const calls = []
export const privateMarker = 'PRIVATE_V2_SIGNING_AND_DEVICE_VALUE'
export class V2Session {
  constructor(_subprocess, _config, paths) { this.paths = paths; this.sourceIdentity = '2'.repeat(64) }
  async start() {}
  async catalog(id) { calls.push({ method: 'catalog', id }); return { seriesId: id, title: '虚构v2剧', source: 'hongguo-v2', episodeCount: 2, episodes: [1, 2].map(index => ({ index, vid: `${id}:${index}`, title: `第 ${index} 集`, durationSeconds: 10 })) } }
  async download(id, _title, episodes) {
    calls.push({ method: 'download', id, episodes })
    const folder = join(this.paths.outputDir, id); await mkdir(folder)
    for (const index of episodes) await writeFile(join(folder, `S01E${String(index).padStart(3, '0')}.mp4`), media)
    return { job: { state: 'done', done: episodes.length, episodes: episodes.length, failed: 0 }, folder }
  }
  async dispose() {}
}
