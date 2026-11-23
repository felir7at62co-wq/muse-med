/** Independent report templates retain character doubts across ordinary observation updates. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

/** Compare both actual reports before adding their verified bytes to the complete workspace oracle.
 * @param cwd - Isolated runtime workspace.
 * @param scenarioDir - Owner of independent report and workspace expectations.
 * @param log - Actual persisted Session from the shipped headless profile.
 * @returns Temporary expected workspace with only volatile report identities instantiated.
 */
export async function prepareCharacterObservationWorkspace(cwd: string, scenarioDir: string, log: string): Promise<string> {
  const root = join(cwd, '.dsh', 'character-observation-expected')
  await cp(join(scenarioDir, 'workspace.expected'), root, { recursive: true })
  const events = parseSessionLog(log)
  const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
  assert.deepEqual(calls, Array.from({ length: 9 }, () => 'video_source_review'))
  const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  assert(results.every(result => result.isError !== true))
  for (const [callId, template] of [['call_character_last', 'report.initial.expected.json'],
    ['call_character_status', 'report.updated.expected.json']]) {
    const message = results.find(result => result.toolCallId === callId)
    const text = message?.content.find(block => block.type === 'text')
    assert(text?.type === 'text')
    const body = JSON.parse(text.text) as { review_id: string; observation_report: string }
    assert.equal(typeof body.review_id, 'string')
    assert.equal(typeof body.observation_report, 'string')
    const authored = await readFile(join(scenarioDir, template!), 'utf8')
    const expected = JSON.parse(authored.replaceAll('{{id:1}}', body.review_id)) as {
      path: string; frames: { id: string; observation: object }[]
    }
    expected.path = await realpath(join(cwd, 'fixture.mp4'))
    const notes = expected.frames.map(({ id, observation }) => ({ id, observation }))
    const digest = createHash('sha256').update(JSON.stringify(notes)).digest('hex')
    const reportName = `${body.review_id}-${digest}.json`
    assert.equal(await realpath(body.observation_report), await realpath(join(cwd, '.muse', 'video-observations', reportName)))
    const actual = await readFile(body.observation_report, 'utf8')
    assert.deepEqual(JSON.parse(actual), expected)
    const reportDir = join(root, '.muse', 'video-observations')
    await mkdir(reportDir, { recursive: true })
    await writeFile(join(reportDir, reportName), actual)
  }
  return root
}
