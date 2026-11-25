/** Reading a production's configuration, episodes, shots, shot media and assets for the workbench. */
import { expect, it } from 'vitest'
import { balance, billingUserId, catalog, createdProject, episodeList, episodeShots, library, options, preferences, projectAssets, projectConfig, projectPath, projects, shotMedia, workflowResult } from '../src/browser.ts'

it('passes a successful workflow result through and reports a refused one with the studio message', () => {
  expect(workflowResult({ ok: true, title: 'x' })).toEqual({ ok: true, title: 'x' })
  expect(() => workflowResult({ ok: false, error: '项目不存在' })).toThrow('项目不存在')
  expect(() => workflowResult('nope')).toThrow()
})

it('reads the balance and whether the studio stops generation at zero, null when it does not say', () => {
  const answer = { unlimited: false, available_yuan: '0.00', used_fen: 1200, held_fen: 0 }
  expect(balance({ ...answer, enforced: true })).toEqual({ unlimited: false, available: '0.00', usedFen: 1200, heldFen: 0, enforced: true })
  expect(balance({ ...answer, enforced: false }).enforced).toBe(false)
  expect(balance(answer).enforced).toBeNull()
  expect(balance({ ...answer, enforced: 'yes' }).enforced).toBeNull()
})

it('reads the project configuration and the episodes in order', () => {
  expect(projectConfig({ ok: true, project_id: 'p1', title: '金狮护桥', aspect: '9:16', art_style: '国风3D', production_mode: 'drama', resolution: '1080p', image_model: null, video_model: 'seed' }))
    .toEqual({ projectId: 'p1', title: '金狮护桥', aspect: '9:16', artStyle: '国风3D', mode: 'drama', resolution: '1080p', imageModel: '', videoModel: 'seed' })
  expect(episodeList({ ok: true, episodes: [{ order: 1, title: '一', has_shots: true }, { index: 2 }, 'bad', {}] }))
    .toEqual([{ number: 1, title: '一', hasShots: true }, { number: 2, title: '', hasShots: false }, { number: 4, title: '', hasShots: false }])
})

it('joins the shot list with the full rows and numbers shots within the episode, leaving special shots out', () => {
  const list = { ok: true, shots: [
    { id: 's1', order: 11, episode: 2, has_video: true, duration_sec: 4.5, fail_reason: null },
    { id: 'title', order: 12, episode: 2, special: true },
    { id: 's2', order: 13, episode: 2, has_video: false, fail_reason: '超时', stale: true },
  ] }
  const rows = [{ id: 's2', prompt: '夜市', characters: ['阿桥', { name: '金狮' }, null, {}], location: '桥头', props: ['灯笼'] }]
  expect(episodeShots(list, rows)).toEqual([
    { id: 's1', order: 11, episode: 2, index: 1, prompt: '', characters: [], location: '', props: [], durationSec: 4.5, hasVideo: true, failReason: '', stale: false },
    { id: 's2', order: 13, episode: 2, index: 2, prompt: '夜市', characters: ['阿桥', '金狮'], location: '桥头', props: ['灯笼'], durationSec: null, hasVideo: false, failReason: '超时', stale: true },
  ])
})

it('keeps only studio media paths for videos and pictures', () => {
  expect(shotMedia({ ok: true, id: 's1', video_url: '/fw/media/generated/s1.mp4', first_frame_url: 'https://elsewhere.example/f.png', adopted_version: 2 },
    { ok: true, versions: [{ version_no: 1, model_id: 'seed', video_url: '/fwp/media/generated/s1-v1.mp4', created_at: '2026-11-19' }, { version_no: 2, video_url: 'file:///etc/passwd' }] }))
    .toEqual({ shotId: 's1', videoPath: '/fw/media/generated/s1.mp4', firstFramePath: '', adoptedVersion: 2, versions: [
      { number: 1, model: 'seed', videoPath: '/fwp/media/generated/s1-v1.mp4', createdAt: '2026-11-19' },
      { number: 2, model: '', videoPath: '', createdAt: '' },
    ] })
  expect(projectAssets({ ok: true, assets: [{ id: 'a1', kind: 'character', name: '阿桥', image_url: '/fw/media/a.png', prompt: '少年' },
    { id: 'b1', kind: 'blocking', name: '渡口清晨站位图', image_url: '/fw/media/b.png', prompt: '', scope: '渡口清晨 · 第 6 集 2–4 镜' }] },
  { ok: true, clips: [{ id: 'c1', kind: 'music', text: null, url: '/fw/media/m.mp3', duration: 12 }] }))
    .toEqual({ assets: [{ id: 'a1', kind: 'character', name: '阿桥', imagePath: '/fw/media/a.png', prompt: '少年', scope: '' },
      { id: 'b1', kind: 'blocking', name: '渡口清晨站位图', imagePath: '/fw/media/b.png', prompt: '', scope: '渡口清晨 · 第 6 集 2–4 镜' }],
    audio: [{ id: 'c1', kind: 'music', text: '', path: '/fw/media/m.mp3', durationSec: 12 }] })
})

it('reads the creation choices: modes with their styles, frame ratios, resolutions and models', () => {
  const offered = catalog(
    { modes: { drama: { label: '🎭 真人剧', styles: [{ key: 'urban', label: '都市', enabled: true }, { key: 'period', label: '古风', enabled: false }] } },
      aspects: ['9:16', '16:9'], resolutions: ['720p', '1080p'] },
    { models: [{ id: 'nano-banana-pro', label: 'Nano Banana Pro' }, { nope: 1 }] },
    { providers: [{ model_id: 'seedance-2.0' }], generation_modes: { full_reference: '全参考生成（参考图作身份参考）' } })
  expect(offered).toEqual({
    modes: [{ key: 'drama', label: '真人剧', styles: [{ key: 'urban', label: '都市', enabled: true }, { key: 'period', label: '古风', enabled: false }] }],
    aspects: ['9:16', '16:9'], resolutions: ['720p', '1080p'],
    imageModels: [{ id: 'nano-banana-pro', name: 'Nano Banana Pro' }], videoModels: [{ id: 'seedance-2.0', name: 'seedance-2.0' }],
    generationModes: [{ id: 'full_reference', name: '全参考生成' }],
  })
  expect(() => catalog({}, {}, {})).toThrow()
})

it('reads the settings a production was created with, and the production the studio created', () => {
  const [row] = projects({ projects: [{ id: 'p1', title: '金狮护桥缘', episodes_count: 15, shots_total: 3, shots_done: 1, my_role: 'owner', thumb_url: null,
    production_mode: 'drama', base_aspect: '9:16', created_at: '2026-11-02T08:00:00+00:00', default_profile: '{"video_model":"seedance-2.0","generation_mode":"full_reference","resolution":"1080p"}' }] })
  expect(row).toMatchObject({ mode: 'drama', aspect: '9:16', createdAt: '2026-11-02T08:00:00+00:00',
    profile: { videoModel: 'seedance-2.0', generationMode: 'full_reference', resolution: '1080p' } })
  expect(projects({ projects: [{ id: 'p2', title: 'x', episodes_count: 0, shots_total: 0, shots_done: 0, my_role: 'owner', default_profile: 'not json' }] })[0]?.profile)
    .toEqual({ videoModel: '', generationMode: '', resolution: '' })
  expect(createdProject({ id: 'p3', title: '新项目', base_aspect: '9:16' })).toEqual({ id: 'p3', title: '新项目' })
})

it('rejects malformed studio lists and project records before displaying them', () => {
  const project = { id: 'p1', title: '金狮护桥', episodes_count: 1, shots_total: 2, shots_done: 0, my_role: 'owner' }
  const modes = { modes: { drama: {} } }
  const image = { models: [] }
  const video = { providers: [] }
  for (const read of [
    () => catalog({}, image, video),
    () => catalog(modes, null, video),
    () => catalog(modes, {}, video),
    () => catalog(modes, image, null),
    () => catalog(modes, image, {}),
    () => projects({ projects: null }),
    () => projects({ projects: [null] }),
    () => projects({ projects: [{ ...project, episodes_count: -1 }] }),
    () => projects({ projects: [{ ...project, title: 12 }] }),
    () => createdProject(null),
    () => library(null),
    () => library({ items: [null], total: 1 }),
    () => balance({ unlimited: 'false' }),
    () => billingUserId({ user: null }),
    () => billingUserId({ user: { id: '12' } }),
    () => episodeList({ episodes: 'empty' }),
    () => episodeShots({ shots: 'empty' }, []),
    () => projectAssets({}, {}),
  ]) expect(read).toThrow('镜流返回的数据格式已变更')

  expect(projects({ projects: [{ ...project, thumb_url: '/fw/media/p1.png' }] })[0]).toMatchObject({
    thumbnail: '/fw/media/p1.png', profile: { videoModel: '', generationMode: '', resolution: '' },
  })
  expect(projectPath('film-1')).toBe('/projects/film-1')
  expect(() => projectPath('../p1')).toThrow('镜流项目编号无效')
  expect(() => workflowResult({ ok: false })).toThrow('镜流没有完成这次读取')
})

it('keeps valid choices when the studio omits labels or adds unsupported catalog rows', () => {
  expect(catalog({ modes: { drama: { styles: [null, {}, { key: 'night' }] }, archive: {}, bad: 42 } },
    { models: [null, { id: 'image-1' }] }, { providers: [null, {}, { model_id: 'video-1' }], generation_modes: { reference: '' } }))
    .toEqual({
      modes: [{ key: 'drama', label: 'drama', styles: [{ key: 'night', label: 'night', enabled: true }] },
        { key: 'archive', label: 'archive', styles: [] }],
      aspects: [], resolutions: [], imageModels: [{ id: 'image-1', name: 'image-1' }],
      videoModels: [{ id: 'video-1', name: 'video-1' }], generationModes: [{ id: 'reference', name: 'reference' }],
    })
  expect(catalog({ modes: {} }, { models: [] }, { providers: [] }).generationModes).toEqual([])
})

it('reads library assets and keeps a project’s saved resolution when the studio stops offering it', () => {
  expect(library({ total: 2, items: [
    { asset_id: 'a', kind: 'character', name: '阿桥', image_url: '/fw/media/a.png', prompt: '少年', reference_only: true, uses: 1 },
    { asset_id: 'b', kind: 'prop', name: '桥灯', uses: 0 },
  ] })).toEqual({ total: 2, items: [
    { id: 'a', kind: 'character', name: '阿桥', thumbnail: '/fw/media/a.png', description: '少年', referenceOnly: true, uses: 1 },
    { id: 'b', kind: 'prop', name: '桥灯', thumbnail: '', description: '', referenceOnly: false, uses: 0 },
  ] })
  const image = { by_kind: {}, models: [{ id: 'one', name: 'One' }, { id: 'two' }] }
  const video = { tiers: ['480p', '720p', '1080p'], resolution: '480p' }
  expect(options('p1', image, { ...video, supported: ['1080p'] })).toMatchObject({
    resolution: '480p', resolutions: ['480p', '1080p'], models: [{ id: 'one', name: 'One' }, { id: 'two', name: 'two' }],
  })
  expect(options('p1', image, video).resolutions).toEqual(video.tiers)
  expect(() => options('p1', { ...image, by_kind: null }, video)).toThrow('镜流返回的数据格式已变更')
  expect(() => options('p1', { ...image, models: [null] }, video)).toThrow('镜流返回的数据格式已变更')
})

it('rejects project settings from a different project and accepts an empty version chain', () => {
  expect(preferences({ project_id: 'p1', prefs: { prompt_chips_hidden: true } }, 'p1'))
    .toEqual({ projectId: 'p1', hidePromptChips: true })
  expect(() => preferences({ project_id: 'p2', prefs: { prompt_chips_hidden: true } }, 'p1')).toThrow('镜流返回的数据格式已变更')
  expect(() => preferences({ project_id: 'p1', prefs: {} }, 'p1')).toThrow('镜流返回的数据格式已变更')
  expect(shotMedia({ id: 's1' }, {})).toEqual({ shotId: 's1', videoPath: '', firstFramePath: '', adoptedVersion: null, versions: [] })
  expect(projectAssets({ assets: [] }, {})).toEqual({ assets: [], audio: [] })
})
