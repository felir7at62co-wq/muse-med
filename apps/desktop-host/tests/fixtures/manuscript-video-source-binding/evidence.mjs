/** Small saved sources and cached frames used by the delivery-binding process fixture. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const [{ FsVersion }, { createVideoReviewReader }] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-fs', owner), importSnapshotPackage('@deepseek-ai/dsh-tool-video-inspect', owner),
])
/** The complete assessed draft; blank trailing text does not add mapped action. */
export const DRAFT = '第1集\n1-1 门口 日 内\n人物：声音A、声音B\n声音A：旧床不要拆。\n▲床保持完整，两人站在门口。\n声音B：还没同意。\n'
/** Saved source bytes are never decoded by this source-binding scenario. */
export const SOURCE = 'Synthetic cached video source for delivery binding.\n'
/** Original saved recognition rows, kept separate from listening or speaker verification. */
export const ROWS = [{ start: 1, end: 2, text: '旧床不要拆。', speaker_id: 'acoustic-A' },
  { start: 3, end: 4, text: '还没同意。', speaker_id: 'acoustic-B' }]
/** Complete saved recognition JSON. */
export const ASR = JSON.stringify(ROWS) + '\n'
/** Exact source selection supplied by every source review in this fixture. */
export const SELECTION = [{ review_id: 'binding-video-source', start_seconds: 0, end_seconds: 6,
  draft_lines: { start: 1, end: 6 }, frame_ids: ['F00001', 'F00002'] }]

const hash = value => createHash('sha256').update(value).digest('hex')

/** Prepare actual local evidence and byte-sensitive, portable filesystem revision tokens.
 * @param ctx - Actual Headless filesystem and attachment services.
 * @param parent - Live parent Agent owning the source observations.
 * @returns Reset and mutation operations scoped to this fixture's two files and cached images.
 */
export async function evidence(ctx, parent) {
  const cwd = parent.session.header.cwd, filenames = new Set(['source.mp4', 'source.asr.json'])
  const reader = await createVideoReviewReader(ctx)
  ctx.effect(() => {
    const resolve = ctx.fs.resolve.bind(ctx.fs), stat = ctx.fs.stat.bind(ctx.fs)
    ctx.fs.resolve = async (path, options) => {
      const target = await resolve(path, options)
      const filename = basename(target.displayPath)
      return filenames.has(filename) && target.displayPath === join(cwd, filename)
        ? { ...target, displayPath: filename } : target
    }
    // Real content changes still change the revision; temporary inode and clock fields do not enter snapshots.
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && filenames.has(target.displayPath)
        ? { ...info, version: FsVersion(`binding-${hash(await readFile(join(cwd, target.displayPath)))}`) } : info
    }
    return () => { ctx.fs.resolve = resolve; ctx.fs.stat = stat }
  })
  await writeFile(join(cwd, 'source.mp4'), SOURCE)
  await writeFile(join(cwd, 'source.asr.json'), ASR)
  const images = await Promise.all(['frame-a.png', 'frame-b.png'].map(async name => ctx.attachments.saveImage({
    mediaType: 'image/png', data: await readFile(new URL(`../manuscript-video-source/${name}`, import.meta.url)) })))
  const source = await ctx.fs.resolve('source.mp4', { cwd }), speech = await ctx.fs.resolve('source.asr.json', { cwd })
  const sourceInfo = await ctx.fs.stat(source), speechInfo = await ctx.fs.stat(speech)
  assert.ok(sourceInfo && speechInfo)
  const baseline = { id: SELECTION[0].review_id, episode: '1', path: 'source.mp4', source_version: sourceInfo.version,
    duration: 6, scanned_until: 6, scan_complete: true,
    transcript_reference: { path: 'source.asr.json', version: speechInfo.version, sha256: hash(ASR) },
    frames: images.map((image, index) => ({ id: SELECTION[0].frame_ids[index], time: index === 0 ? 0.5 : 4.5,
      reasons: ['cached-test-frame'], image, exposed: true,
      observation: { visible: '缓存测试帧；不是经验证的剧情判断。', change: '固定管道样例。', uncertainty: '不验证模型语义能力。' } })) }
  async function reset() {
    await writeFile(join(cwd, 'source.mp4'), SOURCE)
    await writeFile(join(cwd, 'source.asr.json'), ASR)
    parent.session.append('video/review', { kind: 'start', review: baseline })
  }
  await reset()
  assert.ok(reader(parent.session)['source.mp4'])
  return { images, reset, async mutate(kind) {
    if (kind === 'video') await writeFile(join(cwd, 'source.mp4'), SOURCE + 'Changed video bytes.\n')
    else if (kind === 'asr') await writeFile(join(cwd, 'source.asr.json'), ASR.replace('不要拆', '已经拆'))
    else if (kind === 'image') parent.session.append('video/review', { kind: 'start', review: { ...baseline,
      frames: baseline.frames.map((frame, index) => index === 0 ? { ...frame, image: images[1] } : frame) } })
    else throw Error(`Unknown source mutation ${kind}`)
  } }
}
