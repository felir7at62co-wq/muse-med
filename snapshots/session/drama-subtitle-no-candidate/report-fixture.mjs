/** Check actual subtitle preservation before projecting only platform-specific paths. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'subtitle-no-candidate-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Real subtitle scenario composition. */
export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'call_subtitle_no_candidate' || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false)
    const report = JSON.parse(result.content[0].text)
    const cwd = process.cwd()
    const srt = join(cwd, 'result.srt')
    const candidate = `${srt}.draft.srt`
    const review = `${srt}.review.txt`
    assert.equal(report.project, cwd)
    assert.equal(report.clips[0].source, join(cwd, 'media.mp4'))
    assert.deepEqual(report.written, [review], 'an attempt with no cues writes only its current review')
    assert.equal(await readFile(srt, 'utf8'), '1\n00:00:00,100 --> 00:00:00,300\n旧字幕\n')
    assert.equal(await readFile(candidate, 'utf8'), '1\n00:00:00,200 --> 00:00:00,400\n旧候选\n')
    assert.equal(await readFile(`${candidate}.review.txt`, 'utf8'), '旧候选的核听说明。\n')
    assert.ok((await readFile(review, 'utf8')).includes('未生成字幕候选'))
    assert.ok(report.warnings.some(warning => warning.includes('未生成字幕候选')))
    assert.equal(report.ok, true, 'alignment findings remain advisory')
    assert.deepEqual(report.failures, [])
    assert.equal(report.checks.length, 1)
    assert.equal(report.checks[0].id, 'subtitle_line_coverage')
    assert.equal(report.checks[0].severity, 'warning')
    assert.equal(report.checks[0].ok, false)
    assert.ok(report.checks[0].detail.includes('文档没有标 strategy'))
    const slash = value => value.split('\\').join('/')
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify({
      ...report,
      project: slash(report.project),
      clips: report.clips.map(clip => ({ ...clip, source: slash(clip.source) })),
      written: report.written.map(slash),
    }, null, 2) }] }
  })
}
