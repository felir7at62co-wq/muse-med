import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { expect, it, vi } from 'vitest'
import { reviewedShots } from '../src/shots.ts'

const project = 'film-1'
const complete = { ok: true, truncated: false, total: 1, shots: [{ id: 'shot-1' }] }
const prompt = '雨打在空荡荡的站台上。'
const locked = { ok: true, id: 'shot-1', prompt_state: 'manual', override: { prompt }, gen_prompt: prompt }

function fixture() {
  const request = vi.fn<JingliuSession['request']>()
  const studio: JingliuSession = { identity: 'user-1', request }
  const signal = new AbortController().signal
  return { request, studio, signal }
}

const scopes: { scope: string; args: Record<string, JsonValue>; episode: Record<string, number> }[] = [
  { scope: 'one episode', args: { episode: 7 }, episode: { episode: 7 } },
  { scope: 'the project', args: { shot_ids: [] }, episode: {} },
]

it.each(scopes)('reads $scope in order and skips special shots and repeated IDs before confirming', async ({ args, episode }) => {
  const { request, studio, signal } = fixture()
  const shots = [{ id: 'shot-2' }, { id: 'title-card', special: true }, null, { id: 'shot-1' }, { id: 'shot-2' }]
  const other = '车站门口亮起暖黄色灯光。'
  request.mockResolvedValueOnce({ ...complete, total: shots.length, shots })
    .mockResolvedValueOnce({ ...locked, id: 'shot-2', override: { prompt: other }, gen_prompt: other })
    .mockResolvedValueOnce(locked)

  await expect(reviewedShots(studio, project, args, signal)).resolves.toEqual({
    ids: ['shot-2', 'shot-1'], prompts: [`shot-2\n${other}`, `shot-1\n${prompt}`],
  })
  expect(request.mock.calls).toEqual([
    ['/desktop-agent/tool', { method: 'POST', signal, body: { name: 'list_shots', project_id: project, args: { project_id: project, ...episode, limit: 10000 } } }],
    ['/desktop-agent/tool', { method: 'POST', signal, body: { name: 'get_shot', project_id: project, args: { shot_id: 'shot-2' } } }],
    ['/desktop-agent/tool', { method: 'POST', signal, body: { name: 'get_shot', project_id: project, args: { shot_id: 'shot-1' } } }],
  ])
})

it.each([
  { name: 'list response is absent', response: null },
  { name: 'studio rejected the list request', response: { ...complete, ok: false } },
  { name: 'list is truncated', response: { ...complete, truncated: true } },
  { name: 'shot collection is malformed', response: { ...complete, shots: {} } },
  { name: 'declared count exceeds the response', response: { ...complete, total: 2 } },
  { name: 'scope contains only a title card', response: { ...complete, shots: [{ id: 'title-card', special: true }] } },
  { name: 'ordinary shot has no ID', response: { ...complete, shots: [{}] } },
])('refuses a generation scope when the $name', async ({ response }) => {
  const { request, studio, signal } = fixture()
  request.mockResolvedValueOnce(response)
  await expect(reviewedShots(studio, project, {}, signal)).rejects.toMatchObject({ code: 'JINGLIU_SHOT_SCOPE' })
  expect(request).toHaveBeenCalledTimes(1)
})

it('rejects an unsafe shot ID before making any studio request', async () => {
  const { request, studio, signal } = fixture()
  await expect(reviewedShots(studio, project, { shot_ids: ['../other-project'] }, signal))
    .rejects.toMatchObject({ code: 'JINGLIU_SHOT_SCOPE' })
  expect(request).not.toHaveBeenCalled()
})

it.each([
  { name: 'missing response', response: null },
  { name: 'rejected fetch', response: { ...locked, ok: false } },
  { name: 'different shot', response: { ...locked, id: 'shot-2' } },
  { name: 'stale prompt', response: { ...locked, stale: true } },
  { name: 'automatic prompt', response: { ...locked, prompt_state: 'auto' } },
  { name: 'missing lock data', response: { ...locked, override: null } },
  { name: 'malformed lock data', response: { ...locked, override: { prompt: 3 } } },
  { name: 'blank prompt', response: { ...locked, override: { prompt: ' ' } } },
  { name: 'a generation prompt that differs from the locked text', response: { ...locked, gen_prompt: '不同的提示词。' } },
])('requires another review for $name', async ({ response }) => {
  const { request, studio, signal } = fixture()
  request.mockResolvedValueOnce(response)
  await expect(reviewedShots(studio, project, { shot_ids: [locked.id] }, signal))
    .rejects.toMatchObject({ code: 'JINGLIU_SHOT_REVIEW_REQUIRED' })
  expect(request).toHaveBeenCalledExactlyOnceWith('/desktop-agent/tool', {
    method: 'POST', signal, body: { name: 'get_shot', project_id: project, args: { shot_id: locked.id } },
  })
})
