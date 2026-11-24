/** Serve the pinned production studio at either its local root or an authenticated Muse path prefix. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replace(source, before, after, file, count = 1) {
  if (source.split(before).length - 1 !== count) throw new Error(`Muse studio prefix patch does not match pinned source: ${file}`)
  return source.replaceAll(before, after)
}
function replaceFunction(source, name, digest, after, file) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2
  const before = source.slice(start, end)
  if (start < 0 || end < 2 || createHash('sha256').update(before).digest('hex') !== digest) {
    throw new Error(`Muse studio prefix patch does not match pinned source: ${file}:${name}`)
  }
  return replace(source, before, after, file)
}

const pathHelper = `/** Studio request and presentation URLs; never persist these derived addresses into asset records. */
const base = import.meta.env.BASE_URL
if (!/^\\/(?:[A-Za-z0-9_-]+\\/)*$/.test(base)) throw new Error('Muse studio requires a root-relative Vite base')
const nativePath = path => /^\\/(?:api\\/v1(?:[/?#]|$)|static(?:[/?#]|$)|style-thumbs(?:[/?#]|$))/.test(path)
function parseAddress(value) {
  try { return new URL(value) } catch (error) { return null }
}

/** Prefix only this studio's request and public-resource paths, preserving external addresses. */
export function museStudioPath(value) {
  if (value == null) return ''
  const text = String(value).trim()
  if (!text || base === '/') return text
  if (/^https?:\\/\\//i.test(text)) {
    const url = parseAddress(text)
    if (!url || typeof window === 'undefined' || url.origin !== window.location.origin || !nativePath(url.pathname)) return text
    url.pathname = base + url.pathname.slice(1)
    return url.href
  }
  if (text.startsWith(base) || !nativePath(text)) return text
  return base + text.slice(1)
}

/** Resolve a stored media URL or local storage path for preview, playback or a temporary generation reference. */
export function museMediaUrl(value) {
  if (value == null) return ''
  const text = String(value).trim()
  if (!text) return ''
  if (/^[a-z][a-z\\d+.-]*:/i.test(text) || text.startsWith('//')) return museStudioPath(text)
  if (base !== '/' && text.startsWith(base)) return text
  if (text.startsWith('/static/') || text.startsWith('static/')) return museStudioPath('/' + text.replace(/^\\/+/, ''))
  return museStudioPath('/static/' + text.replace(/^\\/+/, ''))
}

/** Keep local references relative for the owning backend's inline/upload path; external URLs retain their origin. */
export function museModelReferenceUrl(value) {
  return museMediaUrl(value)
}

/** Recover a native static path only from this origin's rendered prefix for adopted-media matching. */
export function museNativeMediaUrl(value) {
  if (value == null) return ''
  const text = String(value).trim()
  if (base === '/') return text
  if (/^https?:\\/\\//i.test(text)) {
    const url = parseAddress(text)
    if (!url || typeof window === 'undefined' || url.origin !== window.location.origin) return text
    if (url.pathname.startsWith(base + 'static/')) return '/' + url.pathname.slice(base.length) + url.search + url.hash
    return text
  }
  return text.startsWith(base + 'static/') ? '/' + text.slice(base.length) : text
}
`

/**
 * Plan prefix-safe requests, rendered media and removal of the standalone agent entry.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Latest staged source after the existing adoption and branding planners.
 * @returns Complete replacement sources without modifying the checkout or stored asset fields.
 */
export function planCloudPrefix(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, transform) => {
    const path = resolve(root, file)
    pending.push([path, transform(readSource(path).replaceAll('\r\n', '\n'), file)])
  }
  const helperPath = resolve(root, 'frontweb/src/utils/museStudioPath.js')
  if (existsSync(helperPath)) throw new Error('Muse studio prefix helper already exists; use a pristine pinned checkout')
  pending.push([helperPath, pathHelper])
  const importHelper = (source, names, file) => replace(source, '<script setup>\n',
    `<script setup>\nimport { ${names} } from '@/utils/museStudioPath'\n`, file)
  patch('frontweb/src/utils/request.js', (source, file) => replace(
    "import { museStudioPath } from './museStudioPath'\n" + source,
    "baseURL: '/api/v1'", "baseURL: museStudioPath('/api/v1')", file))
  patch('frontweb/src/api/storyboards.js', (source, file) => replace(
    "import { museStudioPath } from '@/utils/museStudioPath'\n" + source, 'return fetch(url, {', 'return fetch(museStudioPath(url), {', file))
  patch('frontweb/src/utils/mediaUrl.js', (source, file) => {
    source = "import { museMediaUrl } from './museStudioPath'\n" + source
    source = replaceFunction(source, 'assetImageUrl', '2c6d9258caab013d427dbb94d7a23ada2e442807c80f5c8e0ac61795db0458b3',
      "function assetImageUrl(item) {\n  if (!item) return ''\n  return museMediaUrl(typeof item === 'string' ? item : String(item.local_path || '').trim() || item.image_url)\n}", file)
    source = replaceFunction(source, 'storyboardVideoUrl', '4b2788efddf7729494da036c9c1e4a55f78ce65856424011976d130a574391bd',
      "function storyboardVideoUrl(sb) {\n  return sb ? museMediaUrl(String(sb.video_local_path || '').trim() || sb.video_url) : ''\n}", file)
    return replaceFunction(source, 'audioUrl', '66849e6b77bc67187935ab5a77b2703be203163a8bcf04cb27a262f26a9725a8',
      "function audioUrl(localPath) {\n  return museMediaUrl(localPath)\n}", file)
  })
  patch('frontweb/src/utils/storyboardMedia.js', (source, file) => {
    source = "import { museMediaUrl, museNativeMediaUrl } from './museStudioPath'\n" + source
    source = replace(source, "let text = value == null ? '' : String(value).trim().replace(/\\\\/g, '/')",
      "let text = museNativeMediaUrl(value).replace(/\\\\/g, '/')", file)
    return replaceFunction(source, 'videoRecordUrl', '6cf050a619a66da8a270a8fe32c195c57aaeab5ef923f63fe1a863878b26c4fd',
      "function videoRecordUrl(record) {\n  return record ? museMediaUrl(String(record.local_path || '').trim() || record.video_url) : ''\n}", file)
  })
  patch('frontweb/src/utils/canvasWorkflow.js', (source, file) => replaceFunction(
    "import { museModelReferenceUrl } from './museStudioPath'\n" + source, 'toAbsoluteMediaUrl',
    'd90f73e79ff525c2793a9f5ea2a5d0a2c456f3eda9719a362f0dbc9584d93eb5',
    "function toAbsoluteMediaUrl(url) {\n  return museModelReferenceUrl(url)\n}", file))
  for (const [view, hash] of [['FilmList', '6e9f616d68f45690e512849ad95f625af4cd9d2326c7c30ebfe7ab892111fa6d'],
    ['DramaDetail', '2c6d9258caab013d427dbb94d7a23ada2e442807c80f5c8e0ac61795db0458b3']]) {
    patch(`frontweb/src/views/${view}.vue`, (source, file) => {
      if (view === 'FilmList') source = importHelper(source, 'museStudioPath', file)
      source = replace(source, '<script setup>\n', "<script setup>\nimport { assetImageUrl as museAssetImageUrl } from '@/utils/mediaUrl'\n", file)
      source = replaceFunction(source, 'assetImageUrl', hash, 'function assetImageUrl(item) {\n  return museAssetImageUrl(item)\n}', file)
      if (view === 'FilmList') source = replace(source, 'a.href = `/api/v1/dramas/${d.id}/export`',
        'a.href = museStudioPath(`/api/v1/dramas/${d.id}/export`)', file)
      return source
    })
  }
  patch('frontweb/src/views/FilmCreate.vue', (source, file) => {
    source = importHelper(source, 'museStudioPath, museMediaUrl, museModelReferenceUrl', file)
    source = replace(source, '<script setup>\n', "<script setup>\nimport { assetImageUrl as museAssetImageUrl } from '@/utils/mediaUrl'\n", file)
    for (const [name, hash, body] of [
      ['imageUrl', '9befa9d469dd165e0c740129d634a5b815443841006dab99034660f90cf18466', 'return museMediaUrl(url)'],
      ['assetImageUrl', 'b7dfe1ae7cc69d4a73099898e6c1b76618618e2b4fda0fb82b846a291d219e0d', 'return museAssetImageUrl(item)'],
      ['assetVideoUrl', '144a7483e4657610d2a1c8122a8b212bd6afa6978c50266c2152ffe3279fdf4b', "return item ? museMediaUrl(String(item.local_path || '').trim() || item.video_url) : ''"],
      ['localPathToUrl', '1439d4b7f18edb11cff3f21cd863cd1965633e09f2e5343198418764437fadc6', 'return museMediaUrl(p)'],
      ['toAbsoluteImageUrl', '73bbb0e60b0955aa0398e21ade77d04da3fc9bed7fb87cbf9374f81c48ed2708', 'return museModelReferenceUrl(url)'],
    ]) {
      const parameter = name === 'localPathToUrl' ? 'p' : name === 'imageUrl' || name === 'toAbsoluteImageUrl' ? 'url' : 'item'
      source = replaceFunction(source, name, hash, `function ${name}(${parameter}) {\n  ${body}\n}`, file)
    }
    source = replace(source, "const baseUrl = ref('')\n", '', file)
    source = replace(source, '/** 转为视频接口可请求的绝对 URL（后端/第三方需能访问） */',
      '/** 本服务参考保留相对路径供后端读取；外部参考保留原始来源。 */', file)
    source = replace(source, "  if (!url || !String(url).trim()) return ''\n  const s = String(url).trim()\n  if (s.startsWith('http://') || s.startsWith('https://')) return s\n  return '/static/' + s.replace(/^\\//, '')",
      '  return museMediaUrl(url)', file)
    for (const entity of ['Character', 'Prop', 'Scene']) source = replace(source,
      `edit${entity}Form.ref_image.startsWith('http') ? edit${entity}Form.ref_image : '/static/' + edit${entity}Form.ref_image`,
      `museMediaUrl(edit${entity}Form.ref_image)`, file)
    source = replace(source, "default.defaults.baseURL || '/api/v1'", "default.defaults.baseURL || museStudioPath('/api/v1')", file)
    source = replace(source, 'const url = `/static/${rel}`', 'const url = museMediaUrl(rel)', file)
    return replace(source, "fetch('/api/v1/audio/extract', {", "fetch(museStudioPath('/api/v1/audio/extract'), {", file, 2)
  })
  patch('frontweb/src/views/MediaLibrary.vue', (source, file) => replaceFunction(importHelper(source, 'museMediaUrl', file),
    'itemUrl', 'b761c984a4a5d11495e96630a531fd2da7dd77f3dbd4dab5667c11e2b69db951',
    "function itemUrl(item) {\n  return item ? museMediaUrl(item.local_path || item.image_local_path || item.video_local_path || item.url || item.image_url || item.video_url) : ''\n}", file))
  patch('frontweb/src/views/FreeCreate.vue', (source, file) => {
    source = importHelper(source, 'museMediaUrl', file)
    source = replace(source, ':src="item.url"', ':src="museMediaUrl(item.url)"', file, 2)
    source = replace(source, ':src="previewUrl"', ':src="museMediaUrl(previewUrl)"', file)
    return replace(source, 'a.href = item.url', 'a.href = museMediaUrl(item.url)', file)
  })
  patch('frontweb/src/components/StylePickerButton.vue', (source, file) => replace(importHelper(source, 'museStudioPath', file),
    ':src="opt.thumb"', ':src="museStudioPath(opt.thumb)"', file))
  patch('frontweb/src/composables/filmCreate/useCharacters.js', (source, file) => replace(
    "import { museMediaUrl } from '@/utils/museStudioPath'\n" + source, 'const audio = new Audio(url)', 'const audio = new Audio(museMediaUrl(url))', file))
  patch('frontweb/index.html', (source, file) => replace(source, 'href="/favicon.svg"', 'href="%BASE_URL%favicon.svg"', file))
  patch('frontweb/src/App.vue', (source, file) => {
    if (createHash('sha256').update(source).digest('hex') !== 'd19cd9ee70de4ad80969baae2097fa791137da027d7531967e87f866045e208b') {
      throw new Error(`Muse studio prefix patch does not match pinned source: ${file}`)
    }
    source = source.replace(/    <button v-if="dramaId"[^\n]*\n    <AgentDrawer[^\n]*\n/, '')
      .replace(/<script setup>[\s\S]*?<\/script>\n\n/, '')
      .replace(/\.assistant-launcher \{[\s\S]*?\n\}\n/, '')
    return source
  })
  patch('frontweb/src/api/agent.js', (source, file) => {
    if (createHash('sha256').update(source).digest('hex') !== 'ade76063d3038aeba4ce3d0fb6e06a5554f397e09530dc2b9e24c3574cb4068c') {
      throw new Error(`Muse studio prefix patch does not match pinned source: ${file}`)
    }
    return `/** The integrated studio uses Muse's main conversation instead of a second agent runtime. */
export async function streamAgent() { throw new Error('请使用 Muse 主对话') }
export const agentAPI = { history: streamAgent, chat: streamAgent, approve: streamAgent, decline: streamAgent }
`
  })
  return pending
}
