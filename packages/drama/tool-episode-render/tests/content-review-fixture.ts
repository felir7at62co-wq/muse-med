import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileSha256 } from '../src/cache.ts'

export async function contentReviewFixture(input: { project: string
  episode: string
  output: string
  duration: number
  sources: { shot: number; path: string; duration: number }[] }) {
  const json = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value))
    return await fileSha256(path)
  }
  const target = async (path: string, duration: number, key: string, shot?: number) => {
    const report = join(input.project, 'content-evidence', `${key}.json`)
    const value = { duration, frames: [
      { id: 'first', decoded_time: 0.1 }, { id: 'last', decoded_time: duration - 0.1 },
    ] }
    const sha256 = await json(report, value)
    return { source: path, sha256: await fileSha256(path), ...(shot === undefined ? {} : { shot }),
      inspection: { path: report, sha256, session_id: 'review-session', review_id: key },
      checks: ['physical_logic', 'continuity'].map(dimension => ({ dimension, start_seconds: 0, end_seconds: duration,
        status: 'ok', expected: '人物放杯后离开，场景与动作顺序连续', reason: '按所引用前后画面核对了物体支撑和人物位置', frame_ids: ['first', 'last'] })) }
  }
  const sources = []
  for (const source of input.sources) sources.push(await target(source.path, source.duration, `source-${source.shot}`, source.shot))
  const output = await target(input.output, input.duration, 'output')
  const document = { films: { [input.episode]: { source: input.output, sha256: await fileSha256(input.output), reviewed: true,
    picture: 'ok', audio: 'ok', subtitle: 'ok', spec: 'ok', issues: [], content_review: { version: 1, sources, output,
      audio: { status: 'ok', session_id: 'review-session', question_call_id: 'listen', ranges: [
        { dimension: 'pronunciation', start_seconds: 0, end_seconds: input.duration, status: 'ok', reason: '实际完整试听' },
      ] } } } } }
  const path = join(input.project, '_probe/delivery-config/film-reviews.json')
  await json(path, document)
  return { path, document, entry: document.films[input.episode]!, json }
}
