import { describe, expect, it } from 'vitest'
import { scriptDetail, scriptList, scriptOf } from '../src/scripts.ts'

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

  it('rejects a stage or field the library does not define', () => {
    expect(() => scriptOf({ script: { ...CARD, status: 'archived' } })).toThrow(expect.objectContaining({ code: 'WORKSHOP_INVALID_RESULT' }))
    const counts = { waiting: 0, picked: 0, in_production: 0, all: 0 }
    expect(() => scriptList({ items: [], total: 0, page: 1, limit: 50, counts })).toThrow(/剧本库/u)
    expect(() => scriptDetail({ script: CARD, can_pick: true, versions: [], content: { version: 0, episodes: [] } })).toThrow(/剧本库/u)
  })
})
