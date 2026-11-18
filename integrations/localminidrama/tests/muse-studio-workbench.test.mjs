/** The gallery keeps each video's input evidence separate and recovers free writes by original receipt. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import { planStudioUx } from '../compatibility/studio-ux.mjs'
import { createPinnedSourceReader } from './pinned-source.mjs'
import { createStudioWorkbenchState, createStudioWorkbenchController, studioPromptParts,
  studioDuration, studioPackageStatus, studioOtherReferences, confirmStudioDiscard,
  studioAssetVersionLabel, studioAssetChoice, studioAssetInspection } from '../extensions/muse-studio-workbench.js'

const clone = value => JSON.parse(JSON.stringify(value))
const hash = digit => digit.repeat(64)
const binding = (version, name = '林夏') => ({ bindingId: 'hero_' + version, referenceToken: '@asset(hero_' + version + ')',
  assetKind: 'character', assetId: 7, versionId: 'asset-' + version, displayName: name + ' · ' + version,
  sha256: hash(version === 'old' ? 'a' : 'b'), mediaUrl: '/static/immutable/' + version + '.png' })
function trace(packageId = 101, projectId = 1, episodeId = 11) {
  const old = binding('old'), newer = binding('new')
  return { schema: 'muse-studio-package-v1', databaseId: 'database-' + projectId, projectId, episodeId, packageId,
    current: { revisionId: 'revision-2', snapshotSha256: hash('2'), imagePrompt: '当前画面', videoPrompt: '当前动作 ' + newer.referenceToken,
      imageBindings: [], videoBindings: [newer] },
    videos: { items: [old, newer].map((ref, index) => ({ kind: 'video', generationId: index + 20, createdAt: '2026-11-13T08:00:00Z',
      status: 'completed', mediaUrl: '/static/video-' + index + '.mp4', durationSeconds: 5, adopted: index === 1,
      inputs: { state: 'captured', source: 'native-snapshot', prompt: (index ? '新的动作 ' : '最初动作 ') + ref.referenceToken,
        bindings: [ref], references: [], model: 'model-a', operationId: null, requestSha256: null } })), nextCursor: null },
    images: { items: [], nextCursor: null }, assets: [{ assetKind: 'character', assetId: 7, name: '林夏',
      currentMediaUrl: '/static/current/changed-again.png', snapshotGuard: { database_id: 'database-' + projectId, kind: 'character', id: 7, snapshot: hash('9') },
      versions: [old, newer].map(ref => ({ versionId: ref.versionId, assetKind: ref.assetKind, assetId: ref.assetId,
        displayName: ref.displayName, sha256: ref.sha256, mediaUrl: ref.mediaUrl, generationId: null, createdAt: '2026-11-13T08:00:00Z' })) }] }
}
function fixture({ storage = new Map(), initial = trace() } = {}) {
  const state = createStudioWorkbenchState(), requests = [], receipts = new Map(), traces = new Map([[101, clone(initial)], [102, trace(102)]])
  let loseAcknowledgement = false, rejection = null, deferredTrace = null
  const project = id => ({ id, title: '真实数据测试项目', episodes: [{ id: id === 1 ? 11 : 22, episode_number: 1,
    storyboards: [{ id: id === 1 ? 101 : 201, image_url: '/static/current.png' }] }], characters: [], scenes: [], props: [] })
  const request = {
    async get(path, options) {
      requests.push({ method: 'get', path, options })
      if (path.startsWith('/dramas/')) return project(Number(path.split('/').at(-1)))
      if (path.startsWith('/muse/packages/episodes/')) return { episode_id: Number(path.split('/').at(-1)), items: [101, 102].map(id => ({ id,
        title: '制作包 ' + id, order: id - 100, actual_duration: 5, adopted_generation_id: 21, adopted_video_present: true,
        adopted_video_url: '/static/video-1.mp4', pending_generations: 0, failed_generations: 0 })) }
      if (path.startsWith('/muse/studio/operations/')) {
        const result = receipts.get(path.split('/').at(-1))
        return result ? { state: 'recorded', result: clone(result) } : { state: 'missing', result: null }
      }
      if (path.startsWith('/muse/studio/packages/')) {
        const id = Number(path.split('/').at(-1))
        if (deferredTrace) { const deferred = deferredTrace; deferredTrace = null; return await deferred }
        return clone(traces.get(id))
      }
      throw new Error('Unexpected read ' + path)
    },
    async post(path, body) {
      requests.push({ method: 'post', path, body: clone(body) })
      if (rejection) { const error = rejection; rejection = null; throw error }
      let result = receipts.get(body.operationId)
      if (!result) {
        const selected = traces.get(state.packageId)
        if (path.endsWith('/revisions')) {
          assert.equal(body.expectedSnapshotSha256, selected.current.snapshotSha256)
          selected.current = { revisionId: 'revision-3', snapshotSha256: hash('3'), imagePrompt: body.imagePrompt,
            videoPrompt: body.videoPrompt, imageBindings: clone(state.draft.imageBindings), videoBindings: clone(state.draft.videoBindings) }
          result = { databaseId: selected.databaseId, current: clone(selected.current) }
        } else if (path.endsWith('/adopt')) {
          for (const item of selected.videos.items) item.adopted = item.generationId === body.generationId
          selected.current.snapshotSha256 = hash('4')
          result = { databaseId: selected.databaseId, current: clone(selected.current) }
        } else if (path === '/muse/studio/assets/versions') result = { versionId: 'asset-captured', assetKind: body.assetKind,
          assetId: body.assetId, displayName: '林夏 · 当前图已保存', sha256: hash('c'), mediaUrl: '/static/immutable/captured.png', generationId: null, createdAt: '2026-11-13T08:00:00Z' }
        else throw new Error('Unexpected write ' + path)
        receipts.set(body.operationId, clone(result))
      }
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Connection ended after commit') }
      return clone(result)
    },
  }
  const browserStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const controller = createStudioWorkbenchController({ state, request, storage: browserStorage, crypto: webcrypto })
  return { state, controller, request, requests, receipts, traces, storage, browserStorage,
    loseAcknowledgement() { loseAcknowledgement = true }, reject(error) { rejection = error }, deferTrace(promise) { deferredTrace = promise } }
}

test('each video keeps its own prompt and bound image after the current project image changes', async () => {
  const f = fixture(); await f.controller.loadProject(1)
  const versions = f.state.trace.videos.items.map(version => ({ generationId: version.generationId,
    prompt: version.inputs.prompt, references: studioPromptParts(version.inputs.prompt, version.inputs.bindings)
      .filter(part => part.kind === 'asset').map(part => ({ name: part.binding.displayName, mediaUrl: part.binding.mediaUrl })) }))
  assert.deepEqual(versions, JSON.parse(readFileSync(new URL('./expected/muse-studio-workbench-inputs.json', import.meta.url), 'utf8')))
  f.state.draft.videoPrompt = '修改后的动作 ' + binding('new').referenceToken
  await f.controller.saveRevision()
  assert.deepEqual(f.state.trace.videos.items.map(item => item.inputs.prompt), ['最初动作 @asset(hero_old)', '新的动作 @asset(hero_new)'])
  assert.equal(f.requests.filter(item => item.method === 'post').length, 1)
  f.controller.dispose()
})

test('a lost save acknowledgement is recovered after remount by its original successful receipt', async () => {
  const f = fixture(); await f.controller.loadProject(1); f.state.draft.videoPrompt = '保留原草稿'
  f.loseAcknowledgement(); await f.controller.saveRevision()
  const id = f.state.pending.operationId
  assert.equal(f.state.pending.kind, 'revision'); assert.equal(f.storage.size, 1)
  f.controller.dispose()
  const state = createStudioWorkbenchState(), controller = createStudioWorkbenchController({ state, request: f.request,
    storage: f.browserStorage, crypto: webcrypto })
  await controller.loadProject(1); assert.equal(state.pending.operationId, id)
  await controller.inspectPending()
  assert.equal(state.pending, null); assert.equal(f.storage.size, 0)
  assert.equal(f.requests.filter(item => item.method === 'post').length, 1)
  assert.equal(state.draft.videoPrompt, '保留原草稿')
  controller.dispose()
})

test('a committed-false conflict retains draft until the original receipt is checked and the current revision is explicitly read', async () => {
  const f = fixture(); await f.controller.loadProject(1); f.state.draft.videoPrompt = '本地想保留的修改'
  f.traces.get(101).current.snapshotSha256 = hash('8')
  const error = new Error('内容已变化'); error.response = { data: { error: { code: 'studio_snapshot_changed', message: '内容已变化', committed: false } } }
  f.reject(error); await f.controller.saveRevision()
  assert.equal(f.state.pending.rejected, true); assert.equal(f.state.draft.videoPrompt, '本地想保留的修改')
  await f.controller.refreshRejected(); assert.ok(f.state.pending)
  await f.controller.inspectPending(); assert.equal(f.state.pendingMissing, true)
  await f.controller.refreshRejected(); assert.equal(f.state.pending, null)
  assert.equal(f.state.trace.current.snapshotSha256, hash('8')); assert.equal(f.state.draft.videoPrompt, '本地想保留的修改')
  await f.controller.saveRevision(); assert.equal(f.state.pending, null)
  assert.equal(f.requests.filter(item => item.method === 'post').length, 2)
  f.controller.dispose()
})

test('asset capture binds an immutable copy into the chosen prompt and saves references in first-token order', async () => {
  const f = fixture(); await f.controller.loadProject(1)
  await f.controller.captureAsset(f.state.trace.assets[0], 'image')
  const ref = f.state.draft.imageBindings[0]
  assert.equal(ref.mediaUrl, '/static/immutable/captured.png')
  assert.ok(f.state.draft.imagePrompt.includes(ref.referenceToken))
  assert.equal(f.state.draft.videoBindings[0].mediaUrl, '/static/immutable/new.png')
  f.state.draft.videoPrompt = '没有参考的纯文字'
  await f.controller.saveRevision()
  const save = f.requests.find(item => item.path.endsWith('/revisions'))
  assert.equal(save.body.imageBindings[0].versionId, 'asset-captured')
  assert.deepEqual(save.body.videoBindings, [])
  assert.equal(f.requests.filter(item => item.path.includes('generate') || item.path.includes('/run')).length, 0)
  f.controller.dispose()
})

test('unbound prompt tokens refuse saving and media adoption never discards a dirty draft', async () => {
  const f = fixture(); await f.controller.loadProject(1); f.state.draft.videoPrompt = '@asset(missing)'
  await f.controller.saveRevision(); assert.match(f.state.notice, /未绑定/)
  await f.controller.adoptVersion(f.state.trace.videos.items[0]); assert.match(f.state.notice, /草稿/)
  assert.equal(f.requests.filter(item => item.method === 'post').length, 0)
  f.controller.dispose()
})

test('a repair draft needs its reason and saves the original video identity without changing that history', async () => {
  const f = fixture(); await f.controller.loadProject(1)
  const original = clone(f.state.trace.videos.items[0]), history = clone(f.state.trace.videos.items)
  f.state.draft.videoPrompt = original.inputs.prompt; f.state.draft.videoBindings = clone(original.inputs.bindings)
  f.state.draft.parentGenerationId = original.generationId; f.state.draft.changeReason = ''
  await f.controller.saveRevision(); assert.match(f.state.notice, /修改的具体原因/)
  assert.equal(f.requests.filter(item => item.method === 'post').length, 0)
  f.state.draft.changeReason = 'Correct the source-backed action'
  await f.controller.saveRevision()
  const request = f.requests.find(item => item.path.endsWith('/revisions'))
  assert.equal(request.body.parentGenerationId, original.generationId)
  assert.equal(request.body.changeReason, 'Correct the source-backed action')
  assert.deepEqual(f.state.trace.videos.items, history)
  assert.equal(f.requests.some(item => /generate|\/run|\/submit/.test(item.path)), false)
  f.controller.dispose()
})

test('a late package response cannot replace a newer selection and transient errors preserve visible records', async () => {
  const f = fixture(); await f.controller.loadProject(1)
  let complete
  f.deferTrace(new Promise(resolve => { complete = resolve }))
  const stale = f.controller.selectPackage(101)
  await f.controller.selectPackage(102)
  complete(trace(101)); await stale
  assert.equal(f.state.packageId, 102); assert.equal(f.state.trace.packageId, 102)
  f.deferTrace(Promise.reject(new Error('读取中断')))
  await f.controller.selectPackage(102)
  assert.equal(f.state.trace.packageId, 102); assert.match(f.state.traceError, /读取中断/)
  f.controller.dispose()
})

test('unmounting fences an outstanding read without publishing its data', async () => {
  const f = fixture(); await f.controller.loadProject(1)
  let complete
  f.deferTrace(new Promise(resolve => { complete = resolve }))
  const reading = f.controller.selectPackage(102)
  f.controller.dispose(); complete(trace(102)); await reading
  assert.equal(f.state.trace, null)
})

test('switching project while a write completes keeps its receipt private to the original database', async () => {
  const f = fixture(); await f.controller.loadProject(1); f.state.draft.videoPrompt = '原项目修改'
  let complete
  f.request.post = async () => await new Promise(resolve => { complete = resolve })
  const saving = f.controller.saveRevision()
  await f.controller.loadProject(2)
  complete({ databaseId: 'database-1', current: trace().current }); await saving
  assert.equal(f.state.projectId, 2); assert.equal(f.state.pending, null); assert.equal(f.state.saving, false)
  assert.equal(f.storage.size, 1)
  assert.equal(f.storage.has('muse-studio-pending:database-1'), true)
  assert.equal(f.state.notice, '')
  f.controller.dispose()
})

test('a tampered stored save destination is never dispatched', async () => {
  const f = fixture()
  f.storage.set('muse-studio-pending:database-1', JSON.stringify({ databaseId: 'database-1', projectId: 1, packageId: 101,
    operationId: 'original-operation', kind: 'revision', path: '/videos', body: { databaseId: 'database-1' }, draft: {} }))
  await f.controller.loadProject(1)
  assert.match(f.state.traceError, /保存目标无法核对/)
  await f.controller.saveRevision()
  assert.equal(f.requests.filter(item => item.method === 'post').length, 0)
  f.controller.dispose()
})

test('history pagination keeps earlier input snapshots instead of replacing them with current assets', async () => {
  const f = fixture(); await f.controller.loadProject(1); f.state.trace.videos.nextCursor = 'older-page'
  const page = trace(); page.videos.items = [{ ...page.videos.items[0], generationId: 19 }]
  f.deferTrace(Promise.resolve(page)); await f.controller.moreVersions('video')
  assert.deepEqual(f.state.trace.videos.items.map(item => item.generationId), [20, 21, 19])
  assert.equal(f.state.trace.videos.items[2].inputs.bindings[0].mediaUrl, '/static/immutable/old.png')
  f.controller.dispose()
})

test('package labels distinguish adoption from historical failures and measured duration stays unknown when absent', () => {
  assert.equal(studioPackageStatus({ pending_generations: 0, failed_generations: 2, adopted_generation_id: 21, adopted_video_present: true }).label, '已采用')
  assert.equal(studioPackageStatus({ pending_generations: 0, failed_generations: 1, adopted_generation_id: 6, adopted_video_present: false }).label, '需要检查')
  assert.equal(studioPackageStatus({ pending_generations: 0, failed_generations: 1, adopted_generation_id: null, adopted_video_present: false }).attention, true)
  assert.equal(studioDuration(null), '时长未知'); assert.equal(studioDuration(59.8), '01:00')
  assert.deepEqual(studioPromptParts('<script>x</script> @asset(no-copy)', []), [{ kind: 'text', text: '<script>x</script> ' }, { kind: 'missing', text: '@asset(no-copy)' }])
})

test('only the explicit discard action leaves a dirty draft; Enter and closing preserve it', async () => {
  let options
  assert.equal(await confirmStudioDiscard(async (_message, _title, value) => { options = value }), false)
  assert.equal(options.confirmButtonText, '继续编辑')
  assert.equal(options.cancelButtonText, '放弃草稿并切换')
  assert.equal(options.distinguishCancelAndClose, true)
  assert.equal(await confirmStudioDiscard(async () => { throw 'close' }), false)
  assert.equal(await confirmStudioDiscard(async () => { throw 'cancel' }), true)
})

test('additional references exclude exact bound hashes and a selected asset previews its original image', () => {
  const version = trace().videos.items[0], bound = version.inputs.bindings[0]
  version.inputs.references = [{ mediaUrl: bound.mediaUrl, sha256: bound.sha256, evidence: 'immutable-copy' },
    { mediaUrl: '/static/other.png', sha256: hash('e'), evidence: 'immutable-copy' },
    { mediaUrl: null, sha256: null, evidence: 'unavailable' }]
  assert.deepEqual(studioOtherReferences(version).map(item => item.sha256), [hash('e'), null])
  const asset = trace().assets[0]
  assert.equal(studioAssetChoice(asset, 'asset-old').mediaUrl, '/static/immutable/old.png')
  assert.equal(studioAssetChoice(asset, 'asset-old').sha256, hash('a'))
  assert.equal(studioAssetChoice(asset, null).mediaUrl, '/static/current/changed-again.png')
  const [first, second] = asset.versions.map(item => ({ ...item, displayName: '同一角色名称' }))
  assert.notEqual(studioAssetVersionLabel(first), studioAssetVersionLabel(second))
  assert.ok(studioAssetVersionLabel(first).includes('aaaaaaaa'))
})

test('the UX planner preserves advanced tools and refuses an already modified route', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-studio-ux-'))
  try {
    mkdirSync(join(root, 'frontweb/src/router'), { recursive: true })
    const path = join(root, 'frontweb/src/router/index.js')
    const upstream = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
    const original = createPinnedSourceReader(upstream)(resolve(upstream, 'frontweb/src/router/index.js'))
    writeFileSync(path, original)
    const plan = planStudioUx(root)
    const router = plan.find(([file]) => file === path)[1]
    assert.match(router, /MuseStudioWorkbench\.vue/); assert.match(router, /film\/:id\/advanced/); assert.match(router, /FilmCreate\.vue/)
    assert.ok(plan.find(([file]) => file.endsWith('MuseStudioPrompt.vue')))
    assert.equal(plan.some(([file]) => /MuseJubianPanel|museJubianPanel/.test(file)), false)
    const workbench = plan.find(([file]) => file.endsWith('MuseStudioWorkbench.vue'))[1]
    assert.doesNotMatch(workbench, /MuseJubian|askJubian|剧变|LibTV/)
    assert.match(workbench, /role="status">生成后端尚未接入；项目、资产和历史可正常管理/)
    assert.match(workbench, /人物/); assert.match(workbench, /场景/); assert.match(workbench, /道具/)
    writeFileSync(path, router); assert.throws(() => planStudioUx(root), /pinned source/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const frontend = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama', 'frontweb')

test('asset inspection checks saved category metadata without modifying assets or judging image content', () => {
  const project = { characters: [
    { id: 7, name: 'Hero', image_url: '' }, { id: 8, name: ' hero ', image_url: ' ' },
    { id: 9, name: '', local_path: '/saved/character.png' }],
  scenes: [{ id: 7, location: 'Hero', image_url: '/saved/scene.png' }],
  props: [{ id: 7, name: 'Hero' }] }
  const before = JSON.stringify(project), report = studioAssetInspection(project)
  assert.equal(report.total, 5)
  assert.deepEqual(report.groups, [
    { kind: 'character', label: '人物', total: 3, missingImage: 2, missingName: 1, duplicateName: 2 },
    { kind: 'scene', label: '场景', total: 1, missingImage: 0, missingName: 0, duplicateName: 0 },
    { kind: 'prop', label: '道具', total: 1, missingImage: 1, missingName: 0, duplicateName: 0 }])
  assert.equal(report.issues.length, 4)
  assert.deepEqual(report.issues[0].reasons, ['未设置主参考图', '同类资产重名，请核对'])
  assert.equal(report.issues[2].name, '未命名人物')
  assert.equal(report.issues[3].kind, 'prop')
  assert.equal(JSON.stringify(project), before)
  const empty = studioAssetInspection(null)
  assert.equal(empty.total, 0); assert.deepEqual(empty.issues, [])
  assert.deepEqual(empty.groups.map(group => [group.kind, group.total]), [['character', 0], ['scene', 0], ['prop', 0]])
})

test('asset inspection hands off only the saved project even with an unsaved shot and keeps an unavailable request visible', { skip: !existsSync(resolve(frontend, 'node_modules/@vue/compiler-sfc')) }, async () => {
  const { JSDOM } = await import('jsdom'), dom = new JSDOM('<div id="asset-inspection-fixture"></div>')
  const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement']
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let app
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
    const require = createRequire(resolve(frontend, 'package.json')), Vue = require('vue')
    const { parse, compileScript } = require('@vue/compiler-sfc')
    const { descriptor } = parse(readFileSync(new URL('../extensions/muse-studio-workbench.vue', import.meta.url), 'utf8'))
    const compiled = compileScript(descriptor, { id: 'workbench-asset-inspection', genDefaultAs: '__component' })
    const initial = { ...createStudioWorkbenchState(), projectId: 1, episodeId: 11, packageId: 101,
      project: { id: 1, episodes: [], characters: [{ id: 7, name: 'Hero' }], scenes: [], props: [] } }
    const before = JSON.stringify(initial.project), requests = []
    let publish, accepted = false
    const controller = { loadProject: async () => {}, dispose() {}, dirty: () => true }
    const fixtures = { useTheme: () => ({ isDark: Vue.ref(false), toggle() {} }),
      useRoute: () => ({ params: { id: '1' }, query: {} }), useRouter: () => ({}), studioAssetInspection,
      createStudioWorkbenchState: () => initial, createStudioWorkbenchController: () => controller,
      createMuseStudioBridge: ({ onState }) => { publish = onState; return { start() {}, stop() {}, request(intent, selection) {
        requests.push({ intent, selection }); return accepted
      } } } }
    const imports = Object.entries(compiled.imports)
    const dependencies = imports.map(([name, entry]) => entry.source === 'vue' ? Vue[entry.imported] : fixtures[name] || {})
    const Component = compileFunction(compiled.content.replace(/^import .*$/mg, '') + '\nreturn __component', imports.map(([name]) => name))(...dependencies)
    let actions
    app = Vue.createApp({ setup() {
      actions = Component.setup({}, { expose() {} })
      return () => Vue.h('div', [Vue.h('button', { onClick: actions.openAssetInspection }, '检查资产'),
        actions.assetInspectionOpen.value ? Vue.h('section', { role: 'dialog' }, [
          Vue.h('span', actions.assetInspection.value.issues.map(issue => issue.name).join(',')),
          actions.assetInspectionError.value ? Vue.h('p', { role: 'alert' }, actions.assetInspectionError.value) : null,
          Vue.h('button', { disabled: !actions.canInspectAssets.value, onClick: actions.inspectAssetsWithMuse }, '交给 Muse 深入检查')]) : null])
    } })
    app.mount(dom.window.document.getElementById('asset-inspection-fixture')); await Vue.nextTick()
    dom.window.document.querySelector('button').click(); await Vue.nextTick()
    assert.ok(dom.window.document.querySelector('[role="dialog"]'))
    assert.equal(dom.window.document.querySelector('[role="dialog"] button').disabled, true)
    assert.equal(actions.assetInspection.value.groups[0].missingImage, 1)
    publish({ available: true, pending: false, intents: ['inspect_project'] }); await Vue.nextTick()
    assert.equal(actions.canInspectAssets.value, false)
    publish({ available: true, pending: false, intents: ['inspect_assets'] }); await Vue.nextTick()
    assert.equal(dom.window.document.querySelector('[role="dialog"] button').disabled, false)
    dom.window.document.querySelector('[role="dialog"] button').click(); await Vue.nextTick()
    assert.equal(actions.assetInspectionOpen.value, true)
    assert.match(actions.state.notice, /未能交给 Muse/)
    assert.match(actions.assetInspectionError.value, /检查任务未能交给 Muse/)
    assert.equal(dom.window.document.querySelector('[role="dialog"] [role="alert"]').textContent, actions.assetInspectionError.value)
    actions.assetInspectionOpen.value = false
    await Vue.nextTick()
    dom.window.document.querySelector('button').click(); await Vue.nextTick()
    assert.equal(actions.assetInspectionError.value, '')
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null)
    accepted = true
    dom.window.document.querySelector('[role="dialog"] button').click(); await Vue.nextTick()
    assert.equal(actions.assetInspectionOpen.value, false)
    assert.deepEqual(requests, [{ intent: 'inspect_assets', selection: { projectId: 1 } }, { intent: 'inspect_assets', selection: { projectId: 1 } }])
    assert.equal(JSON.stringify(initial.project), before)
    actions.assetInspectionOpen.value = true; actions.showAssetCategory('prop')
    assert.equal(actions.assetCategory.value, 'prop'); assert.equal(actions.activeTab.value, 'assets'); assert.equal(actions.assetInspectionOpen.value, false)
  } finally {
    app?.unmount(); dom.window.close()
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  }
})
test('the workbench theme action toggles the pinned composable and persists the visible theme', { skip: !existsSync(resolve(frontend, 'node_modules/@vue/compiler-sfc')) }, async () => {
  const { JSDOM } = await import('jsdom'), dom = new JSDOM('<div id="theme-fixture"></div>', { url: 'http://localhost' })
  const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'localStorage']
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let app, scope
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
    const require = createRequire(resolve(frontend, 'package.json')), Vue = require('vue')
    scope = Vue.effectScope()
    const themeSource = readFileSync(resolve(frontend, 'src/composables/useTheme.js'), 'utf8')
      .replace(/^import .*$/mg, '').replace('export function useTheme', 'function useTheme')
    const useTheme = scope.run(() => compileFunction(themeSource + '\nreturn useTheme', ['ref', 'watchEffect'])(Vue.ref, Vue.watchEffect))
    const { parse, compileScript } = require('@vue/compiler-sfc')
    const { descriptor } = parse(readFileSync(new URL('../extensions/muse-studio-workbench.vue', import.meta.url), 'utf8'))
    const compiled = compileScript(descriptor, { id: 'workbench-theme', genDefaultAs: '__component' })
    const controller = { loadProject: async () => {}, dispose() {}, dirty: () => false }
    const fixtures = { useTheme, useRoute: () => ({ params: { id: '1' }, query: {} }), useRouter: () => ({}),
      createStudioWorkbenchState, createStudioWorkbenchController: () => controller, studioAssetInspection,
      createMuseStudioBridge: () => ({ start() {}, stop() {} }) }
    const imports = Object.entries(compiled.imports)
    const dependencies = imports.map(([name, entry]) => entry.source === 'vue' ? Vue[entry.imported] : fixtures[name] || {})
    const Component = compileFunction(compiled.content.replace(/^import .*$/mg, '') + '\nreturn __component', imports.map(([name]) => name))(...dependencies)
    app = Vue.createApp({ setup() {
      const actions = Component.setup({}, { expose() {} })
      return () => Vue.h('button', { onClick: () => { void actions.moreAction('theme') } }, actions.isDark.value ? 'light' : 'dark')
    } })
    app.mount(dom.window.document.getElementById('theme-fixture')); await Vue.nextTick()
    const button = dom.window.document.querySelector('button')
    assert.equal(dom.window.document.documentElement.classList.contains('light'), true)
    button.click(); await Vue.nextTick()
    assert.equal(dom.window.document.documentElement.classList.contains('dark'), true)
    assert.equal(dom.window.localStorage.getItem('lmd-theme'), 'dark')
    assert.equal(button.textContent, 'light')
    button.click(); await Vue.nextTick()
    assert.equal(dom.window.document.documentElement.classList.contains('light'), true)
    assert.equal(dom.window.localStorage.getItem('lmd-theme'), 'light')
  } finally {
    app?.unmount(); scope?.stop(); dom.window.close()
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  }
})

test('asset categories separate equal IDs, react to project changes and keep exact image versions for binding', { skip: !existsSync(resolve(frontend, 'node_modules/@vue/compiler-sfc')) }, async () => {
  const { JSDOM } = await import('jsdom'), dom = new JSDOM('<div id="asset-category-fixture"></div>')
  const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement']
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let app
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
    const require = createRequire(resolve(frontend, 'package.json')), Vue = require('vue')
    const { parse, compileScript } = require('@vue/compiler-sfc')
    const { descriptor } = parse(readFileSync(new URL('../extensions/muse-studio-workbench.vue', import.meta.url), 'utf8'))
    const compiled = compileScript(descriptor, { id: 'workbench-asset-categories', genDefaultAs: '__component' })
    const initial = { ...createStudioWorkbenchState(), project: { id: 1, episodes: [],
      characters: [{ id: 7, name: '人物甲', image_url: '/static/character.png' }],
      scenes: [{ id: 7, location: '场景甲', image_url: '/static/scene.png' }], props: [] }, trace: trace() }
    const reference = kind => ({ ...clone(initial.trace.assets[0]), assetKind: kind, assetId: 7, name: kind,
      versions: [{ ...binding('old'), assetKind: kind, versionId: kind + '-version' }] })
    initial.trace.assets = ['prop', 'storyboard', 'character', 'scene'].map(reference)
    const before = JSON.stringify(initial.trace), selected = []
    const controller = { loadProject: async () => {}, dispose() {}, dirty: () => false,
      addBinding: (version, field) => selected.push({ version, field }) }
    const fixtures = { useTheme: () => ({ isDark: Vue.ref(false), toggle() {} }),
      useRoute: () => ({ params: { id: '1' }, query: {} }), useRouter: () => ({}),
      createStudioWorkbenchState: () => initial, createStudioWorkbenchController: () => controller, studioAssetInspection,
      createMuseStudioBridge: () => ({ start() {}, stop() {} }) }
    const imports = Object.entries(compiled.imports)
    const dependencies = imports.map(([name, entry]) => entry.source === 'vue' ? Vue[entry.imported] : fixtures[name] || {})
    const Component = compileFunction(compiled.content.replace(/^import .*$/mg, '') + '\nreturn __component', imports.map(([name]) => name))(...dependencies)
    let actions
    app = Vue.createApp({ setup() {
      actions = Component.setup({}, { expose() {} })
      return () => Vue.h('div', [Vue.h('nav', actions.projectAssetGroups.value.map(group => Vue.h('button', {
        'data-kind': group.kind, onClick: () => { actions.assetCategory.value = group.kind },
      }, group.label + ' ' + group.items.length))), Vue.h('section', { 'data-category': actions.selectedAssetGroup.value.kind },
        actions.selectedAssetGroup.value.items.length ? actions.selectedAssetGroup.value.items.map(item => item.name).join(',') : 'empty')])
    } })
    app.mount(dom.window.document.getElementById('asset-category-fixture')); await Vue.nextTick()
    assert.deepEqual([...dom.window.document.querySelectorAll('nav button')].map(button => button.textContent), ['人物 1', '场景 1', '道具 0'])
    assert.equal(dom.window.document.querySelector('section').textContent, '人物甲')
    dom.window.document.querySelector('[data-kind="scene"]').click(); await Vue.nextTick()
    assert.equal(dom.window.document.querySelector('section').textContent, '场景甲')
    dom.window.document.querySelector('[data-kind="prop"]').click(); await Vue.nextTick()
    assert.equal(dom.window.document.querySelector('section').textContent, 'empty')
    actions.state.project.props.push({ id: 7, name: '道具甲', local_path: 'prop.png' }); await Vue.nextTick()
    assert.equal(dom.window.document.querySelector('[data-kind="prop"]').textContent, '道具 1')
    assert.equal(dom.window.document.querySelector('section').textContent, '道具甲')
    assert.equal(actions.selectedAssetGroup.value.items[0].url, 'prop.png')
    assert.deepEqual(actions.bindingAssetGroups.value.map(group => group.kind), ['character', 'scene', 'prop', 'storyboard'])
    for (const group of actions.bindingAssetGroups.value) assert.equal(Vue.toRaw(group.items[0]), initial.trace.assets.find(asset => asset.assetKind === group.kind))
    const scene = actions.bindingAssetGroups.value.find(group => group.kind === 'scene').items[0]
    actions.assetSelections.scene7 = 'scene-version'; actions.bindSavedAsset(scene)
    assert.equal(selected[0].field, 'video')
    assert.equal(Vue.toRaw(selected[0].version), initial.trace.assets.find(asset => asset.assetKind === 'scene').versions[0])
    assert.equal(JSON.stringify(initial.trace), before)
    actions.state.trace.assets = []
    assert.deepEqual(actions.bindingAssetGroups.value.map(group => [group.kind, group.items.length]), [['character', 0], ['scene', 0], ['prop', 0]])
  } finally {
    app?.unmount(); dom.window.close()
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  }
})

test('editing inline references retains their identity, handles paste as text and exposes the exact captured image', { skip: !existsSync(resolve(frontend, 'node_modules/@vue/compiler-sfc')) }, async () => {
  const { JSDOM } = await import('jsdom'), dom = new JSDOM('<div id="fixture"></div>')
  const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement']
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let app
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
    const require = createRequire(resolve(frontend, 'package.json')), Vue = require('vue')
    const { parse, compileScript } = require('@vue/compiler-sfc')
    const source = readFileSync(new URL('../extensions/muse-studio-workbench-prompt.vue', import.meta.url), 'utf8')
    const { descriptor } = parse(source)
    const script = compileScript(descriptor, { id: 'prompt-editor', inlineTemplate: true, genDefaultAs: '__component' }).content
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, fields) => 'const {' + fields.replace(/\bas\b/g, ':') + '} = Vue')
      .replace(/^import .*$/mg, '')
    const Component = compileFunction(script + '\nreturn __component', ['Vue', 'museMediaUrl', 'studioPromptParts'])(Vue, value => '/studio' + value, studioPromptParts)
    const text = Vue.ref('走近 @asset(hero_old)'), references = Vue.ref([binding('old')]), disabled = Vue.ref(false), previews = []
    app = Vue.createApp({ setup: () => () => Vue.h(Component, { text: text.value, bindings: references.value, editable: true,
      disabled: disabled.value, label: '视频提示词', 'onUpdate:text': value => { text.value = value }, onPreview: value => previews.push(value) }) })
    app.mount(dom.window.document.getElementById('fixture')); await Vue.nextTick()
    const editor = dom.window.document.querySelector('[role="textbox"]'), chip = editor.querySelector('button')
    assert.equal(editor.textContent, '走近 林夏 · old')
    editor.append(dom.window.document.createTextNode('，转身'))
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await Vue.nextTick()
    assert.equal(text.value, '走近 @asset(hero_old)，转身')
    assert.equal(editor.querySelector('button'), chip)
    chip.click(); assert.equal(previews[0].mediaUrl, '/static/immutable/old.png')
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: type => type === 'text/plain' ? '<img src=x onerror=evil()>' : '<b>hostile HTML</b>' } })
    editor.dispatchEvent(paste); await Vue.nextTick()
    assert.ok(text.value.endsWith('<img src=x onerror=evil()>'))
    assert.equal(editor.querySelectorAll('img').length, 1)
    disabled.value = true; await Vue.nextTick(); assert.equal(editor.getAttribute('contenteditable'), 'false')
  } finally {
    app?.unmount(); dom.window.close()
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  }
})

test('the gallery and inline-reference components compile with the real Vue compiler', { skip: !existsSync(resolve(frontend, 'node_modules/@vue/compiler-sfc')) }, () => {
  const require = createRequire(resolve(frontend, 'package.json')), { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
  for (const name of ['muse-studio-workbench.vue', 'muse-studio-workbench-prompt.vue']) {
    const source = readFileSync(new URL('../extensions/' + name, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename: name }); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: name })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: name, id: name,
      compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  }
})
