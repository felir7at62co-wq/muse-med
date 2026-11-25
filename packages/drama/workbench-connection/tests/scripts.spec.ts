import { describe, expect, it } from 'vitest'
import { scriptDetail, scriptList, scriptOf } from '@deepseek-ai/dsh-workbench-connection/scripts'
import { workshopHost } from './fixture.ts'

const CARD = {
  id: 7, title: '好一个乖乖女', owner: { id: 1, name: '小林' }, rights: 'licensed', origin_work_id: 'hongguo:7481108346636864536',
  origin_title: '好一个乖乖女', kind: 'drama', style: 'realistic', episodes: 2, words: 40, status: 'in_production', latest_version: 3,
  picked: { by: { id: 2, name: null }, version: 2, at: '2026-11-20T08:00:00' }, project: { id: 'p-9', title: '乖乖女' },
  created_at: '2026-11-19T08:00:00', updated_at: null,
}

describe('script library responses', () => {
  it('reads a page with its counts and pick permission', () => {
    const counts = { waiting: 0, picked: 0, in_production: 1, all: 1 }
    const page = scriptList({ items: [CARD], total: 1, page: 1, limit: 50, counts, can_pick: true })
    expect(page.counts).toEqual({ waiting: 0, picked: 0, inProduction: 1, all: 1 })
    expect(page.items[0]).toMatchObject({ id: 7, originWorkId: 'hongguo:7481108346636864536', latestVersion: 3, picked: { by: { id: 2, name: null }, version: 2 }, project: { id: 'p-9' } })
    expect(page.canPick).toBe(true)
  })

  it('reads one version with untitled episodes', () => {
    const detail = scriptDetail({
      script: CARD, can_pick: false, versions: [{ number: 3, words: 40, created_at: null, by: { id: 1, name: '小林' } }],
      content: { version: 3, episodes: [{ order: 1, content: '林晚回家。' }] },
    })
    expect(detail.content.episodes).toEqual([{ order: 1, title: '', content: '林晚回家。' }])
    expect(detail.versions[0]?.by.name).toBe('小林')
  })

  it('returns empty pick and production fields consistently when no one has picked the script', () => {
    expect(scriptOf({ script: { ...CARD, status: 'waiting', picked: null, project: null } }))
      .toMatchObject({ status: 'waiting', picked: null, project: null })
  })

  it('rejects a stage or field the library does not define', () => {
    expect(() => scriptOf({ script: { ...CARD, status: 'archived' } })).toThrow(expect.objectContaining({ code: 'WORKSHOP_INVALID_RESULT' }))
    const counts = { waiting: 0, picked: 0, in_production: 0, all: 0 }
    expect(() => scriptList({ items: [], total: 0, page: 1, limit: 50, counts })).toThrow(/剧本库/u)
    expect(() => scriptDetail({ script: CARD, can_pick: true, versions: [], content: { version: 0, episodes: [] } })).toThrow(/剧本库/u)
  })

  it('rejects malformed cards, overlong pages and invalid permissions', () => {
    expect(() => scriptOf({ script: null })).toThrow(/剧本库/u)
    expect(() => scriptOf({ script: { ...CARD, title: 'a'.repeat(201) } })).toThrow(/剧本库/u)
    const counts = { waiting: 101, picked: 0, in_production: 0, all: 101 }
    const page = { items: Array.from({ length: 101 }, () => CARD), total: 101, page: 1, limit: 100, counts, can_pick: false }
    expect(() => scriptList(page)).toThrow(/剧本库/u)
    expect(() => scriptDetail({ script: CARD, can_pick: 'yes', versions: [], content: { version: 3, episodes: [] } })).toThrow(/剧本库/u)
  })
})

it('filters the signed-in library and records the selected version and production project', async () => {
  const page = { items: [CARD], total: 1, page: 2, limit: 20, counts: { waiting: 0, picked: 0, in_production: 1, all: 1 }, can_pick: true }
  const detail = { script: CARD, can_pick: true, versions: [{ number: 2, words: 40, created_at: null, by: CARD.owner }],
    content: { version: 2, episodes: [{ order: 1, title: '第一集', content: '林晚回家。' }] } }
  const { api, requests } = await workshopHost((req) => {
    if (req.url?.startsWith('/v1/script-library?')) return [200, page]
    if (req.url === '/v1/script-library/7/pick' || req.url === '/v1/script-library/7/production') return [200, { script: CARD }]
    if (req.url === '/v1/script-library/7' || req.url === '/v1/script-library/7?version=2') return [200, detail]
    return [404, {}]
  })

  await expect(api.scripts({ page: 2, limit: 20, status: 'in_production', q: '  林晚  ', mine: true })).resolves.toMatchObject({
    canPick: true, items: [{ id: 7 }], counts: { inProduction: 1 },
  })
  await api.scripts({ page: 2, limit: 20 })
  await api.scripts({ page: 2, limit: 20, q: '   ', mine: false })
  await expect(api.script({ id: 7 })).resolves.toMatchObject({ script: { id: 7 }, content: { version: 2 } })
  await expect(api.script({ id: 7, version: 2 })).resolves.toMatchObject({ content: { version: 2 } })
  await expect(api.pickScript({ id: 7, version: 2 })).resolves.toMatchObject({ picked: { version: 2 } })
  await expect(api.scriptProduction({ id: 7, projectId: 'p-9', projectTitle: '乖乖女' })).resolves.toMatchObject({ project: { id: 'p-9' } })

  expect(requests.slice(2).map(row => [row.method, decodeURIComponent(row.url)])).toEqual([
    ['GET', '/v1/script-library?page=2&limit=20&status=in_production&q=林晚&mine=true'],
    ['GET', '/v1/script-library?page=2&limit=20'],
    ['GET', '/v1/script-library?page=2&limit=20'],
    ['GET', '/v1/script-library/7'],
    ['GET', '/v1/script-library/7?version=2'],
    ['POST', '/v1/script-library/7/pick'],
    ['POST', '/v1/script-library/7/production'],
  ])
  expect(requests.slice(-2).map(row => row.body)).toEqual([
    JSON.stringify({ version: 2 }), JSON.stringify({ project_id: 'p-9', project_title: '乖乖女' }),
  ])
})
