/** Read the current episode and stage its candidate through the Muse gateway with no draft overwrite. */
import assert from 'node:assert/strict'
import { inject, mountWorkshopFixture } from '../muse-workshop-transcribe-status/workshop-fixture.mjs'

export { inject }

/** Cordis fixture name. */
export const name = 'workshop-script-editor'

const BASE_REVISION = 'a'.repeat(64)
const DRAFT_REVISION = 'b'.repeat(64)
const CANDIDATE = 'fe3dfd4b-8300-4fa5-8a8b-8b4cdb1b3521'
const CURRENT = '林晚走到柜前，打开账本。'
const PROPOSED = '脚步声逼近。林晚等门外安静下来，才翻开压在柜底的账本。'
const SUMMARY = '压缩动作并保留发现账本。'
const DRAFT_PATH = '/jubengongfang/v1/script-editor/drafts/12'
const EPISODE_PATH = DRAFT_PATH + '/episodes/2'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
  const calls = await mountWorkshopFixture(ctx, {
    scenario: name, tool: 'workshop_script_editor', keyword: '精修剧本',
    routes: {
      ['GET ' + DRAFT_PATH]: { name: 'draft', response: {
        id: 12, title: '雨巷', status: 'draft', episodeCount: 2, updatedAt: '2026-11-22T09:00:00Z',
        context: { outline: { synopsis: '林晚追查账本。' }, storyBible: null },
        episodes: [{ episode: 1, title: '回家' }, { episode: 2, title: '查账' }], canFinalize: true, revision: DRAFT_REVISION,
      } },
      ['GET ' + EPISODE_PATH]: { name: 'episode', response: {
        draftId: 12, episode: 2, title: '查账', revision: BASE_REVISION, version: 2, content: CURRENT, candidate: null,
      } },
      ['POST ' + EPISODE_PATH + '/candidates']: {
        name: 'candidate',
        body: { baseRevision: BASE_REVISION, content: PROPOSED, summary: SUMMARY },
        response: { id: CANDIDATE, baseRevision: BASE_REVISION, content: PROPOSED, summary: SUMMARY, createdAt: '2026-11-22T09:20:00Z' },
      },
    },
  })
  let modelSawCandidate = false
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === 'workshop_script_editor'), 'The short-drama preset registers the editor tool')
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'workshop-propose')
    if (result) {
      assert.equal(result.isError, false, JSON.stringify(result.content))
      const receipt = JSON.parse(result.content.find(item => item.type === 'text').text)
      assert.equal(receipt.candidate_id, CANDIDATE)
      assert.equal(receipt.status, 'pending_review')
      assert.equal(receipt.episode, 2)
      assert.equal(receipt.base_revision, BASE_REVISION)
      assert.ok(!('content' in receipt))
      modelSawCandidate = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => {
    assert.deepEqual(calls, ['me', 'draft', 'episode', 'candidate'])
    assert.ok(modelSawCandidate)
  })
}
