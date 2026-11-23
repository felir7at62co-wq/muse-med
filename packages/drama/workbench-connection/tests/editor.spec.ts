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
