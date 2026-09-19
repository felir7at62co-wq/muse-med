/** The episode timeline: reading, selecting, laying out, and serializing. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendClips,
  bodyEndSecondsOf,
  formatTimelineDocument,
  parseTimelineDocument,
  readTimeline,
  selectBodyClips,
} from '../src/timeline.ts'
import type { Timeline } from '../src/types.ts'
import { cleanup, tempProject, timelineJson } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** A timeline with the three clips every selection test uses. */
function timeline(): Timeline {
  return appendClips([5_000_000, 13_083_333, 14_066_667])
}

describe('parseTimelineDocument', () => {
  it('reads clips and derives the body end from the furthest clip end', () => {
    const parsed = parseTimelineDocument({
      clips: [
        { shot: 1, start_us: 0, duration_us: 5_050_000 },
        { shot: 2, start_us: 5_050_000, duration_us: 13_083_333 },
      ],
      body_end: 1,
    }, 'timeline.json')
    expect(parsed.clips).toEqual([
      { shot: 1, startUs: 0, durationUs: 5_050_000 },
      { shot: 2, startUs: 5_050_000, durationUs: 13_083_333 },
    ])
    expect(parsed.bodyEndSeconds).toBe(18.133333)
  })

  it('rejects a document without a clips array', () => {
    expect(() => parseTimelineDocument({ body_end: 12 }, 't.json')).toThrow('时间线必须是')
  })

  it('rejects a non-object document', () => {
    expect(() => parseTimelineDocument(null, 't.json')).toThrow('时间线必须是')
  })

  it('rejects a clip that is not an object', () => {
    expect(() => parseTimelineDocument({ clips: [3] }, 't.json')).toThrow('不是对象')
  })

  it('rejects a clip whose shot is not an integer', () => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1.5, start_us: 0, duration_us: 1 }] }, 't.json'))
      .toThrow('必须是非负整数微秒')
  })

  it('rejects a clip whose duration is missing', () => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1, start_us: 0 }] }, 't.json'))
      .toThrow('duration_us 必须是非负整数微秒')
  })

  it('rejects shot number zero', () => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 0, start_us: 0, duration_us: 1 }] }, 't.json'))
      .toThrow('shot 必须从 1 开始')
  })

  it('rejects an empty clip list', () => {
    expect(() => parseTimelineDocument({ clips: [] }, 't.json')).toThrow('没有任何 clip')
  })

  it('rejects a zero-length clip', () => {
    expect(() => parseTimelineDocument({ clips: [{ shot: 1, start_us: 0, duration_us: 0 }] }, 't.json'))
      .toThrow('duration_us 是 0')
  })
})

describe('readTimeline', () => {
  it('reads a timeline file, tolerating a byte-order mark', async () => {
    const project = await tempProject()
    temporary.push(project)
    const path = join(project, 'timeline.json')
    await writeFile(path, `\ufeff${timelineJson([{ shot: 1, startUs: 0, durationUs: 1_000_000 }], 1)}`, 'utf8')
    const parsed = await readTimeline(path)
    expect(parsed.clips).toHaveLength(1)
    expect(parsed.bodyEndSeconds).toBe(1)
  })

  it('fails loud when the file is not JSON', async () => {
    const project = await tempProject()
    temporary.push(project)
    const path = join(project, 'timeline.json')
    await writeFile(path, 'not json', 'utf8')
    await expect(readTimeline(path)).rejects.toThrow('时间线不是合法 JSON')
  })

  it('fails loud when the file does not exist', async () => {
    await expect(readTimeline(join(await tempProject(), 'missing.json'))).rejects.toThrow()
  })
})

describe('bodyEndSecondsOf', () => {
  it('takes the furthest clip end rather than the last row', () => {
    expect(bodyEndSecondsOf([
      { shot: 1, startUs: 20_000_000, durationUs: 5_000_000 },
      { shot: 2, startUs: 0, durationUs: 1_000_000 },
    ])).toBe(25)
  })

  it('reports zero for no clips', () => {
    expect(bodyEndSecondsOf([])).toBe(0)
  })
})

describe('selectBodyClips', () => {
  it('keeps the clips up to the last delivered shot', () => {
    expect(selectBodyClips(timeline(), 2).map(clip => clip.shot)).toEqual([1, 2])
  })

  it('fails loud when the timeline does not hold exactly that many clips', () => {
    expect(() => selectBodyClips(timeline(), 9)).toThrow('应为 9 个')
  })
})

describe('appendClips', () => {
  it('accumulates each start from the clip durations', () => {
    expect(timeline()).toEqual({
      clips: [
        { shot: 1, startUs: 0, durationUs: 5_000_000 },
        { shot: 2, startUs: 5_000_000, durationUs: 13_083_333 },
        { shot: 3, startUs: 18_083_333, durationUs: 14_066_667 },
      ],
      bodyEndSeconds: 32.15,
    })
  })
})

describe('formatTimelineDocument', () => {
  it('writes the pipeline spelling of every field', async () => {
    const project = await tempProject()
    temporary.push(project)
    const path = join(project, 'timeline.json')
    await writeFile(path, formatTimelineDocument(timeline()), 'utf8')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      clips: [
        { shot: 1, start_us: 0, duration_us: 5_000_000 },
        { shot: 2, start_us: 5_000_000, duration_us: 13_083_333 },
        { shot: 3, start_us: 18_083_333, duration_us: 14_066_667 },
      ],
      body_end: 32.15,
    })
  })
})
