/** Keep persisted storyboard media choices ahead of newly completed history. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after, file) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama media adoption patch does not match pinned source: ${file}`)
  }
  return source.replace(before, after)
}

function replaceFunction(source, name, expected, replacement, file) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf('\n}', start) + 2
  const before = source.slice(start, end)
  if (start < 0 || end < 2 || createHash('sha256').update(before).digest('hex') !== expected) {
    throw new Error(`LocalMiniDrama media adoption patch does not match pinned source: ${file}:${name}`)
  }
  return replaceOnce(source, before, replacement, file)
}

const helpers = `
/** Resolve static URLs and storage paths; return an empty string for other values. */
export function adoptedMediaPath(value) {
  let text = value == null ? '' : String(value).trim().replace(/\\\\/g, '/')
  if (/^https?:\\/\\//i.test(text)) {
    let parsed
    try { parsed = new URL(text) } catch (error) { return '' }
    const pathname = parsed.pathname
    if (!pathname.startsWith('/static/')) return ''
    text = pathname
  }
  if (/^[a-z][a-z\\d+.-]*:/i.test(text)) return ''
  const path = text.replace(/^\\/?static\\//, '').replace(/^\\/+/, '')
  return path && !/[?#\\0]/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..') ? path : ''
}

/** Unique adopted URLs override stale IDs; reused URLs require a matching path or generation. */
function adoptedImageRecord(images, imageUrl, localPath, frameType, imageId) {
  const url = imageUrl == null ? '' : String(imageUrl).trim()
  const path = localPath == null ? '' : String(localPath).trim()
  if (!url && !path) return null
  if (url) {
    const selectedPath = adoptedMediaPath(url)
    if (selectedPath) {
      const byPath = images.find((image) => adoptedMediaPath(image.local_path) === selectedPath)
      if (byPath) return byPath
      return { image_url: url, local_path: selectedPath, frame_type: frameType }
    }
    const matches = images.filter((image) => image.image_url === url)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      const local = adoptedMediaPath(path)
      const byPath = local && matches.find((image) => adoptedMediaPath(image.local_path) === local)
      if (byPath) return byPath
      const byId = imageId != null && matches.find((image) => image.id === imageId)
      if (byId) return byId
    }
    return { image_url: url, local_path: null, frame_type: frameType }
  }
  const selectedPath = adoptedMediaPath(path)
  if (!selectedPath) return { image_url: path, local_path: null, frame_type: frameType }
  const matched = images.find((image) => adoptedMediaPath(image.local_path) === selectedPath)
  return matched || { image_url: null, local_path: selectedPath || null, frame_type: frameType }
}
`;

/**
 * Plan frontend media-choice corrections without writing source files.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read the latest staged source at an absolute path.
 * @returns Absolute filenames paired with their complete replacement source.
 */
export function planMediaAdoption(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, change) => {
    const path = resolve(root, 'frontweb/src', file)
    pending.push([path, change(readSource(path).replace(/\r\n/g, '\n'), file)])
  }
  patch('utils/storyboardMedia.js', (source, file) => {
    source = replaceOnce(source, "import { parseDramaMetadata } from './canvasLayout'", "import { parseDramaMetadata } from './canvasLayout'\n" + helpers, file)
    source = replaceFunction(source, 'resolveSbFirstImageRecord', '0c6dc1e4be133f2533ff9f5093fd5217f3c852005e079cd02a2aa60ec306cb33', `function resolveSbFirstImageRecord(sb, imagesBySbId) {
  if (!sb) return null
  const images = getSbImagesList(imagesBySbId, sb.id)
  const adopted = adoptedImageRecord(images, sb.image_url, sb.local_path, 'storyboard_first', sb.first_frame_image_id)
  if (adopted) return adopted
  if (sb.first_frame_image_id != null) return images.find((i) => i.id === sb.first_frame_image_id) || null
  return images.find((i) => i.frame_type === 'storyboard_first') || null
}`, file)
    source = replaceFunction(source, 'resolveSbLastImageRecord', '3c46510310527fa5fabd43262d946d24a98e06391891dca93c981832b518cc97', `function resolveSbLastImageRecord(sb, imagesBySbId) {
  if (!sb) return null
  const images = getSbImagesList(imagesBySbId, sb.id)
  const adopted = adoptedImageRecord(images, sb.last_frame_image_url, sb.last_frame_local_path, 'storyboard_last', sb.last_frame_image_id)
  if (adopted) return adopted
  if (sb.last_frame_image_id != null) return images.find((i) => i.id === sb.last_frame_image_id) || null
  return images.find((i) => i.frame_type === 'storyboard_last') || null
}`, file)
    source = replaceFunction(source, 'resolveSbMainImageRecord', '21af83716e45227076eda14adbdfb9004214697f1072be10cc0c98e3f612bce0', `function resolveSbMainImageRecord(sb, imagesBySbId) {
  if (!sb) return null
  const images = getSbImagesList(imagesBySbId, sb.id)
  const adopted = adoptedImageRecord(images, sb.image_url, sb.local_path, undefined, sb.first_frame_image_id)
  if (adopted) return adopted
  if (sb.first_frame_image_id != null) return images.find((i) => i.id === sb.first_frame_image_id) || null
  return images[0] || null
}`, file)
    source = replaceFunction(source, 'resolveSbVideoRecord', '84c83141bf9d4881081e8be53dad4af14b7cbdb793dbd3fd43da8de1a99deea9', `function resolveSbVideoRecord(sb, videosBySbId) {
  if (!sb) return null
  const list = getSbVideosList(videosBySbId, sb.id)
  const selectedUrl = sb.video_url && String(sb.video_url).trim()
  if (selectedUrl) {
    const selectedPath = adoptedMediaPath(selectedUrl)
    if (selectedPath) {
      const byPath = list.find((video) => adoptedMediaPath(video.local_path) === selectedPath)
      if (byPath) return byPath
      return { video_url: selectedUrl, local_path: selectedPath }
    }
    const matches = list.filter((video) => video.video_url === selectedUrl)
    if (matches.length > 1) return null
    if (matches.length === 1) return matches[0]
    return { video_url: selectedUrl, local_path: null }
  }
  if (sb.video_local_path) return { video_url: null, local_path: adoptedMediaPath(sb.video_local_path) }
  return list[0] || null
}`, file)
    return replaceFunction(source, 'hasStoryboardVideo', 'b9521b36007f284cc1766f35b609c1e63fbb5416acd765f6bd8e868296095784', `function hasStoryboardVideo(sb, videosBySbId) {
  const rec = resolveSbVideoRecord(sb, videosBySbId)
  return !!(rec?.video_url || rec?.local_path)
}`, file)
  })
  patch('views/FilmCreate.vue', (source, file) => {
    source = replaceOnce(source, "import { useTheme } from '@/composables/useTheme'", "import { useTheme } from '@/composables/useTheme'\nimport { adoptedMediaPath, resolveSbFirstImageRecord, resolveSbLastImageRecord, resolveSbMainImageRecord, resolveSbVideoRecord } from '@/utils/storyboardMedia'", file)
    for (const [name, hash, fields, selected, resolver] of [
      ['getSbFirstImage', 'acc13ff265f4f0bc014dcffa0fda15900af8f76919baea6330277f680f1374eb', '!sb.image_url && !sb.local_path && sb.first_frame_image_id == null', 'sbSelectedImgId', 'resolveSbFirstImageRecord'],
      ['getSbLastImage', 'a3c661211cae48886f41d752c5dcfa58fcd5bb10787dc3f1a4f3b5b5253b2933', '!sb.last_frame_image_url && !sb.last_frame_local_path && sb.last_frame_image_id == null', 'sbSelectedLastImgId', 'resolveSbLastImageRecord'],
    ]) source = replaceFunction(source, name, hash, `function ${name}(storyboardId) {
  const sb = (store.storyboards || []).find((b) => b.id === storyboardId)
  if (!sb) return null
  if (${fields}) {
    const selected = resolveSbImageById(storyboardId, ${selected}.value[storyboardId])
    if (selected) return selected
  }
  return ${resolver}(sb, sbImages.value)
}`, file)
    source = replaceFunction(source, 'getSbImage', '7ad307e5758f3063711aa793d618e8c3d70f2e5eccbbee75c58e84dd3f880291', `function getSbImage(storyboardId) {
  if (storyboardUseFirstLastFrame.value) return getSbFirstImage(storyboardId)
  const sb = (store.storyboards || []).find((b) => b.id === storyboardId)
  if (!sb) return null
  if (!sb.image_url && !sb.local_path && sb.first_frame_image_id == null) {
    const selected = resolveSbImageById(storyboardId, sbSelectedImgId.value[storyboardId])
    if (selected) return selected
  }
  return resolveSbMainImageRecord(sb, sbImages.value)
}`, file)
    source = replaceFunction(source, 'getSbVideo', '43ad057fc91607902bf5526da354174389316de6db61a0f426dad54eff82af2b', `function getSbVideo(storyboardId) {
  const sb = (store.storyboards || []).find((b) => b.id === storyboardId)
  if (!sb) return null
  if (!sb.video_url && !sb.video_local_path) {
    const selectedId = sbSelectedVideoId.value[storyboardId]
    const selected = getSbAllVideos(storyboardId).find((video) => video.id === selectedId)
    if (selected) return selected
  }
  return resolveSbVideoRecord(sb, sbVideos.value)
}`, file)
    source = replaceFunction(source, 'onSelectSbMainVideo', '8a77d80b587792cb1983fe56c9178a50179adb88b9e8fff6036876036c23a98f', `function onSelectSbMainVideo(sb, video) {
  const localPath = adoptedMediaPath(video.local_path)
  const videoUrl = localPath ? '/static/' + localPath : video.video_url
  if (!videoUrl) return
  sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: video.id }
  const row = (store.currentEpisode?.storyboards || []).find((item) => item.id === sb.id)
  if (row) row.video_url = videoUrl
  sb.video_url = videoUrl
  storyboardsAPI.update(sb.id, { video_url: videoUrl }).catch(e => console.warn('[主视频] 保存后端失败', e))
}`, file)
    source = replaceOnce(source, '/** 首帧图（首尾帧模式下严格优先服务器绑定的 first_frame_image_id） */', '/** 首帧图：使用分镜已采纳的图片，再回退到未保存的手动选择 */', file)
    source = replaceOnce(source, '/** 尾帧图（首尾帧模式下严格优先服务器绑定的 last_frame_image_id） */', '/** 尾帧图：使用分镜已采纳的图片，再回退到未保存的手动选择 */', file)
    return replaceOnce(source, '/** 取该分镜当前选中的视频（尊重 sbSelectedVideoId，否则默认第一条） */', '/** 当前视频：优先显示分镜已采纳的版本 */', file)
  })
  return pending
}
