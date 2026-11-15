/** Explicit offscreen positions produce advice without changing voice or visible character declarations. */
import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseShotScript } from '../src/script.ts'
import { declaredCharacters, offscreenCharacterIssues } from '../src/visibility.ts'
import { cleanup, tempDir } from './harness.ts'
import { registeredShot } from './fixtures/registered-shot.ts'

const equivalentRadioInsert = [
  '真人短剧写实风格', '【镜头1】', '出镜人物：林岚', '主体状态追踪：',
  '【林岚】-位置：【画外，推车继续前移，设备随车轻微震动】；',
  '动作状态：【推车继续前移，贴在车边的设备传出声音】；',
  '手部状态：【画外，双手扶着推车】；', '发声类型：action',
  '无噪点，无跳帧，五官稳定不变形',
].join('\n')

it('advises about the synthetic equivalent of a wholly offscreen subject on a close-up visible roster', () => {
  const result = parseShotScript(equivalentRadioInsert, { actionShotSeconds: 2 })
  expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'warning',
    code: 'offscreen_character_listed', shot: 1, line: 5 }))
  expect(result.shots[0]).toMatchObject({ voiceType: 'action', charactersField: '林岚' })
  expect(result.shots[0]?.visual).toContain('【林岚】-位置：【画外，推车继续前移，设备随车轻微震动】；')
})

it('preserves list parsing with costume commas, both parenthesis forms and empty separators', () => {
  expect(declaredCharacters(' 林岚（白衬衫，长发）、林岚子(成年;深色外套) ,; /|｜\n 许远；'))
    .toEqual(['林岚（白衬衫，长发）', '林岚子(成年;深色外套)', '许远'])
  expect(declaredCharacters('')).toEqual([])
  expect(declaredCharacters('林岚）')).toEqual(['林岚）'])
})

it.each(['画外', '画外声音来源，门后', '画外声源：门后', '已在画外', '始终位于画外', '全程画外（已离场）'])
('advises for an unqualified whole-subject position %s', (position) => {
  const block = `【林岚】-位置：【${position}】；`
  expect(offscreenCharacterIssues(block, '林岚（白衬衫，长发）', 7, 30))
    .toEqual([expect.objectContaining({ severity: 'warning', code: 'offscreen_character_listed', shot: 7, line: 30 })])
})

it.each([
  { name: 'an interior position facing offscreen', position: '房间内，面向画外', extra: '四层朝向链：【看向画外声音来源】；' },
  { name: 'an offscreen hand in a visible face close-up', position: '房间内，面部入画', extra: '手部状态：【画外】；' },
  { name: 'a doorway outside the room', position: '门外', extra: '' },
  { name: 'an entrance later in the shot', position: '画外，随后入画', extra: '' },
  { name: 'a staged entrance in the action field', position: '画外', extra: '动作状态：【先在画外，随后走入镜头】；' },
  { name: 'a staged exit after appearing', position: '房间内，随后离开画面', extra: '动作状态：【先转头，随后走出画面】；' },
  { name: 'a camera revealing the subject later', position: '画外', extra: '运镜：随后向右摇摄，人物入画' },
  { name: 'a visible part of an otherwise offscreen subject', position: '画外，手臂留在画内', extra: '' },
  { name: 'explicit partial visibility', position: '画外（可见手部）', extra: '' },
  { name: 'uncertain source placement', position: '画外，位置待确认', extra: '' },
  { name: 'an empty position', position: '', extra: '' },
])('does not infer a contradiction for $name', ({ position, extra }) => {
  const block = `【林岚】-位置：【${position}】；\n${extra}`
  expect(offscreenCharacterIssues(block, '林岚', 1, 1)).toEqual([])
})

it('allows a visible character to have an inner vo line without changing either field', () => {
  const text = equivalentRadioInsert.replace('画外，推车继续前移，设备随车轻微震动', '房间内，面向画外')
    .replace('发声类型：action', '说话人：林岚\n台词：林岚：先想一想。\n发声类型：vo\n发声说明：林岚的内心声音，仅配音。')
  const parsed = parseShotScript(text, { actionShotSeconds: 2 })
  expect(parsed.issues.filter(issue => issue.code === 'offscreen_character_listed')).toEqual([])
  expect(parsed.shots[0]).toMatchObject({ voiceType: 'vo', speaker: '林岚', text: '先想一想。', charactersField: '林岚' })
})

it('requires an exact declared subject and does not use dialogue as staging', () => {
  const block = '【林岚】-位置：画外\n台词：林岚：随后入画。\n【许远】-位置：【屋内】；'
  expect(offscreenCharacterIssues(block, '', 1, 1)).toEqual([])
  expect(offscreenCharacterIssues(block, '林', 1, 1)).toEqual([])
  expect(offscreenCharacterIssues('只有台词提及画外。', '林岚', 1, 1)).toEqual([])
  expect(offscreenCharacterIssues(block, '林岚、许远', 1, 1))
    .toEqual([expect.objectContaining({ code: 'offscreen_character_listed', line: 1 })])
  expect(offscreenCharacterIssues('【林岚】-位置：【画外】；\n【林岚】-位置：【房间内】；', '林岚', 1, 1)).toEqual([])
})

it('returns the warning through the Loader and persists the advisory draft without rewriting its fields', async () => {
  const root = await tempDir(), owner = await registeredShot(root, { reviewMode: 'advisory' })
  try {
    await writeFile(join(root, 'director.txt'), equivalentRadioInsert)
    await writeFile(join(root, 'assets.json'), '{"assets":[]}')
    const report = await owner.report({ method: 'compile', script: join(root, 'director.txt'),
      project: root, assets: join(root, 'assets.json'), episode: 1, max_submit_seconds: 15 })
    expect(report).toMatchObject({ ok: true, failures: [], review_mode: 'advisory' })
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'offscreen_character_listed', line: 5 }))
    expect(report.shots[0]).toMatchObject({ characters_field: '林岚', voice_type: 'action' })
    expect(report.packages[0]?.prompt).toContain('出镜人物：林岚')
    expect(report.packages[0]?.prompt).toContain('【林岚】-位置：【画外，推车继续前移，设备随车轻微震动】；')
    expect(await readFile(join(root, 'shot_reviews/01/shot_script.txt'), 'utf8')).toBe(equivalentRadioInsert)
    const saved: unknown = JSON.parse(await readFile(join(root, 'shot_reviews/01/review.json'), 'utf8'))
    expect(saved).toHaveProperty('warnings', expect.arrayContaining([expect.objectContaining({ code: 'offscreen_character_listed' })]))
  } finally { await owner.dispose(); await cleanup(root) }
})

it('keeps the same warning nonblocking in strict validation without requiring an asset manifest', async () => {
  const root = await tempDir(), owner = await registeredShot(root, { reviewMode: 'strict' })
  try {
    await writeFile(join(root, 'director.txt'), equivalentRadioInsert)
    const report = await owner.report({ method: 'validate', script: join(root, 'director.txt') })
    expect(report).toMatchObject({ ok: true, failures: [] })
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'offscreen_character_listed', severity: 'warning' }))
  } finally { await owner.dispose(); await cleanup(root) }
})

it('retains current inline-reference labels for warnings without duplicating asset identities', () => {
  const roster = '林岚 @[林岚](actor-1)、许远 @[许远](actor-2)'
  expect(declaredCharacters(roster)).toEqual(['林岚', '许远'])
  expect(offscreenCharacterIssues('【林岚】-位置：【画外】；', roster, 1, 1))
    .toEqual([expect.objectContaining({ code: 'offscreen_character_listed', severity: 'warning' })])
})
