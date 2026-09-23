/** Subtitle input and the ASS script the delivery burns. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAssHeader, WATERMARK_TEXT } from '../src/delivery.ts'
import { buildAssDocument, parseSrtDocument, parseSrtTime, readSubtitleCues } from '../src/subtitles.ts'
import type { SubtitleCue } from '../src/types.ts'
import { cleanup, srtDocument, tempProject } from './harness.ts'

const temporary: string[] = []
const fonts = { subtitleFontFamily: 'SimHei', watermarkFontFamily: 'Microsoft YaHei' }
const ASS_DOCUMENT_HEADER = buildAssHeader(fonts)

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** One cue at the given second boundaries. */
function cue(index: number, startSeconds: number, endSeconds: number, text = '台词'): SubtitleCue {
  return { index, startSeconds, endSeconds, text }
}

describe('parseSrtTime', () => {
  it('reads a comma-separated timestamp', () => {
    expect(parseSrtTime('00:01:02,500', 'a.srt')).toBe(62.5)
  })

  it('reads a dot-separated timestamp', () => {
    expect(parseSrtTime(' 01:00:00.250 ', 'a.srt')).toBe(3600.25)
  })

  it('fails loud on a timestamp with the wrong field count', () => {
    expect(() => parseSrtTime('02,500', 'a.srt')).toThrow('不是 HH:MM:SS,mmm 形式')
  })

  it('fails loud on a timestamp with a non-numeric field', () => {
    expect(() => parseSrtTime('00:xx:02,500', 'a.srt')).toThrow('含有非数字字段')
  })
})

describe('parseSrtDocument', () => {
  it('reads every cue, numbering them from one', () => {
    const cues = parseSrtDocument(srtDocument([
      { start: '00:00:01,680', end: '00:00:03,580', text: '京市户口 单身' },
      { start: '00:00:03,580', end: '00:00:04,880', text: '履历干净 嘴严' },
    ]), 'a.srt')
    expect(cues).toEqual([
      cue(1, 1.68, 3.58, '京市户口 单身'),
      cue(2, 3.58, 4.88, '履历干净 嘴严'),
    ])
  })

  it('strips a byte-order mark and normalizes CRLF line endings', () => {
    const cues = parseSrtDocument('\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\n第一行\r\n第二行\r\n', 'a.srt')
    expect(cues).toEqual([cue(1, 1, 2, '第一行第二行')])
  })

  it('skips a block that is not a cue', () => {
    expect(parseSrtDocument('标题\n\n1\n00:00:01,000 --> 00:00:02,000\n正文\n', 'a.srt')).toEqual([cue(1, 1, 2, '正文')])
  })

  it('skips a block with a timing line but no text line', () => {
    expect(parseSrtDocument('1\n00:00:01,000 --> 00:00:02,000\n', 'a.srt')).toEqual([])
  })

  it('fails loud on a malformed timestamp inside a cue', () => {
    expect(() => parseSrtDocument('1\n--> 00:00:02,000\n正文\n', 'a.srt')).toThrow('不是 HH:MM:SS,mmm 形式')
  })
})

describe('readSubtitleCues', () => {
  it('reads cues from a file', async () => {
    const project = await tempProject()
    temporary.push(project)
    const path = join(project, 'ep02.srt')
    await writeFile(path, srtDocument([{ start: '00:00:01,000', end: '00:00:02,000', text: '台词' }]), 'utf8')
    expect(await readSubtitleCues(path)).toEqual([cue(1, 1, 2, '台词')])
  })
})

describe('buildAssDocument', () => {
  it('writes the fixed header, one Default line per cue, and the single AI-content mark', () => {
    const document = buildAssDocument([cue(1, 1.68, 3.58, '京市户口 单身'), cue(2, 59.999, 60.5, '履历干净 嘴严')], fonts)
    expect(document.startsWith(ASS_DOCUMENT_HEADER)).toBe(true)
    const header = ASS_DOCUMENT_HEADER.split('\n')
    expect(header).toContain('Style: Default,SimHei,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,'
      + '0,0,0,0,100,100,-2,0,1,7,0,2,40,40,520,1')
    expect(document).toContain('Dialogue: 0,0:00:01.68,0:00:03.58,Default,,0,0,0,,京市户口 单身')
    expect(document).toContain('Dialogue: 0,0:00:60.00,0:01:00.50,Default,,0,0,0,,履历干净 嘴严')
    expect(document).toContain(`Dialogue: 1,0:00:00.00,9:59:59.00,Watermark,,0,0,0,,{\\an3\\pos(1025,1810)}${WATERMARK_TEXT}`)
    expect(document.match(/Watermark/g)).toHaveLength(2)
    expect(document.endsWith('\n')).toBe(true)
  })

  it('replaces braces so a cue cannot open an ASS override block', () => {
    expect(buildAssDocument([cue(1, 0, 1, '{\\fs120}放大')], fonts))
      .toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,（\\fs120）放大')
  })

  it('writes only the AI-content mark when the subtitle carries no cue', () => {
    const document = buildAssDocument([], fonts)
    expect(document).toContain('内容由AI生成')
    expect(document).not.toContain('Dialogue: 0,')
  })
})
