/** Scene time reaches every submitted shot without advancing at camera or package cuts. */
import { describe, expect, it } from 'vitest'
import { packEpisode, prepareShotPrompts } from '../src/episode.ts'
import { parseShotScript } from '../src/script.ts'
import { actionShot, scriptOf } from './harness.ts'
import type { CompiledShot } from '../src/types.ts'

const shot = (number: number, fields: string[] = []): string => actionShot(number, ['核心场景：山坡', ...fields])
const parse = (source: string) => parseShotScript(source, { actionShotSeconds: 2 })
function compiled(source: string): CompiledShot[] {
  return parse(source).shots.map(item => ({ shot: item, characters: [], scene: item.sceneField,
    props: [], assets: [], start: 0, end: item.durationSeconds }))
}

describe('scene time before first generation', () => {
  it('carries dusk into every later shot and independent package without mutating source rows', () => {
    const source = scriptOf(shot(1, ['连续性场次：17-2', '场景时段：傍晚', '子任务边界：是']), shot(2), shot(3))
    const shots = compiled(source)
    const before = shots.map(item => item.shot.visual)
    const packs = packEpisode(shots, 15)
    expect(packs).toHaveLength(2)
    expect(packs[1]?.prompt.match(/时段连续性：傍晚/gu)).toHaveLength(2)
    expect(packs[1]?.prompt).toContain('切镜及分包不推进剧情时间')
    expect(shots.map(item => item.shot.visual)).toEqual(before)
  })

  it('uses only source headings and dedicated fields rather than speech mentions', () => {
    const source = ['场次5-1：内殿 夜 内', shot(1), shot(2)].join('\n')
    expect(packEpisode(compiled(source), 15)[0]?.prompt).toContain('时段连续性：夜')
    const mentioned = shot(1, ['台词：甲：昨天傍晚我来过。', '发声类型：dialogue'])
    expect(packEpisode(compiled(mentioned), 15)[0]?.prompt).not.toContain('时段连续性：')
  })

  it('reports an unexplained same-period return to daylight and splits the time change', () => {
    const source = scriptOf(shot(1, ['连续性场次：17-2', '场景时段：傍晚']), shot(2, ['场景时段：白天']))
    expect(parse(source).issues).toContainEqual(expect.objectContaining({ code: 'scene_time_change_unexplained', shot: 2 }))
    expect(packEpisode(compiled(source), 15).map(pack => pack.shots)).toEqual([[1], [2]])
  })

  it('permits an explicitly based montage change and keeps the following time stable', () => {
    const source = '场次2-1：山坡 日 外\n' + scriptOf(shot(1, ['连续性场次：2-1', '场景时段：第二日白天']),
      shot(2, ['场景时段：第三天天未亮', '时段变化依据：原文第三天天没亮，他就扛锄出门']), shot(3))
    expect(parse(source).issues.some(issue => issue.code === 'scene_time_change_unexplained')).toBe(false)
    const packs = packEpisode(compiled(source), 15)
    expect(packs[1]?.prompt.match(/时段连续性：第三天天未亮/gu)).toHaveLength(2)
  })

  it('preserves package shot identities without accepting gaps or duplicate numbering', () => {
    const source = scriptOf(shot(15, ['场景时段：傍晚']), shot(16))
    const options = { actionShotSeconds: 2, sourceScope: 'prepared_package' as const }
    expect(parseShotScript(source, options).issues.some(issue => issue.code === 'shot_numbering')).toBe(false)
    expect(parseShotScript(source.replace('【镜头16】', '【镜头18】'), options).issues)
      .toContainEqual(expect.objectContaining({ code: 'shot_numbering' }))
    expect(parseShotScript(source.replace('【镜头16】', '【镜头15】'), options).issues)
      .toContainEqual(expect.objectContaining({ code: 'shot_numbering' }))
    expect(parseShotScript(scriptOf(shot(0), shot(1)), options).issues)
      .toContainEqual(expect.objectContaining({ code: 'shot_numbering' }))
    expect(parse(source).issues).toContainEqual(expect.objectContaining({ code: 'shot_numbering' }))
  })

  it('keeps separate source periods independent when returning to an established location', () => {
    const source = scriptOf(shot(1, ['连续性场次：8-1', '场景时段：白天']),
      shot(2, ['连续性场次：8-2', '场景时段：深夜']), shot(3, ['连续性场次：8-1']))
    const packs = packEpisode(compiled(source), 15)
    expect(parse(source).issues.some(issue => issue.code === 'scene_time_change_unexplained')).toBe(false)
    expect(packs[2]?.prompt).toContain('时段连续性：白天')
    expect(packs[2]?.prompt).not.toContain('时段连续性：深夜')
  })

  it.each([['场景时段：'], ['场景时段：待定'], ['场景时段：夜', '场景时段：日'],
    ['时段变化依据：原文次日'], ['场景时段：夜', '时段变化依据：同上']].map(fields => ({ fields })))('rejects malformed time declarations $fields', ({ fields }) => {
    expect(parse(shot(1, fields)).issues).toContainEqual(expect.objectContaining({ code: 'scene_time_declaration_invalid', severity: 'failure' }))
  })

  it('replaces derived time context during repeated prompt completion', () => {
    const initial = compiled(scriptOf(shot(1, ['场景时段：傍晚']), shot(2)))
    const once = prepareShotPrompts(initial)
    expect(prepareShotPrompts(once).map(item => item.shot.visual)).toEqual(once.map(item => item.shot.visual))
    const changed = once.map(item => ({ ...item, shot: { ...item.shot, visual: item.shot.visual.replace('场景时段：傍晚', '场景时段：清晨') } }))
    expect(prepareShotPrompts(changed)[1]?.shot.visual).toContain('时段连续性：清晨')
    expect(prepareShotPrompts(changed)[1]?.shot.visual).not.toContain('时段连续性：傍晚')
  })
})
