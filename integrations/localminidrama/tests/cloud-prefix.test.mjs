/** Execute the pinned studio's URL, request, adoption and Vue paths without a supplier or live deployment. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { planCloudPrefix } from '../compatibility/cloud-prefix.mjs'
import { planMediaAdoption } from '../compatibility/media-adoption.mjs'
import { planMuseBranding } from '../compatibility/muse-branding.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const available = existsSync(resolve(root, 'frontweb/src/App.vue'))
const installed = existsSync(resolve(root, 'frontweb/node_modules/@vue/compiler-sfc'))
const originals = new Map()
const filename = path => resolve(root, path)
function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!originals.has(name)) originals.set(name, execFileSync('git', ['-C', root, 'show', `${revision}:${name}`],
    { encoding: 'utf8', maxBuffer: 3e6 }).replaceAll('\r\n', '\n'))
  return originals.get(name)
}
let preceding
function staged() {
  if (!preceding) {
    preceding = new Map(planMediaAdoption(root, pristine))
    for (const [path, source] of planMuseBranding(root, path => preceding.get(path) ?? pristine(path))) preceding.set(path, source)
  }
  return preceding
}
function planned() {
  return new Map(planCloudPrefix(root, path => staged().get(path) ?? pristine(path)))
}
function helper(base) {
  const source = planned().get(filename('frontweb/src/utils/museStudioPath.js'))
    .replace('import.meta.env.BASE_URL', JSON.stringify(base)).replaceAll('export ', '')
  return runInContext(source + '\n({museStudioPath,museMediaUrl,museModelReferenceUrl,museNativeMediaUrl})',
    createContext({ URL, window: { location: { origin: 'https://muse.fixture.test' } } }))
}
function load(file, bindings, exports) {
  const source = planned().get(filename(file)) ?? staged().get(filename(file)) ?? pristine(filename(file))
  return runInContext(source.replace(/^import .*\n/gm, '').replace(/^export default .*$/gm, '').replaceAll('export ', '')
    + `;\n({${exports.join(',')}})`, createContext(bindings))
}
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start, name)
  return source.slice(start, end)
}

test('prefix planner composes with staged branding and adoption and rejects repeats or changed anchors', { skip: !available }, () => {
  const changes = planned()
  assert.equal(changes.size, 16)
  assert.match(changes.get(filename('frontweb/index.html')), /<title>Muse · 制作平台<\/title>/)
  assert.match(changes.get(filename('frontweb/src/views/FilmList.vue')), /class="logo-main">Muse<\/span>/)
  assert.doesNotMatch(changes.get(filename('frontweb/src/views/FilmList.vue')), /showWechat/)
  assert.ok(!changes.has(filename('frontweb/src/components/AIConfigContent.vue')))
  assert.throws(() => helper('https://cdn.fixture.test/'), /root-relative Vite base/)
  const read = path => staged().get(path) ?? pristine(path)
  assert.throws(() => planCloudPrefix(root, path => changes.get(path) ?? read(path)), /pinned source/)
  for (const [file, anchor] of [['frontweb/src/utils/request.js', "baseURL: '/api/v1'"],
    ['frontweb/src/views/FilmCreate.vue', 'function toAbsoluteImageUrl(url)'],
    ['frontweb/src/views/FilmList.vue', 'a.href = `/api/v1/dramas/${d.id}/export`'],
    ['frontweb/src/App.vue', 'assistant-launcher'], ['frontweb/src/api/agent.js', 'async function readError']]) {
    assert.throws(() => planCloudPrefix(root, path => path === filename(file) ? read(path).replace(anchor, 'changed fixture') : read(path)), /pinned source/)
  }
})

for (const base of ['/', '/studio/']) {
  test(`request and media helpers respect ${base} without changing external or persisted addresses`, { skip: !available }, () => {
    const h = helper(base), media = base + 'static/projects/1/shot.png'
    assert.equal(h.museStudioPath('/api/v1'), base + 'api/v1')
    assert.equal(h.museStudioPath('/api/v1/upload/image'), base + 'api/v1/upload/image')
    assert.equal(h.museStudioPath('/style-thumbs/anime.jpg'), base + 'style-thumbs/anime.jpg')
    for (const path of ['projects/1/shot.png', '/static/projects/1/shot.png', 'static/projects/1/shot.png']) assert.equal(h.museMediaUrl(path), media)
    assert.equal(h.museMediaUrl(media), media)
    assert.equal(h.museModelReferenceUrl(media), media)
    assert.equal(h.museNativeMediaUrl(media), '/static/projects/1/shot.png')
    assert.equal(h.museNativeMediaUrl('https://muse.fixture.test' + media), base === '/' ? 'https://muse.fixture.test' + media : '/static/projects/1/shot.png')
    for (const url of ['https://supplier.fixture.test/static/output.png?signature=fixture', 'https://supplier.fixture.test/studio/static/output.png',
      'data:image/png;base64,fixture', 'blob:https://muse.fixture.test/preview', 'http://']) {
      assert.equal(h.museMediaUrl(url), url)
      assert.equal(h.museNativeMediaUrl(url), url)
    }
    assert.equal(h.museStudioPath('https://muse.fixture.test/static/shot.png?x=1'), 'https://muse.fixture.test' + base + 'static/shot.png?x=1')
    assert.equal(h.museMediaUrl('  '), '')
    assert.equal(h.museStudioPath('/api/business/v1/assets'), '/api/business/v1/assets')
  })

  test(`retained media prefixes render the same file under ${base} without changing source records`, { skip: !available }, () => {
    const h = helper(base), image = 'libtv-cli/media/4b1516a9a0e5d8e8f6dad909ab81bd79346732e2b9cc62b32a2bb31887848f6c.png'
    const records = { binding: '/studio/static/' + image, reference: '/static/studio/static/' + image,
      currentPoster: 'studio/static/' + image, video: '/studio/static/history/original.mp4' }
    const before = JSON.stringify(records), media = load('frontweb/src/utils/mediaUrl.js', h, ['assetImageUrl', 'storyboardVideoUrl'])
    for (const value of [records.binding, records.reference, records.currentPoster]) {
      assert.equal(h.museMediaUrl(value), base + 'static/' + image)
      assert.equal(h.museModelReferenceUrl(value), base + 'static/' + image)
      assert.equal(h.museNativeMediaUrl(value), '/static/' + image)
    }
    assert.equal(media.assetImageUrl({ image_url: records.currentPoster }), base + 'static/' + image)
    assert.equal(media.storyboardVideoUrl({ video_url: records.video }), base + 'static/history/original.mp4')
    assert.equal(h.museMediaUrl('https://muse.fixture.test' + records.binding + '?saved=1#frame'),
      'https://muse.fixture.test' + base + 'static/' + image + '?saved=1#frame')
    const foreign = 'https://supplier.fixture.test' + records.binding
    assert.equal(h.museMediaUrl(foreign), foreign)
    assert.equal(h.museNativeMediaUrl(foreign), foreign)
    assert.equal(JSON.stringify(records), before)
  })

  test(`actual axios, streaming, export and TTS request paths respect ${base}`, { skip: !available }, async () => {
    const h = helper(base), requests = []
    let config
    load('frontweb/src/utils/request.js', { ...h, axios: { create(value) {
      config = value; return { interceptors: { response: { use() {} } } }
    } }, ElMessage: { error() {} } }, [])
    assert.equal(config.baseURL, base + 'api/v1')
    const stream = load('frontweb/src/api/storyboards.js', { ...h, TextDecoder,
      fetch: async (url, options) => { requests.push({ url, options }); return new Response('{"type":"done","universal_segment_text":"fixture"}\n') },
      request: {},
    }, ['storyboardsAPI'])
    await stream.storyboardsAPI.generateUniversalSegmentPromptStream(7, { duration: 6 })
    await stream.storyboardsAPI.polishUniversalSegmentPromptStream(7, { duration: 6 })
    assert.equal(requests[0].url, base + 'api/v1/storyboards/7/universal-segment-prompt-stream')
    assert.equal(requests[1].url, base + 'api/v1/storyboards/7/universal-segment-polish-stream')
    assert.equal(JSON.parse(requests[0].options.body).duration, 6)
    const create = planned().get(filename('frontweb/src/views/FilmCreate.vue'))
    const audio = createContext({ ...h, ttsSbIds: new Set(), ttsSbNarrationIds: new Set(), sbNarration: { value: {} },
      sbDialogueAudioPaths: { value: {} }, sbNarrationAudioPaths: { value: {} }, ElMessage: { success() {}, error() {}, warning() {} },
      fetch: async url => { requests.push({ url }); return Response.json({ success: true, data: { local_path: 'projects/1/voice.mp3' } }) },
    })
    for (const name of ['onTtsSbDialogue', 'onTtsSbNarration']) {
      runInContext('async ' + functionSource(create, name), audio)
      await runInContext(`${name}({id:7,dialogue:'fixture',narration:'fixture'})`, audio)
    }
    assert.deepEqual(requests.slice(2).map(item => item.url), [base + 'api/v1/audio/extract', base + 'api/v1/audio/extract'])
    assert.equal(runInContext('sbDialogueAudioPaths.value[7]', audio), 'projects/1/voice.mp3')
    let exported
    const anchor = { click() { exported = this.href } }
    runInContext(functionSource(planned().get(filename('frontweb/src/views/FilmList.vue')), 'onExport') + '\nonExport({id:7})',
      createContext({ ...h, exportingId: { value: null }, document: { createElement: () => anchor, body: { appendChild() {}, removeChild() {} } }, ElMessage: { success() {}, error() {} } }))
    assert.equal(exported, base + 'api/v1/dramas/7/export')
  })

  test(`adopted history keeps native asset fields while previews and references respect ${base}`, { skip: !available }, () => {
    const h = helper(base)
    const media = load('frontweb/src/utils/mediaUrl.js', h, ['assetImageUrl', 'storyboardVideoUrl', 'audioUrl'])
    const story = load('frontweb/src/utils/storyboardMedia.js', { ...h, ...media, parseDramaMetadata: () => ({}) },
      ['adoptedMediaPath', 'resolveSbVideoRecord', 'videoRecordUrl', 'resolveSbMainImageRecord', 'imageRecordUrl'])
    const original = { id: 4, status: 'completed', image_url: '/static/projects/1/shot.png', local_path: 'projects/1/shot.png' }
    const sb = { id: 7, image_url: original.image_url, local_path: original.local_path }
    const adopted = story.resolveSbMainImageRecord(sb, { 7: [original] })
    assert.equal(adopted, original)
    assert.equal(story.imageRecordUrl(adopted), base + 'static/projects/1/shot.png')
    assert.equal(adopted.image_url, '/static/projects/1/shot.png')
    assert.equal(adopted.local_path, 'projects/1/shot.png')
    assert.equal(story.adoptedMediaPath(base + 'static/projects/1/shot.png'), 'projects/1/shot.png')
    assert.equal(media.assetImageUrl({ local_path: ' ', image_url: original.image_url }), base + 'static/projects/1/shot.png')
    assert.equal(media.storyboardVideoUrl({ video_url: '/static/projects/1/clip.mp4' }), base + 'static/projects/1/clip.mp4')
    assert.equal(media.audioUrl('projects/1/voice.mp3'), base + 'static/projects/1/voice.mp3')
    const create = planned().get(filename('frontweb/src/views/FilmCreate.vue'))
    for (const name of ['onSelectSbFrameImage', 'onSelectSbMainVideo', 'doUploadResourceImage']) assert.equal(functionSource(create, name),
      functionSource(staged().get(filename('frontweb/src/views/FilmCreate.vue')), name))
    const free = planned().get(filename('frontweb/src/views/FreeCreate.vue'))
    assert.ok(free.includes("body.image_url = '/static/' + refImageLocalPath.value"))
    const workflow = load('frontweb/src/utils/canvasWorkflow.js', { ...h, parseDramaMetadata: () => ({}) }, ['toAbsoluteMediaUrl'])
    assert.equal(workflow.toAbsoluteMediaUrl(original.image_url), base + 'static/projects/1/shot.png')
  })
}

test('the standalone chat has no launcher, mounted drawer or agent network adapter', { skip: !available }, async () => {
  const changes = planned(), app = changes.get(filename('frontweb/src/App.vue'))
  assert.doesNotMatch(app, /AgentDrawer|assistant-launcher|dramaId|useRoute/)
  assert.match(app, /<router-view \/>/)
  const agent = load('frontweb/src/api/agent.js', {}, ['agentAPI'])
  for (const method of ['history', 'chat', 'approve', 'decline']) await assert.rejects(agent.agentAPI[method](), /Muse 主对话/)
  assert.doesNotMatch(changes.get(filename('frontweb/src/api/agent.js')), /fetch\(|request\.|\/agent\//)
})

test('all patched Vue pages compile with retained navigation and provider configuration', { skip: !installed }, () => {
  const require = createRequire(filename('frontweb/package.json'))
  const { parse, compileScript, compileTemplate, compileStyle } = require('@vue/compiler-sfc')
  for (const [path, source] of planned()) {
    if (!path.endsWith('.vue')) continue
    const { descriptor, errors } = parse(source, { filename: path })
    assert.deepEqual(errors, [], path)
    const script = descriptor.scriptSetup ? compileScript(descriptor, { id: 'muse-prefix-fixture' }) : undefined
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: path, id: 'muse-prefix-fixture',
      compilerOptions: { bindingMetadata: script?.bindings } }).errors, [], path)
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename: path,
      id: 'muse-prefix-fixture', scoped: style.scoped }).errors, [], path)
  }
  assert.match(pristine(filename('frontweb/src/router/index.js')), /createWebHistory\(import\.meta\.env\.BASE_URL\)/)
  assert.ok(!planned().has(filename('frontweb/src/components/AIConfigContent.vue')))
})

test('Vite produces separate root and studio distributions from the same source without publishing either', { skip: !installed }, async t => {
  const require = createRequire(filename('frontweb/package.json'))
  const { build } = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href)
  const { default: vue } = await import(pathToFileURL(join(dirname(require.resolve('@vitejs/plugin-vue')), 'index.mjs')).href)
  const home = mkdtempSync(join(tmpdir(), 'muse-prefix-build-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  cpSync(filename('frontweb/src'), join(home, 'src'), { recursive: true })
  cpSync(filename('frontweb/public'), join(home, 'public'), { recursive: true })
  symlinkSync(filename('frontweb/node_modules'), join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(home, 'package.json'), '{"type":"module"}\n')
  const changes = new Map([...staged(), ...planned()])
  for (const [path, source] of changes) {
    const name = relative(filename('frontweb'), path)
    if (name.startsWith('..')) continue
    const target = join(home, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source)
  }
  for (const base of ['/', '/studio/']) {
    const outDir = join(home, base === '/' ? 'dist-root' : 'dist-studio')
    await build({ root: home, base, configFile: false, logLevel: 'silent', plugins: [vue()],
      resolve: { alias: { '@': join(home, 'src') } },
      build: { outDir },
    })
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    assert.ok(html.includes(`src="${base}assets/`))
    assert.ok(html.includes(`href="${base}favicon.svg"`))
    assert.match(html, /Muse · 制作平台/)
  }
})
