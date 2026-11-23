import { expect, it } from 'vitest'
import WorkshopConnection from '../src/index.ts'
import { host, workbench } from './fixture.ts'

const baseRevision = 'a'.repeat(64)
const root = '/v1/script-editor/drafts/12/episodes/4'
const manuscript = { draftId: 12, episode: 4, title: '账本', content: '女主拿起账本。', revision: baseRevision, version: 2, candidate: null }
const candidate = { id: 'eac95b74-244e-4af2-ab4c-03a041ca212c', content: '女主从抽屉里翻出账本。', baseRevision, summary: '补出发现账本的动作。', createdAt: '2026-11-22T00:00:00Z' }

it('sends the base revision and exact episode when staging a candidate and preserves the Workshop conflict', async () => {
  const { origin, requests } = await workbench((req) => {
    switch (req.url) {
      case '/v1/auth/muse/challenge': return [200, { requestId: 'fixture', challenge: 'c'.repeat(43) }]
      case '/v1/auth/muse/exchange': return [200, { access_token: 'fixture-token', user: { id: 41 } }]
      case root: return [200, manuscript]
      case root + '/candidates': return [200, candidate]
      case root + '/apply': return [409, { detail: { code: 'SCRIPT_EDITOR_VERSION_CHANGED', message: '第 4 集已有更新。' } }]
      default: return [404, {}]
    }
  })
  const { ctx } = await host()
  await ctx.plugin(WorkshopConnection, { workshopOrigin: origin }).await()
  const api = ctx.workshopConnection
  const target = { draftId: 12, episode: 4 }
  expect(await api.scriptDraftEpisode(target)).toEqual(manuscript)
  const proposed = await api.stageScriptDraftCandidate({ ...target, baseRevision, content: candidate.content, summary: candidate.summary })
  expect(proposed).toEqual(candidate)
  await expect(api.applyScriptDraftCandidate({ ...target, candidateId: proposed.id })).rejects.toMatchObject({
    status: 409, code: 'SCRIPT_EDITOR_VERSION_CHANGED',
  })
  expect(requests.slice(2).map(row => [row.method, row.url, row.authorization, row.body ? JSON.parse(row.body) : null])).toEqual([
    ['GET', root, 'Bearer fixture-token', null],
    ['POST', root + '/candidates', 'Bearer fixture-token', { baseRevision, content: proposed.content, summary: proposed.summary }],
    ['POST', root + '/apply', 'Bearer fixture-token', { candidateId: candidate.id }],
  ])
})

it('rejects an episode reply containing a different draft or episode', async () => {
  const { origin } = await workbench((req) => {
    if (req.url === '/v1/auth/muse/challenge') return [200, { requestId: 'fixture', challenge: 'c'.repeat(43) }]
    if (req.url === '/v1/auth/muse/exchange') return [200, { access_token: 'fixture-token', user: { id: 41 } }]
    return [200, { ...manuscript, episode: 3 }]
  })
  const { ctx } = await host()
  await ctx.plugin(WorkshopConnection, { workshopOrigin: origin }).await()
  await expect(ctx.workshopConnection.scriptDraftEpisode({ draftId: 12, episode: 4 })).rejects.toMatchObject({
    code: 'WORKSHOP_EDITOR_INVALID_RESULT',
  })
})

it('uses the signed-in Workshop for structured editing, history restore and document export', async () => {
  const board = { draftId: 12, episode: 4, title: '账本', shotsJson: '[]', version: 1, revision: baseRevision, exists: true, stale: false }
  const version = { id: 32, version: 1, createdAt: null, createdBy: 'user_edit' }
  const file = { filename: '账本.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'UEsDBA==' }
  const draft = { id: 12, title: '账本', status: 'draft', episodeCount: 1, updatedAt: null, episodes: [{ episode: 4, title: '账本' }],
    revision: baseRevision, canFinalize: false, context: { outline: null, storyBible: null } }
  const { origin, requests } = await workbench((req) => {
    switch (req.url) {
      case '/v1/auth/muse/challenge': return [200, { requestId: 'fixture', challenge: 'c'.repeat(43) }]
      case '/v1/auth/muse/exchange': return [200, { access_token: 'fixture-token', user: { id: 41 } }]
      case '/v1/script-editor/drafts': return [200, draft]
      case root + '/storyboard': return [200, board]
      case root + '/history?layer=storyboard': return [200, { items: [version] }]
      case root + '/history/32?layer=storyboard': return [200, { ...version, content: '[]' }]
      case root + '/history/32/restore': return [200, { episode: null, storyboard: board }]
      case '/v1/script-editor/drafts/12/export?kind=storyboards&format=docx&episode=4': return [200, file]
      default: return [404, {}]
    }
  })
  const { ctx } = await host()
  await ctx.plugin(WorkshopConnection, { workshopOrigin: origin }).await()
  const api = ctx.workshopConnection
  const target = { draftId: 12, episode: 4, layer: 'storyboard' as const }
  expect(await api.createScriptDraft({ title: '账本', file: { filename: '账本.docx', base64: file.base64 } })).toEqual(draft)
  expect(await api.scriptDraftStoryboard(target)).toEqual(board)
  expect(await api.saveScriptDraftStoryboard({ ...target, baseRevision, shotsJson: '[]' })).toEqual(board)
  expect(await api.scriptDraftHistory(target)).toEqual({ items: [version] })
  expect(await api.scriptDraftHistoryEntry({ ...target, historyId: 32 })).toEqual({ ...version, content: '[]' })
  expect(await api.restoreScriptDraftHistory({ ...target, historyId: 32, baseRevision })).toEqual({ episode: null, storyboard: board })
  expect(await api.exportScriptDraft({ draftId: 12, episode: 4, kind: 'storyboards', format: 'docx' })).toEqual(file)
  expect(requests.slice(2).every(row => row.authorization === 'Bearer fixture-token')).toBe(true)
  expect(requests.slice(2).map(row => row.method)).toEqual(['POST', 'GET', 'PATCH', 'GET', 'GET', 'POST', 'GET'])
  expect(JSON.parse(requests.at(-2)!.body)).toEqual({ layer: 'storyboard', baseRevision })
})
