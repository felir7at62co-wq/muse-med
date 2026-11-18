/** Pure pinned frontend helpers and Vue resolver functions, without model or browser access. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { planMediaAdoption } from '../compatibility/media-adoption.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const available = existsSync(resolve(root, 'frontweb/src/utils/storyboardMedia.js'))
const sources = new Map()
function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!sources.has(name)) sources.set(name, execFileSync('git', ['-C', root, 'show', `${revision}:${name}`], { encoding: 'utf8', maxBuffer: 2e6 }))
  return sources.get(name)
}
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
async function helpers(patched = true) {
  const path = resolve(root, 'frontweb/src/utils/storyboardMedia.js')
  const planned = new Map(patched ? planMediaAdoption(root, pristine) : [])
  let source = planned.get(path) ?? pristine(path)
  for (const dependency of ['mediaUrl', 'canvasLayout']) {
    source = source.replace(`'./${dependency}'`, JSON.stringify(dataModule(pristine(resolve(root, `frontweb/src/utils/${dependency}.js`)))))
  }
  return import(dataModule(source))
}
function vueFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start, `Vue function ${name} must exist`)
  return source.slice(start, end)
}
const oldFirst = { id: 1, status: 'completed', frame_type: 'storyboard_first', image_url: 'https://fixture.invalid/old-first.png', local_path: 'images/old-first.png' }
const newFirst = { id: 2, status: 'completed', frame_type: 'storyboard_first', image_url: 'https://fixture.invalid/new-first.png', local_path: 'images/new-first.png' }
const oldLast = { id: 3, status: 'completed', frame_type: 'storyboard_last', image_url: 'https://fixture.invalid/old-last.png', local_path: 'images/old-last.png' }
const newLast = { id: 4, status: 'completed', frame_type: 'storyboard_last', image_url: 'https://fixture.invalid/new-last.png', local_path: 'images/new-last.png' }
const imageHistory = { 10: [newFirst, newLast, oldFirst, oldLast] }
const oldVideo = { id: 5, status: 'completed', video_url: 'https://fixture.invalid/old.mp4', local_path: 'videos/old.mp4' }
const newVideo = { id: 6, status: 'completed', video_url: 'https://fixture.invalid/new.mp4', local_path: 'videos/new.mp4' }
const videoHistory = { 10: [newVideo, oldVideo] }

test('media planner validates pinned functions and preserves staged source', { skip: !available }, () => {
  const edits = planMediaAdoption(root, pristine)
  assert.equal(edits.length, 2)
  for (const [, source] of planMediaAdoption(root, path => '// staged media test\n' + pristine(path))) assert.ok(source.startsWith('// staged media test\n'))
  const patched = new Map(edits)
  assert.throws(() => planMediaAdoption(root, path => patched.get(path) ?? pristine(path)), /pinned source/)
  assert.throws(() => planMediaAdoption(root, path => pristine(path).replace('if (images.length) return images[0]', 'if (images.length) return images.at(-1)')), /pinned source/)
})

test('unpatched helper reproduces history overriding an adopted older image', { skip: !available }, async () => {
  const media = await helpers(false)
  const sb = { id: 10, image_url: oldFirst.image_url, local_path: oldFirst.local_path, first_frame_image_id: newFirst.id }
  assert.equal(media.resolveSbMainImageRecord(sb, imageHistory).id, newFirst.id)
  assert.equal(media.resolveSbFirstImageRecord(sb, imageHistory).id, newFirst.id)
})

test('main, first and last adopted images precede stale IDs and newer history', { skip: !available }, async () => {
  const media = await helpers()
  const sb = {
    id: 10, image_url: oldFirst.image_url, local_path: newFirst.local_path, first_frame_image_id: newFirst.id,
    last_frame_image_url: oldLast.image_url, last_frame_local_path: newLast.local_path, last_frame_image_id: newLast.id,
  }
  assert.equal(media.resolveSbMainImageRecord(sb, imageHistory), oldFirst)
  assert.equal(media.resolveSbFirstImageRecord(sb, imageHistory), oldFirst)
  assert.equal(media.resolveSbLastImageRecord(sb, imageHistory), oldLast)
  assert.equal(media.imageRecordUrl(media.resolveSbMainImageRecord(sb, imageHistory)), '/static/images/old-first.png')
  assert.deepEqual(media.sbVideoFirstLastUrls(sb, imageHistory, true), { first: '/static/images/old-first.png', last: '/static/images/old-last.png' })
  assert.deepEqual(media.sbVideoFirstLastUrls(sb, imageHistory, false), { first: '/static/images/old-first.png', last: undefined })
  assert.deepEqual(media.sbVideoFirstLastUrls({ ...sb, creation_mode: 'universal' }, imageHistory, true), { first: undefined, last: undefined })
})

test('uploaded, paginated and local image choices remain selected without a history match', { skip: !available }, async () => {
  const media = await helpers()
  const sb = { id: 10, first_frame_image_id: newFirst.id, image_url: 'https://fixture.invalid/manual.png', local_path: newFirst.local_path }
  const selected = media.resolveSbFirstImageRecord(sb, imageHistory)
  assert.equal(media.imageRecordUrl(selected), sb.image_url)
  assert.equal(selected.local_path, null)
  for (const image_url of ['/static/images/manual.png', 'http://127.0.0.1:5679/static/images/manual.png', 'images/manual.png']) {
    const record = media.resolveSbMainImageRecord({ ...sb, image_url }, imageHistory)
    assert.equal(media.imageRecordUrl(record), '/static/images/manual.png')
  }
  assert.equal(media.resolveSbMainImageRecord({ id: 10, local_path: '/static/images/old-first.png' }, imageHistory), oldFirst)
  assert.equal(media.imageRecordUrl(media.resolveSbMainImageRecord({ id: 10, local_path: '/static/images/manual.png' }, {})), '/static/images/manual.png')
  assert.equal(media.resolveSbFirstImageRecord({ id: 10, first_frame_image_id: 99 }, imageHistory), null)
  assert.equal(media.resolveSbLastImageRecord({ id: 10, last_frame_image_id: 99 }, imageHistory), null)
})

test('reused image URLs use the adopted local file or explicit frame generation', { skip: !available }, async () => {
  const media = await helpers()
  const repeatedFirst = { ...newFirst, image_url: oldFirst.image_url }
  const repeatedLast = { ...newLast, image_url: oldLast.image_url }
  const history = { 10: [repeatedFirst, repeatedLast, oldFirst, oldLast] }
  const sb = {
    id: 10, image_url: oldFirst.image_url, local_path: oldFirst.local_path, first_frame_image_id: repeatedFirst.id,
    last_frame_image_url: oldLast.image_url, last_frame_local_path: oldLast.local_path, last_frame_image_id: repeatedLast.id,
  }
  assert.equal(media.resolveSbMainImageRecord(sb, history), oldFirst)
  assert.equal(media.resolveSbFirstImageRecord(sb, history), oldFirst)
  assert.equal(media.resolveSbLastImageRecord(sb, history), oldLast)
  assert.equal(media.resolveSbFirstImageRecord({ ...sb, local_path: null, first_frame_image_id: oldFirst.id }, history), oldFirst)
  assert.equal(media.resolveSbLastImageRecord({ ...sb, last_frame_local_path: null, last_frame_image_id: oldLast.id }, history), oldLast)
  const unresolved = media.resolveSbMainImageRecord({ id: 10, image_url: oldFirst.image_url }, history)
  assert.equal(unresolved.image_url, oldFirst.image_url)
  assert.equal(unresolved.local_path, null)
})

test('adopted videos resolve their own generation file and never reuse storyboard image paths', { skip: !available }, async () => {
  const media = await helpers()
  const sb = { id: 10, video_url: oldVideo.video_url, local_path: oldFirst.local_path }
  assert.equal(media.resolveSbVideoRecord(sb, videoHistory), oldVideo)
  assert.equal(media.videoRecordUrl(media.resolveSbVideoRecord(sb, videoHistory)), '/static/videos/old.mp4')
  assert.equal(media.resolveSbVideoRecord({ ...sb, video_url: '/static/videos/old.mp4' }, videoHistory), oldVideo)
  const manual = media.resolveSbVideoRecord({ ...sb, video_url: 'https://fixture.invalid/manual.mp4' }, videoHistory)
  assert.equal(media.videoRecordUrl(manual), 'https://fixture.invalid/manual.mp4')
  assert.equal(manual.local_path, null)
  assert.equal(media.resolveSbVideoRecord({ id: 10, local_path: oldFirst.local_path }, {}), null)
  assert.equal(media.hasStoryboardVideo({ id: 10, local_path: oldFirst.local_path }, {}), false)
})

test('reused video URLs require an exact local file instead of choosing the newest generation', { skip: !available }, async () => {
  const media = await helpers()
  const repeated = { ...newVideo, video_url: oldVideo.video_url }
  const history = { 10: [repeated, oldVideo] }
  const sb = { id: 10, video_url: oldVideo.video_url, local_path: oldFirst.local_path }
  assert.equal(media.resolveSbVideoRecord(sb, history), null)
  assert.equal(media.hasStoryboardVideo(sb, history), false)
  assert.equal(media.resolveSbVideoRecord({ ...sb, video_url: '/static/videos/old.mp4' }, history), oldVideo)
  const pathCollision = { ...repeated, video_url: '/static/videos/old.mp4' }
  assert.equal(media.resolveSbVideoRecord({ ...sb, video_url: pathCollision.video_url }, { 10: [pathCollision, oldVideo] }), oldVideo)
})

test('classic and frame fallbacks still show eligible history when no version was adopted', { skip: !available }, async () => {
  const media = await helpers()
  const excluded = [
    { ...newFirst, id: 77, frame_type: 'quad_grid' },
    { ...newFirst, id: 78, frame_type: 'nine_grid' },
    { ...newFirst, id: 79, status: 'processing' },
  ]
  const history = { 10: [...excluded, newFirst, newLast, oldFirst] }
  assert.equal(media.resolveSbMainImageRecord({ id: 10 }, history), newFirst)
  assert.equal(media.resolveSbFirstImageRecord({ id: 10 }, history), newFirst)
  assert.equal(media.resolveSbLastImageRecord({ id: 10 }, history), newLast)
  assert.equal(media.resolveSbVideoRecord({ id: 10 }, videoHistory), newVideo)
})

test('list-view resolvers and video adoption use the same persisted media choices', { skip: !available }, async () => {
  const media = await helpers()
  const edits = new Map(planMediaAdoption(root, pristine))
  const vue = edits.get(resolve(root, 'frontweb/src/views/FilmCreate.vue'))
  const sb = {
    id: 10, image_url: oldFirst.image_url, local_path: oldFirst.local_path, first_frame_image_id: newFirst.id,
    last_frame_image_url: oldLast.image_url, last_frame_local_path: oldLast.local_path, last_frame_image_id: newLast.id,
    video_url: oldVideo.video_url,
  }
  const store = { storyboards: [sb], currentEpisode: { storyboards: [sb] } }
  const refs = { sbSelectedImgId: { value: { 10: newFirst.id } }, sbSelectedLastImgId: { value: { 10: newLast.id } }, sbSelectedVideoId: { value: { 10: newVideo.id } }, sbImages: { value: imageHistory }, sbVideos: { value: videoHistory }, storyboardUseFirstLastFrame: { value: false } }
  const updates = []
  const dependencies = { store, ...refs, ...media,
    resolveSbImageById: (id, imageId) => (imageHistory[id] || []).find(image => image.id === imageId) || null,
    getSbAllVideos: id => videoHistory[id] || [],
    storyboardsAPI: { update(id, body) { updates.push({ id, body }); return Promise.resolve() } },
  }
  const names = ['getSbFirstImage', 'getSbLastImage', 'getSbImage', 'getSbVideo', 'onSelectSbMainVideo']
  const execute = new Function(...Object.keys(dependencies), names.map(name => vueFunction(vue, name)).join('\n') + `\nreturn { ${names.join(',')} }`)
  const view = execute(...Object.values(dependencies))
  assert.equal(view.getSbImage(10), oldFirst)
  assert.equal(view.getSbFirstImage(10), oldFirst)
  assert.equal(view.getSbLastImage(10), oldLast)
  assert.equal(view.getSbVideo(10), oldVideo)
  view.onSelectSbMainVideo(sb, newVideo)
  assert.equal(view.getSbVideo(10), newVideo)
  assert.equal(sb.local_path, oldFirst.local_path)
  assert.deepEqual(updates[0], { id: 10, body: { video_url: '/static/videos/new.mp4' } })
  view.onSelectSbMainVideo(sb, { id: 7, local_path: '/static/videos/local-upload.mp4' })
  assert.equal(sb.video_url, '/static/videos/local-upload.mp4')
  assert.equal(sb.local_path, oldFirst.local_path)
  assert.deepEqual(updates[1], { id: 10, body: { video_url: '/static/videos/local-upload.mp4' } })
  refs.sbVideos.value = { 10: [{ ...newVideo, video_url: oldVideo.video_url }, oldVideo] }
  view.onSelectSbMainVideo(sb, oldVideo)
  assert.equal(sb.video_url, '/static/videos/old.mp4')
  assert.equal(view.getSbVideo(10), oldVideo)
  assert.equal(sb.local_path, oldFirst.local_path)
  assert.deepEqual(updates[2], { id: 10, body: { video_url: '/static/videos/old.mp4' } })
  for (const local_path of ['../outside.mp4', 'data:video/mp4;base64,invalid', 'videos/old.mp4?revision=2']) {
    view.onSelectSbMainVideo(sb, { id: 8, local_path, video_url: newVideo.video_url })
    assert.equal(sb.video_url, newVideo.video_url)
    assert.equal(sb.local_path, oldFirst.local_path)
  }
})
