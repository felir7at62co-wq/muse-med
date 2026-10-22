/** Validate real subtitle artifacts before projecting platform-neutral report paths. */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {object} report - Result of the real subtitle tool for this scenario's aligned lines.
 * @param {string} cwd - Scenario-owned workspace.
 * @returns {Promise<object>} The complete report with only its path fields projected.
 */
export async function projectSubtitleFixtureReport(report, cwd) {
  const srt = join(cwd, 'result.srt')
  const review = `${srt}.review.txt`
  assert.equal(report.method, 'subtitles')
  assert.equal(report.summary.failed_checks, 0)
  assert.equal(report.project, cwd)
  assert.equal(report.clips[0].source, join(cwd, 'media.mp4'))
  assert.deepEqual(report.written, [srt, review])
  assert.ok((await stat(srt)).isFile(), 'the selected SRT was written')
  assert.equal(await readFile(srt, 'utf8'),
    '1\n00:00:00,100 --> 00:00:00,300\n甲\n\n2\n00:00:00,500 --> 00:00:00,700\n乙\n')
  assert.equal(await readFile(review, 'utf8'), '', 'aligned fixture lines have no review defects')
  assert.ok(report.warnings.some(warning => warning.includes('visual_medium')), 'legacy delivery warning remains visible')
  assert.equal(report.ok, true, 'the subtitle report remains usable')
  assert.deepEqual(report.failures, [], 'the subtitle report has no failures')
  assert.deepEqual(report.checks, [], 'aligned fixture has no subtitle check defects')
  const slash = value => value.split('\\').join('/')
  return {
    ...report,
    project: slash(report.project),
    clips: report.clips.map(clip => ({ ...clip, source: slash(clip.source) })),
    written: report.written.map(slash),
  }
}
