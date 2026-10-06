/** A renderer validates declared music plans before consuming their selected bed. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readBgmPlan } from '../src/bgm.ts'
import { cleanup, tempProject } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanup(root))) })

const segment = { track: 'track one', source: 'music.mp3', start_seconds: 0, end_seconds: 2 }
const episode = { episode: '01', body_duration_seconds: 4, segments: [segment] }

it.each([
  { document: '{invalid', message: '不可读' },
  { document: JSON.stringify({ episodes: [] }), message: '缺少第 01 集' },
  { document: JSON.stringify({ episodes: [episode, { ...episode, episode: '1' }] }), message: '集号重复或无效' },
  { document: JSON.stringify({ episodes: [{ ...episode, episode: 'invalid' }] }), message: '集号重复或无效' },
  { document: JSON.stringify({ episodes: [{ ...episode, body_duration_seconds: 6 }] }), message: '正文时长' },
  { document: JSON.stringify({ episodes: [{ ...episode, segments: [] }] }), message: '没有段落' },
  ...[
    { ...segment, track: ' ' }, { ...segment, source: '' },
    { ...segment, start_seconds: -1 }, { ...segment, end_seconds: 0 }, { ...segment, end_seconds: 5 },
  ].map(value => ({ document: JSON.stringify({ episodes: [{ ...episode, segments: [value] }] }), message: '段落须有曲目来源' })),
  { document: JSON.stringify({ episodes: [{ ...episode, segments: [
    { ...segment, start_seconds: 2, end_seconds: 3 }, segment,
  ] }] }), message: '按起点排序' },
])('retains and rejects an unusable declared plan: $message', async ({ document, message }) => {
  const project = await tempProject()
  roots.push(project)
  const plan = join(project, 'bgm.json')
  await writeFile(plan, document)
  await expect(readBgmPlan(plan, '01', 4, join(project, 'bed.mp3'), project)).rejects.toThrow(message)
  expect(await readFile(plan, 'utf8')).toBe(document)
})
