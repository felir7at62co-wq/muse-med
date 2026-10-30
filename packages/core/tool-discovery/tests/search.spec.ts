/** Tool discovery ranks current catalog metadata without changing permissions. */
import { describe, expect, it } from 'vitest'
import { ToolSearchIndex } from '../src/search.ts'
import type { ToolSearchDocument } from '../src/search.ts'

const ranking = { k1: 1.2, b: 0.75 }

function document(name: string, description: string, keywords?: string[]): ToolSearchDocument {
  return { name, description, parameters: {}, ...(keywords ? { keywords } : {}) }
}

describe('local tool metadata search', () => {
  it('finds Chinese task words in descriptions and configurable keywords', () => {
    const index = new ToolSearchIndex([
      document('video_inspect', '查看视频中的人物动作与转场', ['抽帧', '镜头变化']),
      document('audio_transcribe', '识别录音中的对白'),
    ], ranking)
    expect(index.search('抽帧', 5).map(match => match.name)).toEqual(['video_inspect'])
    expect(index.search('人物动作', 5)[0]?.name).toBe('video_inspect')
    expect(index.search('对白', 5).map(match => match.name)).toEqual(['audio_transcribe'])
  })

  it('prioritizes an exact normalized name over descriptions that repeat it', () => {
    const index = new ToolSearchIndex([
      document('mcp__media__read-frame', 'Reads one image'),
      document('other', 'mcp__media__read-frame '.repeat(20)),
    ], ranking)
    const matches = index.search('  MCP__MEDIA__READ-FRAME  ', 2)
    expect(matches.map(match => match.name)).toEqual(['mcp__media__read-frame', 'other'])
    expect(matches.every(match => Number.isFinite(match.score) && match.score > 0)).toBe(true)
  })

  it('prioritizes a tool named inside a longer request over repeated description matches', () => {
    const index = new ToolSearchIndex([
      document('mcp__media__read-frame', 'Read an image'),
      document('other', 'mcp__media__read-frame '.repeat(20)),
    ], ranking)
    expect(index.search('请使用 MCP__MEDIA__READ-FRAME 查看人物', 1)[0]?.name).toBe('mcp__media__read-frame')
    expect(index.search('Use mcp__media__read-frame, please', 1)[0]?.name).toBe('mcp__media__read-frame')
  })

  it('prioritizes configured Chinese and English aliases inside task requests', () => {
    const index = new ToolSearchIndex([
      document('frame_reader', 'Review pictures', ['原图核对', 'frame lookup']),
      document('other', `${'原图核对 '.repeat(20)}${'frame lookup '.repeat(20)}`),
    ], ranking)
    expect(index.search('帮我做一次原图核对看看人物动作', 1)[0]?.name).toBe('frame_reader')
    expect(index.search('Please run FRAME LOOKUP for this scene', 1)[0]?.name).toBe('frame_reader')
  })

  it('does not treat a tool-name substring as an explicit name mention', () => {
    const index = new ToolSearchIndex([
      document('read', 'Other text'), document('read_source', 'Load saved text'),
      document('reader', 'Load more text'),
    ], ranking)
    expect(index.search('Use read_source now', 1)[0]?.name).toBe('read_source')
    expect(index.search('Use reader now', 1)[0]?.name).toBe('reader')
    expect(index.explicitNames('Use read_source now')).toEqual(['read_source'])
    expect(index.explicitNames('saved text')).toEqual([])
  })

  it('matches identifier fragments and fullwidth query text', () => {
    const index = new ToolSearchIndex([
      document('video_inspect', 'Review pictures'),
      document('searchFiles', 'Find project paths'),
    ], ranking)
    expect(index.search('inspect', 5).map(match => match.name)).toEqual(['video_inspect'])
    expect(index.search('files', 5).map(match => match.name)).toEqual(['searchFiles'])
    expect(index.search('ｖｉｄｅｏ＿ｉｎｓｐｅｃｔ', 5)[0]?.name).toBe('video_inspect')
  })

  it('indexes nested argument names, descriptions, titles and string enums', () => {
    const index = new ToolSearchIndex([
      { name: 'inspect', description: 'Inspect media', parameters: {
        type: 'object', properties: { source_path: { type: 'string', description: '原始视频位置' },
          mode: { oneOf: [{ title: '镜头分析', type: 'string', enum: ['scene_scan', 4] }, null] } },
      } },
      document('write', 'Save a document'),
    ], ranking)
    for (const query of ['source_path', '视频位置', '镜头分析', 'scene_scan']) {
      expect(index.search(query, 5).map(match => match.name)).toEqual(['inspect'])
    }
  })

  it('ranks a focused description above a long description with the same match', () => {
    const index = new ToolSearchIndex([
      document('focused', 'camera'),
      document('verbose', `camera ${'unrelated '.repeat(50)}`),
    ], ranking)
    const matches = index.search('camera', 2)
    expect(matches.map(match => match.name)).toEqual(['focused', 'verbose'])
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0)
  })

  it('uses name order for equal scores and respects a result limit', () => {
    const index = new ToolSearchIndex([
      document('b', 'camera'), document('a', 'camera'), document('c', 'camera'),
    ], ranking)
    expect(index.search('camera', 2).map(match => match.name)).toEqual(['a', 'b'])
    expect(index.search('camera', 20)).toHaveLength(3)
    expect(index.search('camera', 0)).toEqual([])
    expect(index.search('camera', -1)).toEqual([])
  })

  it('returns no unrelated fallback and can be searched repeatedly without state changes', () => {
    const index = new ToolSearchIndex([document('read', 'Read source files')], ranking)
    expect(index.search('火星天气', 5)).toEqual([])
    expect(index.search(' ', 5)).toEqual([])
    expect(index.search('!!!', 5)).toEqual([])
    expect(index.search('source', 5)).toEqual(index.search('source', 5))
    expect(new ToolSearchIndex([], ranking).search('source', 5)).toEqual([])
  })

  it('can find a punctuation-only exact name without dividing by an empty document length', () => {
    const index = new ToolSearchIndex([document('---', '')], ranking)
    expect(index.search('---', 1)).toEqual([{ name: '---', score: 0 }])
  })
})
