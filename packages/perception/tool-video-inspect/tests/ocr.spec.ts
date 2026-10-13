/** OCR evidence parsing and classification remain deterministic without Windows or paid services. */
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { ocrBridgeHostPath, classifyAndMerge, parseOcrBridgeResult, showinfoTimestamps, splitMjpeg, type RawOcrFrame, type RawOcrLine } from '../src/ocr.ts'

const line = (text: string, x = 10, y = 10): RawOcrLine => ({ text,
  bounding_box: { x, y, width: 40, height: 10 }, words: [{ text, bounding_box: { x, y, width: 40, height: 10 } }] })

const frame = (id: string, timestamp: number, lines: RawOcrLine[]): RawOcrFrame => ({ id,
  requested_seconds: timestamp, timestamp_seconds: timestamp, image_width: 100, image_height: 100, lines })

it('validates Chinese, English and mixed raw OCR evidence without changing text', () => {
  const value = { ok: true, language_used: 'zh-Hans-CN', frames: [{ id: 'frame-1', timestamp_seconds: 1,
    image_width: 1280, image_height: 720, lines: [line('你好'), line('Hello'), line('第 2 集 EP02')] }] }
  expect(parseOcrBridgeResult(Buffer.from(JSON.stringify(value)))).toEqual(value)
  for (const invalid of [{}, { ok: false, code: 'raw-exception' }, { ok: true, language_used: 'en-US', frames: [{}] },
    { ok: true, language_used: 'en-US', frames: [{ id: 'x', timestamp_seconds: 0, image_width: 1, image_height: 1,
      lines: [{ text: 'x', bounding_box: {}, words: [] }] }] }]) {
    expect(() => parseOcrBridgeResult(Buffer.from(JSON.stringify(invalid)))).toThrow('invalid')
  }
})

it('splits only complete JPEG batches and preserves FFmpeg timestamp order', () => {
  const first = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]), second = Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9])
  expect(splitMjpeg(Buffer.concat([first, second])).map(bytes => Buffer.from(bytes))).toEqual([first, second])
  expect(showinfoTimestamps('n:0 pts:0 pts_time:0.5\nn:1 pts:1 pts_time:1.25')).toEqual([0.5, 1.25])
  expect(() => splitMjpeg(Buffer.from([0xff, 0xd8, 1]))).toThrow('partial')
  expect(() => splitMjpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd8, 0xff, 0xd9]))).toThrow('nested')
})

it('retains repeated subtitles while conservatively labelling a long-lived exact overlay', () => {
  const frames = Array.from({ length: 10 }, (_, index) => frame(`f-${index}`, index, [
    line('平台水印', 2, 2),
    line(index < 3 ? '你好 Hello' : index < 6 ? '下一句' : '短时字幕', 20, 70),
  ]))
  const segments = classifyAndMerge(frames, { frameIntervalSeconds: 1, persistentTextMinFrames: 8,
    persistentTextMinSeconds: 8, overlayMinIou: 0.7 })
  expect(segments).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: '平台水印', classification: 'persistent_text_candidate', start_seconds: 0, end_seconds: 10 }),
    expect.objectContaining({ text: '你好 Hello', classification: 'content_candidate', start_seconds: 0, end_seconds: 3 }),
    expect.objectContaining({ text: '下一句', classification: 'content_candidate', start_seconds: 3, end_seconds: 6 }),
    expect.objectContaining({ text: '短时字幕', classification: 'content_candidate', start_seconds: 6, end_seconds: 10 }),
  ]))
  expect(frames.every(item => item.lines[0]?.classification === 'persistent_text_candidate')).toBe(true)
  expect(frames.every(item => item.lines[1]?.classification === undefined)).toBe(true)
})

it('does not label moving or short-lived story text as a removable overlay', () => {
  const frames = [frame('a', 0, [line('关键剧情字', 10, 10)]), frame('b', 1, [line('关键剧情字', 50, 50)]),
    frame('c', 2, [line('关键剧情字', 10, 10)])]
  const segments = classifyAndMerge(frames, { frameIntervalSeconds: 1, persistentTextMinFrames: 3,
    persistentTextMinSeconds: 2, overlayMinIou: 0.7 })
  expect(segments).toEqual([expect.objectContaining({ text: '关键剧情字', classification: 'content_candidate' })])
  expect(frames.every(item => item.lines[0]?.classification === undefined)).toBe(true)
})

it('ships the Windows bridge and resolves its installed ASAR-unpacked path', async () => {
  expect(await readFile(new URL('../scripts/ocr_bridge.ps1', import.meta.url), 'utf8')).toContain('InMemoryRandomAccessStream')
  expect(ocrBridgeHostPath('file:///C:/Muse/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tool-video-inspect/lib/index.js').replaceAll('\\', '/'))
    .toContain('/Muse/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tool-video-inspect/scripts/ocr_bridge.ps1')
})

it('ships the offline Python bridge and resolves its installed ASAR-unpacked path', async () => {
  expect(await readFile(new URL('../scripts/ocr_bridge.py', import.meta.url), 'utf8')).toContain('model_path')
  expect(ocrBridgeHostPath('file:///Applications/Muse.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tool-video-inspect/lib/index.js', 'rapidocr'))
    .toContain('/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tool-video-inspect/scripts/ocr_bridge.py')
})

it('keeps a long-held narrative subtitle as content even when its visual persistence matches a watermark', () => {
  const frames = Array.from({ length: 24 }, (_, index) => frame(`f-${index}`, index / 2,
    [line('我终于找到你了', 20, 70), line('I finally found you.', 10, 50)]))
  const segments = classifyAndMerge(frames, { frameIntervalSeconds: 0.5,
    persistentTextMinFrames: 12, persistentTextMinSeconds: 8, overlayMinIou: 0.7 })
  expect(segments.map(segment => segment.text)).toEqual(['我终于找到你了', 'I finally found you.'])
  expect(segments.every(segment => segment.classification === 'persistent_text_candidate')).toBe(true)
  expect(segments.every(segment => segment.evidence_frame_ids.length === 24)).toBe(true)
})

it('retains OCR reading order and distinct simultaneous copies of the same text', () => {
  const frames = [frame('a', 0, [line('You can leave now,', 10, 50), line('but I will stay.', 10, 70),
    line('你好', 10, 20), line('你好', 50, 20)]),
  frame('b', 1, [line('You can leave now,', 10, 50), line('but I will stay.', 10, 70),
    line('你好', 10, 20), line('你好', 50, 20)])]
  const segments = classifyAndMerge(frames, { frameIntervalSeconds: 1,
    persistentTextMinFrames: 12, persistentTextMinSeconds: 8, overlayMinIou: 0.7 })
  expect(segments.map(segment => segment.text)).toEqual(['You can leave now,', 'but I will stay.', '你好', '你好'])
  expect(segments.map(segment => segment.evidence_frame_ids)).toEqual([['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']])
})

it('rejects malformed frame, line and word fields at the OCR process JSON parser', () => {
  const wrap = (lines: unknown[], fields: Record<string, unknown> = {}) => ({ ok: true, language_used: 'zh-Hans-CN',
    frames: [{ id: 'a', timestamp_seconds: 0, image_width: 100, image_height: 100, lines, ...fields }] })
  const valid = line('你好')
  const invalid = [null, false, { ok: 'true' }, { ok: true, language_used: 2, frames: [] },
    { ok: true, language_used: 'en-US', frames: [null] }, wrap([], { image_width: 0 }),
    wrap([], { image_height: 1.5 }), wrap([], { timestamp_seconds: '0' }),
    ...[null, 0, { ...valid, bounding_box: null }, { ...valid, bounding_box: { x: 0, y: 0, width: -1, height: 2 } },
      { ...valid, words: [null] }, { ...valid, words: [{ text: 'x', bounding_box: null }] }].map(value => wrap([value]))]
  for (const value of invalid) {
    expect(() => parseOcrBridgeResult(Buffer.from(JSON.stringify(value))), JSON.stringify(value)).toThrow('invalid')
  }
  for (const code of ['language_unavailable', 'ocr_engine_unavailable', 'invalid_input', 'frame_decode_failed']) {
    expect(parseOcrBridgeResult(Buffer.from(JSON.stringify({ ok: false, code })))).toEqual({ ok: false, code })
  }
})

it('ignores whitespace-only OCR lines and does not infer persistence from zero-area boxes', () => {
  const blank = line('  ')
  const emptyBox = { ...line('标题'), bounding_box: { x: 0, y: 0, width: 0, height: 0 } }
  const frames = [frame('a', 0, [blank, emptyBox]), frame('b', 10, [blank, emptyBox])]
  expect(classifyAndMerge(frames, { frameIntervalSeconds: 1,
    persistentTextMinFrames: 2, persistentTextMinSeconds: 8, overlayMinIou: 0.7 }))
    .toEqual([expect.objectContaining({ text: '标题', classification: 'content_candidate', start_seconds: 0 }),
      expect.objectContaining({ text: '标题', classification: 'content_candidate', start_seconds: 10 })])
})
