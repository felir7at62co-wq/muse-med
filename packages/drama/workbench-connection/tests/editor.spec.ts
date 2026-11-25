import { expect, it } from 'vitest'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import WorkshopConnection from '../src/index.ts'
import { host, workbench, workshopHost } from './fixture.ts'

const baseRevision = 'a'.repeat(64)
const root = '/v1/script-editor/drafts/12/episodes/4'
const manuscript = { draftId: 12, episode: 4, title: '账本', content: '女主拿起账本。', revision: baseRevision, version: 2, candidate: null }
const candidate = { id: 'eac95b74-244e-4af2-ab4c-03a041ca212c', content: '女主从抽屉里翻出账本。', baseRevision, summary: '补出发现账本的动作。', createdAt: '2026-11-22T00:00:00Z' }

const board = { draftId: 12, episode: 4, title: '账本', shotsJson: '[]', version: 1, revision: baseRevision, exists: true, stale: false }
const version = { id: 32, version: 1, createdAt: null, createdBy: 'user_edit' }
const file = { filename: '账本.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'UEsDBA==' }
const draft = { id: 12, title: '账本', status: 'draft', episodeCount: 1, updatedAt: null, episodes: [{ episode: 4, title: '账本' }],
  revision: baseRevision, canFinalize: false, context: { outline: null, storyBible: null } }

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
  expect(requests.slice(2).map((row) => {
    const body: unknown = row.body ? JSON.parse(row.body) : null
    return [row.method, row.url, row.authorization, body]
  })).toEqual([
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

it('loads draft pages, preserves pending review, and saves the exact revision before publishing', async () => {
  const outline = { title: '账本' }
  const storyBible = { genre: 'drama' }
  const context = { outline, storyBible }
  const card = { id: 12, title: '账本', status: 'draft', episodeCount: 1, updatedAt: '2026-11-24T00:00:00Z' }
  const published = {
    id: 12, title: '账本', owner: { id: 41, name: null }, rights: 'original', origin_work_id: null, origin_title: null,
    kind: 'drama', style: 'realistic', episodes: 1, words: 8, status: 'waiting', latest_version: 1,
    picked: null, project: null, created_at: null, updated_at: null,
  }
  const { api, requests } = await workshopHost((req) => {
    switch (req.url) {
      case '/v1/script-editor/drafts?offset=0&limit=10&query=ledger': return [200, { items: [card], nextOffset: 10 }]
      case '/v1/script-editor/drafts?offset=10&limit=10': return [200, { items: [], nextOffset: null }]
      case '/v1/script-editor/drafts/12': return [200, { ...draft, context, canFinalize: true }]
      case root: return [200, req.method === 'GET' ? { ...manuscript, candidate } : manuscript]
      case root + '/candidates': return [200, candidate]
      case root + '/discard': return [200, manuscript]
      case root + '/history?layer=chapter': return [200, { items: [{ ...version, createdAt: '2026-11-24T00:00:00Z', createdBy: null }] }]
      case root + '/history/32/restore': return [200, { episode: manuscript, storyboard: null }]
      case '/v1/script-editor/drafts/12/export?kind=chapters&format=docx': return [200, file]
      case '/v1/script-editor/drafts/12/finalize': return [200, { script: published }]
      default: return [404, {}]
    }
  })
  const target = { draftId: 12, episode: 4 }
  const patch = { ...target, baseRevision, content: manuscript.content }
  const publish = { baseRevision, rights: 'original', kind: 'drama', style: 'realistic' } as const
  const historyTarget = { ...target, layer: 'chapter' as const }
  await expect(api.scriptDrafts({ offset: 0, limit: 10, query: '  ledger  ' })).resolves.toEqual({ items: [card], nextOffset: 10 })
  await expect(api.scriptDrafts({ offset: 10, limit: 10, query: '  ' })).resolves.toEqual({ items: [], nextOffset: null })
  await expect(api.scriptDraft({ draftId: 12 })).resolves.toMatchObject({
    canFinalize: true, context: { outline: JSON.stringify(outline), storyBible: JSON.stringify(storyBible) },
  })
  await expect(api.scriptDraftEpisode(target)).resolves.toMatchObject({ candidate })
  await expect(api.stageScriptDraftCandidate({ ...patch, summary: candidate.summary }, new AbortController().signal))
    .resolves.toEqual(candidate)
  await expect(api.discardScriptDraftCandidate({ ...target, candidateId: candidate.id })).resolves.toEqual(manuscript)
  await expect(api.saveScriptDraftEpisode(patch)).resolves.toEqual(manuscript)
  await expect(api.scriptDraftHistory(historyTarget)).resolves.toMatchObject({ items: [{ createdAt: '2026-11-24T00:00:00Z', createdBy: null }] })
  await expect(api.restoreScriptDraftHistory({ ...historyTarget, historyId: 32, baseRevision }))
    .resolves.toEqual({ episode: manuscript, storyboard: null })
  await expect(api.exportScriptDraft({ draftId: 12, kind: 'chapters', format: 'docx' })).resolves.toEqual(file)
  await expect(api.finalizeScriptDraft({ draftId: 12, ...publish })).resolves.toMatchObject({ id: 12, status: 'waiting' })
  const sent = requests.slice(2).filter(row => row.body !== '').map(row => [row.method, row.url, row.body])
  expect(sent).toEqual([
    ['POST', root + '/candidates', JSON.stringify({ baseRevision, content: manuscript.content, summary: candidate.summary })],
    ['POST', root + '/discard', JSON.stringify({ candidateId: candidate.id })],
    ['PATCH', root, JSON.stringify({ baseRevision, content: manuscript.content })],
    ['POST', root + '/history/32/restore', JSON.stringify({ layer: 'chapter', baseRevision })],
    ['POST', '/v1/script-editor/drafts/12/finalize', JSON.stringify(publish)],
  ])
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** A scoped Workshop test caller without the owner's access. */
    'workshop-test-guest': { readonly kind: 'workshop-test-guest' }
  }
}

it('refuses editor calls from non-owner peers before attempting Workshop sign-in', async () => {
  const { ctx, requests } = await workshopHost(() => [404, {}])
  const signal = new AbortController().signal
  const invocation: RemoteInvocation = {
    request: { namespace: 'workshopConnection', method: 'scriptDrafts', args: { offset: 0, limit: 10 } },
    service: 'workshopConnection',
    peer: { id: 'draft-guest' as PeerId, ctx, principal: { kind: 'workshop-test-guest' },
      interactions: 'none', signal, dispose: () => Promise.resolve() },
    signal,
    async *uplink() {},
  }
  await expect(ctx.extend({ invocation }).workshopConnection.scriptDrafts({ offset: 0, limit: 10 }))
    .rejects.toMatchObject({ code: 'WORKSHOP_EDITOR_OWNER_REQUIRED' })
  expect(requests).toEqual([])
})

it('rejects invalid request coordinates before contacting the Workshop', async () => {
  const { ctx, account } = await host()
  await ctx.plugin(WorkshopConnection, {}).await()
  const api = ctx.workshopConnection
  for (const request of [
    () => api.scriptDraft({ draftId: 0 }),
    () => api.scriptDraftEpisode({ draftId: 12, episode: 0 }),
    () => api.scriptDrafts({ offset: -1, limit: 10 }),
    () => api.scriptDrafts({ offset: 0, limit: 101 }),
    () => api.scriptDrafts({ offset: 0, limit: 10, query: 'x'.repeat(101) }),
    () => api.scriptDraftHistoryEntry({ draftId: 12, episode: 4, layer: 'chapter', historyId: 0 }),
    () => api.exportScriptDraft({ draftId: 12, kind: 'chapters', format: 'txt', episode: 0 }),
  ]) await expect(request()).rejects.toMatchObject({ code: 'WORKSHOP_EDITOR_INVALID_REQUEST' })
  expect(account.grant).not.toHaveBeenCalled()
})

const targetEpisode = { draftId: 12, episode: 4 }
const targetHistory = { ...targetEpisode, historyId: 32, baseRevision }
const targetExport = { draftId: 12, kind: 'chapters', format: 'docx' } as const

it.each([
  { label: 'non-object draft', reply: null, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'invalid draft ID', reply: { ...draft, id: 0 }, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'invalid draft title', reply: { ...draft, title: false }, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'invalid draft episodes', reply: { ...draft, episodes: null }, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'invalid draft revision', reply: { ...draft, revision: 'unverified' }, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'invalid finalize permission', reply: { ...draft, canFinalize: 1 }, invoke: (api: WorkshopConnection) => api.scriptDraft({ draftId: 12 }) },
  { label: 'different storyboard episode', reply: { ...board, episode: 5 }, invoke: (api: WorkshopConnection) => api.scriptDraftStoryboard(targetEpisode) },
  { label: 'different history version', reply: { ...version, id: 33, content: '[]' }, invoke: (api: WorkshopConnection) => api.scriptDraftHistoryEntry({ ...targetHistory, layer: 'storyboard' }) },
  { label: 'chapter restore with a storyboard', reply: { episode: manuscript, storyboard: board }, invoke: (api: WorkshopConnection) => api.restoreScriptDraftHistory({ ...targetHistory, layer: 'chapter' }) },
  { label: 'storyboard restore with a chapter', reply: { episode: manuscript, storyboard: board }, invoke: (api: WorkshopConnection) => api.restoreScriptDraftHistory({ ...targetHistory, layer: 'storyboard' }) },
  { label: 'unsafe export filename', reply: { ...file, filename: '../draft.docx' }, invoke: (api: WorkshopConnection) => api.exportScriptDraft(targetExport) },
  { label: 'invalid export MIME', reply: { ...file, mime: 'text/plain, text/html' }, invoke: (api: WorkshopConnection) => api.exportScriptDraft(targetExport) },
  { label: 'invalid export bytes', reply: { ...file, base64: 'abc*' }, invoke: (api: WorkshopConnection) => api.exportScriptDraft(targetExport) },
])('refuses $label from the Workshop', async ({ reply, invoke }) => {
  const { api } = await workshopHost(() => [200, reply])
  await expect(invoke(api)).rejects.toMatchObject({ code: 'WORKSHOP_EDITOR_INVALID_RESULT' })
})
