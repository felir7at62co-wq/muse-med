/** Validate Muse branding against the pinned Vue pages without publishing generated assets. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { museBrandingRemovals, planMuseBranding } from '../compatibility/muse-branding.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const available = existsSync(resolve(root, 'frontweb/src/views/FilmList.vue'))
const compiled = existsSync(resolve(root, 'frontweb/node_modules/@vue/compiler-sfc'))
const originals = new Map()
const filename = name => resolve(root, name)
function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!originals.has(name)) originals.set(name,
    execFileSync('git', ['-C', root, 'show', `${revision}:${name}`], { encoding: 'utf8', maxBuffer: 2e6 }).replaceAll('\r\n', '\n'))
  return originals.get(name)
}
function sources() {
  return new Map(planMuseBranding(root, pristine))
}

test('branding planner rejects changed or repeated targets and retains unrelated staged edits', { skip: !available }, () => {
  const planned = sources()
  assert.equal(planned.size, 8)
  const marker = '<!-- staged Muse fixture -->\n'
  for (const [, source] of planMuseBranding(root, path => marker + pristine(path))) assert.ok(source.startsWith(marker))
  assert.throws(() => planMuseBranding(root, path => planned.get(path) ?? pristine(path)), /pinned source/)
  const anchors = [
    ['frontweb/index.html', '<title>本地短剧助手 - AI 短剧生成工具</title>'],
    ['frontweb/src/router/index.js', 'document.title = `${to.meta.title} - LocalMiniDrama`'],
    ...['AiConfig', 'DramaDetail', 'FilmCreate', 'FilmList', 'DramaCanvas'].map(view =>
      [`frontweb/src/views/${view}.vue`, '<span class="logo-main">本地短剧助手</span>']),
    ['frontweb/src/components/AIConfigContent.vue', '适合练手与流水剧制作，价格便宜，一次约 1 元，不按秒计费。'],
    ['frontweb/src/views/FilmList.vue', '<img src="/wx.jpg"'],
  ]
  for (const [file, anchor] of anchors) {
    const target = filename(file)
    assert.ok(pristine(target).includes(anchor))
    assert.throws(() => planMuseBranding(root, path => path === target
      ? pristine(path).replace(anchor, 'changed fixture') : pristine(path)), /pinned source/, file)
  }
  assert.throws(() => planMuseBranding(root, path => path === filename('frontweb/index.html')
    ? pristine(path) + '<title>本地短剧助手 - AI 短剧生成工具</title>' : pristine(path)), /pinned source/)
})

test('all page headings and route titles use Muse and leave copyright files untouched', { skip: !available }, () => {
  const planned = sources()
  assert.match(planned.get(filename('frontweb/index.html')), /<title>Muse · 制作平台<\/title>/)
  for (const [path, source] of planned) {
    assert.doesNotMatch(source, /LocalMiniDrama|本地短剧助手/)
    assert.ok(path.startsWith(filename('frontweb') + sep))
    assert.doesNotMatch(path, /LICENSE|COPYING|NOTICE/)
    if (path.endsWith('.vue') && path.includes(`${sep}views${sep}`)) assert.match(source, /class="logo-main">Muse<\/span>/)
  }
  const document = { title: '' }
  let beforeEach
  const router = { beforeEach(callback) { beforeEach = callback } }
  const source = planned.get(filename('frontweb/src/router/index.js'))
    .replace(/^import .*\n/, '').replace('import.meta.env.BASE_URL', "'/'").replace('export default router', '')
  runInContext(source, createContext({ document, createRouter: () => router, createWebHistory: base => base }))
  assert.equal(beforeEach({ meta: { title: '项目列表' } }), true)
  assert.equal(document.title, '项目列表 - Muse')
  assert.equal(beforeEach({ meta: { title: '画布模式' } }), true)
  assert.equal(document.title, '画布模式 - Muse')
  assert.match(pristine(filename('LICENSE')), /Copyright \(c\) 2026 xuanyustudio/)
})

test('author contact and sales promotion disappear while provider configuration and documentation remain', { skip: !available }, () => {
  const planned = sources()
  for (const [, source] of planned) assert.doesNotMatch(source,
    /微信|二维码|扫码联系|showWechat|btn-wechat|ChatDotSquare|\/wx\.jpg|充值|低价|价格便宜|约 1 元|新用户有免费|不推荐|<b>推荐<\/b>/)
  const config = planned.get(filename('frontweb/src/components/AIConfigContent.vue'))
  assert.doesNotMatch(config, /href="https:\/\/workbench\.ohmybb\.xyz\/"/)
  assert.match(config, /href="https:\/\/workbench\.ohmybb\.xyz\/docs\/api"/)
  assert.match(config, /https:\/\/workbench\.ohmybb\.xyz\/api\/openai/)
  assert.match(config, /id: 'cheap_seedance2'/)
  assert.match(config, /name: 'Seedance2（Sora 兼容）'/)
  assert.match(config, /<el-option label="语音合成 TTS" value="tts"/)
  for (const name of ['openAdd', 'exportConfigs', 'triggerImport', 'openOneKeyVolc', 'openOneKeyAgnes', 'openOneKeyTongyi', 'openOneKeyCheapSeedance2']) {
    assert.ok(config.includes(`@click="${name}"`), name)
  }
  assert.deepEqual(museBrandingRemovals.map(({ path }) => path), ['frontweb/public/wx.jpg'])
  for (const asset of museBrandingRemovals) {
    const bytes = execFileSync('git', ['-C', root, 'show', `${revision}:${asset.path}`])
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    for (const [, source] of planned) assert.ok(!source.includes('/' + asset.path.split('/').at(-1)))
  }
})

test('patched Vue pages compile and retain every business action and input binding', { skip: !available || !compiled }, () => {
  const require = createRequire(filename('frontweb/package.json'))
  const { parse, compileScript, compileStyle, compileTemplate } = require('@vue/compiler-sfc')
  const { parse: parseTemplate } = require('@vue/compiler-dom')
  function bindings(template) {
    const found = []
    const visit = node => {
      for (const prop of node.props ?? []) {
        if (prop.type !== 7 || !['on', 'model'].includes(prop.name)) continue
        const expression = prop.exp?.content
        if (expression === 'showWechat = true' || expression === 'showWechat') continue
        found.push(JSON.stringify([prop.name, prop.arg?.content, expression, prop.modifiers.map(modifier => modifier.content)]))
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(parseTemplate(template))
    return found.sort()
  }
  for (const [path, source] of sources()) {
    if (!path.endsWith('.vue')) continue
    const { descriptor, errors } = parse(source, { filename: path })
    assert.deepEqual(errors, [], path)
    const script = compileScript(descriptor, { id: 'muse-branding-fixture' })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: path,
      id: 'muse-branding-fixture', compilerOptions: { bindingMetadata: script.bindings } }).errors, [], path)
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content,
      filename: path, id: 'muse-branding-fixture', scoped: style.scoped }).errors, [], path)
    const previous = parse(pristine(path), { filename: path }).descriptor
    assert.deepEqual(bindings(descriptor.template.content), bindings(previous.template.content), path)
    if (path.endsWith('AIConfigContent.vue')) assert.equal(descriptor.scriptSetup.content,
      previous.scriptSetup.content.replaceAll('低价 Seedance2', 'Seedance2（Sora 兼容）'))
  }
})
