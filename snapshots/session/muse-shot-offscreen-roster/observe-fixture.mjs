/** Observe the production compiler; never replace its result or verdict. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const name = 'offscreen-roster-observer'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const roster = '林岚 @[林岚](lead)'
const expectedText = ['设备已经打开。', '先想一想。', '我扶着推车。']
const expectedSourceHash = '36e52bf7b8e61b8a230f333c8294c64a4fae5235d4cdbfbed324fe1988cdcfed'
const expectedAssetHash = '074441fc27ec48b99deb06e4a4d33cc7add9b70490947e4d813145a25267089f'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Ordinary Loader context. */
export async function apply(ctx) {
  const cwd = process.cwd(), scriptPath = join(cwd, 'shots.txt'), assetPath = join(cwd, 'assets_manifest.json')
  const source = await readFile(scriptPath), assets = await readFile(assetPath)
  assert.equal(hash(source), expectedSourceHash)
  assert.equal(hash(assets), expectedAssetHash)
  let report, calls = 0, seen = false
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'drama_shot') return decision
    assert.equal(++calls, 1)
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content, undefined)
    assert.equal(result.isError, false, JSON.stringify(result.content))
    report = JSON.parse(result.content[0].text)
    assert.equal(report.ok, true)
    assert.equal(report.review_mode, 'advisory')
    assert.deepEqual(report.failures, [])
    const findings = report.warnings.filter(issue => issue.code === 'offscreen_character_listed')
    assert.deepEqual(findings.map(issue => [issue.severity, issue.shot, issue.line]), [['warning', 1, 9]])
    assert.deepEqual(report.shots.map(shot => shot.characters_field), [roster, roster, roster])
    assert.deepEqual(report.shots.map(shot => shot.voice_type), ['vo', 'vo', 'vo'])
    assert.deepEqual(report.shots.map(shot => shot.speaker), ['林岚', '林岚', '林岚'])
    assert.deepEqual(report.shots.map(shot => shot.text), expectedText)
    for (const shot of report.shots) {
      assert.deepEqual(shot.bindings.filter(asset => asset.type === '角色').map(asset => [asset.name, asset.material_id]), [['林岚', '81001']])
    }
    const prompt = report.packages.map(item => item.prompt).join('\n')
    for (const fragment of ['出镜人物：' + roster,
      '【林岚】-位置：【画外，推车继续前移，设备随车轻微震动】；',
      '【林岚】-位置：【房间内，面向画外】；', '【林岚】-位置：【画外（可见手部）】；',
      '发声类型：vo', ...expectedText]) assert.ok(prompt.includes(fragment), fragment)
    assert.deepEqual(await readFile(scriptPath), source)
    assert.deepEqual(await readFile(assetPath), assets)
    const directory = join(cwd, '.dsh/os-project/shot_reviews/01')
    assert.deepEqual(await readFile(join(directory, 'shot_script.txt')), source)
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')), report)
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_os_review')
    if (result !== undefined) {
      assert.equal(seen, false)
      assert.ok(report)
      assert.deepEqual(JSON.parse(result.content[0].text), report)
      seen = true
      const findings = report.warnings.filter(issue => issue.code === 'offscreen_character_listed')
      await writeFile(join(cwd, 'offscreen-roster-proof.json'), JSON.stringify({
        source_sha256: hash(await readFile(scriptPath)), assets_sha256: hash(await readFile(assetPath)),
        warning_shots: findings.map(issue => issue.shot), warning_lines: findings.map(issue => issue.line),
        unchanged_rosters: report.shots.map(shot => shot.characters_field),
        voice_types: report.shots.map(shot => shot.voice_type), speakers: report.shots.map(shot => shot.speaker),
        texts: report.shots.map(shot => shot.text),
        material_ids: report.shots.map(shot => shot.bindings.find(asset => asset.type === '角色').material_id),
        source_bytes_preserved: true, advisory_source_copy_preserved: true, saved_report_matches_actual: true,
        full_report_observed_in_next_model_request: true,
      }, null, 2) + '\n', { flag: 'wx' })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(calls, 1); assert.equal(seen, true) })
}
