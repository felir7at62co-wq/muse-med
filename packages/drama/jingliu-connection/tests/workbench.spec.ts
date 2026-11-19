/** Reading a production's configuration, episodes, shots, shot media and assets for the workbench. */
import { expect, it } from 'vitest'
import { episodeList, episodeShots, projectAssets, projectConfig, shotMedia, workflowResult } from '../src/browser.ts'

it('passes a successful workflow result through and reports a refused one with the studio message', () => {
  expect(workflowResult({ ok: true, title: 'x' })).toEqual({ ok: true, title: 'x' })
  expect(() => workflowResult({ ok: false, error: '项目不存在' })).toThrow('项目不存在')
  expect(() => workflowResult('nope')).toThrow()
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
  const rows = [{ id: 's2', prompt: '夜市', characters: ['阿桥', { name: '金狮' }], location: '桥头', props: ['灯笼'] }]
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
  expect(projectAssets({ ok: true, assets: [{ id: 'a1', kind: 'character', name: '阿桥', image_url: '/fw/media/a.png', prompt: '少年' }] },
    { ok: true, clips: [{ id: 'c1', kind: 'music', text: null, url: '/fw/media/m.mp3', duration: 12 }] }))
    .toEqual({ assets: [{ id: 'a1', kind: 'character', name: '阿桥', imagePath: '/fw/media/a.png', prompt: '少年' }],
      audio: [{ id: 'c1', kind: 'music', text: '', path: '/fw/media/m.mp3', durationSec: 12 }] })
})
