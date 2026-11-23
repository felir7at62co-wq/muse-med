/** Check real report bytes and retained character notes without judging a synthetic face. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const name = 'character-report-proof'

/** @param {import('@deepseek-ai/cordis').Context} ctx - isolated recorded-session Host. */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    assert(messages.every(message => message.isError !== true), 'Every actual observation tool call succeeds')
    const body = messages.filter(message => message.toolCallId === 'call_character_status').flatMap(message =>
      message.content.filter(block => block.type === 'text').map(block => JSON.parse(block.text))).at(-1)
    assert(body && body.complete === true && body.pending === 0, 'The final actual tool result has a complete observation report')
    assert.equal(typeof body.observation_report, 'string')
    const bytes = readFileSync(body.observation_report)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), body.observation_report_sha256)
    const report = JSON.parse(bytes.toString('utf8'))
    assert.equal(report.id, body.review_id)
    assert.equal(resolve(report.path), resolve('fixture.mp4'))
    assert.equal(report.source_version, body.source_version)
    assert.equal(report.frames.length, 5)
    const marked = report.frames.find(frame => frame.id === 'F00001')
    assert(marked?.observation, 'The report retains the reviewed first frame')
    const unmarked = report.frames.filter(frame => frame.id !== 'F00001')
    assert(unmarked.every(frame => frame.observation && frame.observation.character_checks === undefined),
      'Ordinary observations do not acquire a character verdict')
    const proof = {
      source_sha256: createHash('sha256').update(readFileSync('fixture.mp4')).digest('hex'),
      real_report_digest_verified: true,
      complete_observation: body.complete,
      frame_count: report.frames.length,
      retained_character_checks: marked.observation.character_checks,
      ordinary_observation_count: unmarked.length,
      actual_observation_tool_results: messages.length,
    }
    writeFileSync(join(process.cwd(), 'character-report-proof.json'), JSON.stringify(proof, null, 2) + '\n')
  })
}
