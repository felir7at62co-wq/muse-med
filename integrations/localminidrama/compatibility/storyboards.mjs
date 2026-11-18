/** Pinned LocalMiniDrama corrections for durable storyboard edits and replacements. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after, file) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama source does not match the pinned storyboard patch: ${file}`)
  }
  return source.replace(before, after)
}

function replaceFunction(source, start, end, digest, replacement, file) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0 || source.indexOf(start, from + start.length) >= 0
    || createHash('sha256').update(source.slice(from, to)).digest('hex') !== digest) {
    throw new Error(`LocalMiniDrama source does not match the pinned storyboard patch: ${file}`)
  }
  return source.slice(0, from) + replacement + '\n\n' + source.slice(to)
}

function storyboardInputError(message) {
  const error = new Error(message)
  error.code = 'BAD_REQUEST'
  return error
}

function requireStoryboardReferences(db, episodeId, req) {
  const requireId = (value, label) => {
    const id = Number(value)
    if (!['string', 'number'].includes(typeof value) || !String(value).trim() || !Number.isSafeInteger(id) || id <= 0) throw storyboardInputError(`${label}必须是有效的正整数 ID`)
    return id
  }
  const episode = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(requireId(episodeId, '剧集'))
  if (!episode) throw storyboardInputError('剧集不存在或已删除')
  if (req.storyboard_number !== undefined) requireId(req.storyboard_number, '分镜编号')
  if (req.scene_id !== undefined && req.scene_id !== null) {
    const scene = db.prepare('SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL').get(requireId(req.scene_id, '场景'))
    if (!scene || Number(scene.drama_id) !== Number(episode.drama_id)) throw storyboardInputError('场景不存在或不属于本剧')
  }
  const charactersValue = req.character_ids !== undefined ? req.character_ids : req.characters
  if (charactersValue !== undefined) {
    let characters = charactersValue
    if (typeof characters === 'string') {
      try { characters = JSON.parse(characters) } catch (error) { throw storyboardInputError('角色列表必须是 JSON 数组') }
    }
    if (!Array.isArray(characters)) throw storyboardInputError('角色列表必须是数组')
    for (const character of characters) {
      const id = requireId(character && typeof character === 'object' ? character.id : character, '角色')
      const row = db.prepare('SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL').get(id)
      if (!row || Number(row.drama_id) !== Number(episode.drama_id)) throw storyboardInputError('角色不存在或不属于本剧')
    }
  }
  if (req.prop_ids !== undefined) {
    if (!Array.isArray(req.prop_ids)) throw storyboardInputError('道具列表必须是数组')
    for (const value of req.prop_ids) {
      const row = db.prepare('SELECT drama_id FROM props WHERE id = ? AND deleted_at IS NULL').get(requireId(value, '道具'))
      if (!row || Number(row.drama_id) !== Number(episode.drama_id)) throw storyboardInputError('道具不存在或不属于本剧')
    }
  }
}

function storyboardLocalPathForUrl(value, baseUrl, label) {
  if (!value) return null
  const base = baseUrl ? String(baseUrl).replace(/\/$/, '') : ''
  let relative = value.startsWith('/static/') ? value.slice('/static/'.length) : null
  if (base && value.startsWith(base + '/')) relative = value.slice(base.length + 1)
  if (relative === null) return null
  try { return decodeURIComponent(relative.split(/[?#]/, 1)[0]) || null } catch (error) { throw storyboardInputError(label + '地址的路径编码无效') }
}

function resolveStoryboardVideoAdoption(db, storyboardId, value, baseUrl) {
  if (value != null && typeof value !== 'string') throw storyboardInputError('视频地址必须是字符串')
  const url = value?.trim() || null
  if (!url) return null
  const localPath = storyboardLocalPathForUrl(url, baseUrl, '视频')
  if (localPath) return '/static/' + localPath.replace(/^\//, '')
  const rows = db.prepare("SELECT local_path FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL AND video_url = ? ORDER BY id DESC").all(Number(storyboardId), url)
  const paths = new Set(rows.map(row => row.local_path || null))
  if (paths.size > 1) throw storyboardInputError('视频供应商地址对应多个生成版本，请选择所需版本的 local_url 本地地址')
  return rows[0]?.local_path ? '/static/' + String(rows[0].local_path).replace(/^\//, '') : url
}

function resolveStoryboardImageAdoptions(db, storyboardId, request) {
  const req = { ...request }
  const baseUrl = require('../config').loadConfig().storage?.base_url
  for (const [urlField, pathField, idField] of [
    ['image_url', 'local_path', 'first_frame_image_id'],
    ['last_frame_image_url', 'last_frame_local_path', 'last_frame_image_id'],
  ]) {
    if (req[urlField] === undefined && req[pathField] === undefined && req[idField] == null) continue
    for (const field of [urlField, pathField]) {
      if (req[field] !== undefined && req[field] !== null && typeof req[field] !== 'string') throw storyboardInputError('图片地址和本地路径必须是字符串')
    }
    const hasUrl = req[urlField] !== undefined
    const url = req[urlField] == null ? null : req[urlField].trim() || null
    const requestedPath = req[pathField] == null ? null : req[pathField].trim() || null
    const inferredPath = storyboardLocalPathForUrl(url, baseUrl, '图片')
    let row
    if (req[idField] != null) {
      if (!['string', 'number'].includes(typeof req[idField]) || !Number.isSafeInteger(Number(req[idField])) || Number(req[idField]) <= 0) throw storyboardInputError('图片生成记录 ID 无效')
      row = db.prepare("SELECT * FROM image_generations WHERE id = ? AND storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL").get(Number(req[idField]), Number(storyboardId))
      if (!row || (requestedPath && row.local_path !== requestedPath) || (url && row.image_url !== url && (!inferredPath || row.local_path !== inferredPath))) throw storyboardInputError('图片生成记录不存在或不属于此分镜')
    } else {
      const selectedPath = inferredPath || requestedPath
      if (selectedPath) {
        const candidate = db.prepare("SELECT * FROM image_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL AND local_path = ? ORDER BY id DESC LIMIT 1").get(Number(storyboardId), selectedPath)
        if (candidate && (!url || inferredPath || candidate.image_url === url)) row = candidate
      }
      if (!row && url && !inferredPath) {
        const rows = db.prepare("SELECT * FROM image_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL AND image_url = ? ORDER BY id DESC").all(Number(storyboardId), url)
        if (new Set(rows.map(candidate => candidate.local_path || null)).size > 1) throw storyboardInputError('图片供应商地址对应多个生成版本，请选择生成记录 ID 或 local_url 本地地址')
        row = rows[0]
      }
    }
    const adoptedPath = row?.local_path || inferredPath || (!hasUrl ? requestedPath : null)
    req[urlField] = hasUrl ? url : row?.image_url || (adoptedPath ? '/static/' + adoptedPath.replace(/^\//, '') : null)
    req[pathField] = adoptedPath
    req[idField] = row?.id ?? null
  }
  return req
}

function createStoryboard(db, log, req) {
  return db.transaction(() => {
    requireStoryboardReferences(db, req.episode_id, req)
    const now = new Date().toISOString()
    const info = db.prepare(
      "INSERT INTO storyboards (episode_id, storyboard_number, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)"
    ).run(Number(req.episode_id), Number(req.storyboard_number ?? 0), now, now)
    return updateStoryboard(db, log, Number(info.lastInsertRowid), { ...req, duration: req.duration ?? 0 })
  }).immediate()
}

function storyboardReplacementState(db, episodeId) {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId)
  const rows = table => db.prepare(`SELECT * FROM ${table} WHERE storyboard_id IN (SELECT id FROM storyboards WHERE episode_id = ?) ORDER BY rowid`).all(episodeId)
  const assets = table => episode ? db.prepare(`SELECT * FROM ${table} WHERE drama_id = ? ORDER BY id`).all(episode.drama_id) : []
  return JSON.stringify({
    episode,
    drama: episode ? db.prepare('SELECT * FROM dramas WHERE id = ?').get(episode.drama_id) : null,
    storyboards: db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id').all(episodeId),
    characters: rows('storyboard_characters'),
    props: rows('storyboard_props'),
    prompts: rows('frame_prompts'),
    images: rows('image_generations'),
    videos: rows('video_generations'),
    dramaCharacters: assets('characters'),
    scenes: assets('scenes'),
    dramaProps: assets('props'),
    characterLibraries: episode ? db.prepare('SELECT * FROM character_libraries WHERE drama_id = ? OR drama_id IS NULL ORDER BY id').all(episode.drama_id) : [],
  })
}

function saveStoryboards(db, log, episodeId, storyboards, cfg, styleOverride, skipShotNumbers = null, deriveOpts = {}) {
  return db.transaction(() => {
    if (!Array.isArray(storyboards) || storyboards.length === 0) throw new Error('AI生成分镜失败：返回的分镜数量为0')
    const style = (styleOverride && String(styleOverride).trim()) || cfg?.style?.default_style || ''
    const videoRatio = cfg?.style?.default_video_ratio || '16:9'
    const storyboardService = require('./storyboardService')
    const numbers = new Set()
    const prepared = storyboards.map(sb => {
      if (!sb || typeof sb !== 'object' || Array.isArray(sb)) throw new Error('AI分镜必须是对象')
      const rawNumber = sb.shot_number ?? sb.storyboard_number
      const number = Number(rawNumber)
      if (!['string', 'number'].includes(typeof rawNumber) || !Number.isSafeInteger(number) || number <= 0 || numbers.has(number)) throw new Error('AI分镜编号无效或重复')
      numbers.add(number)
      for (const field of ['title', 'description', 'action', 'dialogue', 'narration', 'result', 'atmosphere', 'scene_description', 'location', 'time', 'shot_type', 'angle', 'camera_angle', 'movement', 'camera_movement', 'emotion', 'segment_title', 'lighting_style', 'depth_of_field', 'universal_segment_text']) {
        if (sb[field] != null && typeof sb[field] !== 'string') throw new Error('AI分镜文本字段无效: ' + field)
      }
      if (![sb.title, sb.description, sb.action, sb.dialogue, sb.video_prompt, sb.universal_segment_text].some(value => typeof value === 'string' && value.trim())) {
        throw new Error('AI分镜缺少可用内容')
      }
      if (sb.props !== undefined && (!Array.isArray(sb.props) || sb.props.some(value => !['string', 'number'].includes(typeof value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0))) {
        throw new Error('AI分镜道具 ID 无效')
      }
      if (sb.characters !== undefined && !Array.isArray(sb.characters)) throw new Error('AI分镜角色列表无效')
      if (sb.scene_id != null && (!['string', 'number'].includes(typeof sb.scene_id) || !Number.isSafeInteger(Number(sb.scene_id)) || Number(sb.scene_id) <= 0)) throw new Error('AI分镜场景 ID 无效')
      if (sb.duration != null && (!['string', 'number'].includes(typeof sb.duration) || normalizeDuration(sb.duration) <= 0)) throw new Error('AI分镜时长无效')
      const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts)
      return {
        episode_id: Number(episodeId), scene_id: d.sceneId, storyboard_number: number,
        title: d.title || null, description: d.description, location: sb.location ?? null, time: sb.time ?? null,
        duration: sb.duration ?? 5, dialogue: d.dialogue || null, narration: d.narration || null,
        action: d.action || null, result: d.result || null, atmosphere: sb.atmosphere ?? null,
        image_prompt: d.imagePrompt, video_prompt: d.videoPrompt, characters: JSON.parse(d.charactersJson),
        prop_ids: d.propIds, shot_type: d.shotType || null, angle: d.angle, angle_h: d.angleH, angle_v: d.angleV,
        angle_s: d.angleS, movement: d.movement || null, lighting_style: d.lightingStyle, depth_of_field: d.depthOfField,
        emotion: d.emotion || null, emotion_intensity: sb.emotion_intensity ?? null,
        segment_index: d.segmentIndex, segment_title: d.segmentTitle, creation_mode: d.creationMode || 'classic',
        universal_segment_text: d.universalSegmentText,
      }
    })
    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(new Date().toISOString(), Number(episodeId))
    return prepared.map(req => storyboardService.createStoryboard(db, log, req))
  }).immediate()
}

async function processStoryboardGeneration(db, log, cfg, taskId, episodeId, model, style, userPrompt, systemPrompt, includeNarration, universalOmni, targetClipDurationSec = null, expectedState) {
  const episodeIdNum = Number(episodeId)
  try {
    const mayStart = db.transaction(() => {
      if (taskService.getTask(db, taskId)?.status !== 'pending') return false
      taskService.updateTaskStatus(db, taskId, 'processing', 10, '开始生成分镜头...')
      return true
    }).immediate()
    if (!mayStart) return
    const episode = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeIdNum)
    if (!episode) throw new Error('剧集不存在或已删除')
    const deriveOpts = {
      universalOmni: !!universalOmni,
      targetClipDuration: targetClipDurationSec != null && Number(targetClipDurationSec) > 0 ? Number(targetClipDurationSec) : null,
      characterAppearances: buildDramaCharacterAppearanceMap(db.prepare('SELECT id, name, appearance FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(episode.drama_id)),
    }
    const parse = text => {
      const meta = {}
      const items = extractFirstArray(safeParseAIJSON(text, null, log, meta))
      if (!Array.isArray(items) || items.length === 0) throw new Error('AI生成分镜失败：返回的分镜数量为0')
      return { items, meta }
    }
    logDebugStoryboardPrompts(log, `task-${taskId}-initial`, userPrompt, systemPrompt)
    let { items: storyboards, meta } = parse(await generateTextForStoryboard(db, log, userPrompt, systemPrompt, { model: model || undefined }))
    for (let attempt = 1; meta.truncated && attempt <= 3; attempt++) {
      const lastShot = Math.max(...storyboards.map(normalizeStoryboardShotNumber))
      const prompt = buildContinuationPrompt(userPrompt, storyboards, lastShot, attempt, !!includeNarration, !!universalOmni)
      const mayContinue = db.transaction(() => {
        if (taskService.getTask(db, taskId)?.status !== 'processing') return false
        taskService.updateTaskStatus(db, taskId, 'processing', 50 + attempt * 5, `已生成 ${storyboards.length} 个分镜，正在续写剩余部分...`)
        return true
      }).immediate()
      if (!mayContinue) return
      const next = parse(await generateTextForStoryboard(db, log, prompt, systemPrompt, { model: model || undefined }))
      const numbers = new Set(storyboards.map(normalizeStoryboardShotNumber))
      const additions = next.items.filter(sb => !numbers.has(normalizeStoryboardShotNumber(sb)))
      if (additions.length === 0) throw new Error('AI续写未返回新的分镜，请重新生成')
      storyboards = [...storyboards, ...additions]
      meta = next.meta
    }
    if (meta.truncated) throw new Error('AI分镜输出不完整，请重新生成')
    db.transaction(() => {
      // All user edits and relation changes must survive an overlapping model request.
      if (storyboardReplacementState(db, episodeIdNum) !== expectedState) {
        const error = new Error('生成期间剧集或分镜已修改，已保留现有内容，请检查后重新生成')
        error.code = 'CONFLICT'
        throw error
      }
      const task = taskService.getTask(db, taskId)
      if (!task || task.status !== 'processing') throw new Error('分镜生成任务已取消或结束')
      const saved = saveStoryboards(db, log, episodeId, storyboards, cfg, style, null, deriveOpts)
      const storyboardService = require('./storyboardService')
      for (const sb of saved) {
        syncStoryboardCharacters(db, log, sb.id)
        const current = storyboardService.getStoryboardById(db, sb.id)
        Object.assign(sb, storyboardService.updateStoryboard(db, log, sb.id, { characters: current.characters }))
      }
      const totalDuration = saved.reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0)
      const durationMinutes = Math.ceil((totalDuration + 59) / 60)
      db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, new Date().toISOString(), episodeIdNum)
      taskService.updateTaskResult(db, taskId, {
        storyboards: saved, total: saved.length, total_duration: totalDuration,
        duration_minutes: durationMinutes, truncated: false,
      })
    }).immediate()
    log.info('Storyboard generation completed', { task_id: taskId, episode_id: episodeId })
  } catch (error) {
    log.error('Storyboard generation failed', { error: error.message, task_id: taskId })
    if (taskService.getTask(db, taskId)?.status !== 'failed') taskService.updateTaskError(db, taskId, error.message || '生成分镜头失败')
  }
}

function getVideoUrlForStoryboard(db, storyboardId, baseUrl) {
  const sb = db.prepare('SELECT video_url FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(storyboardId)
  if (!sb) return null
  // A stored video URL is the adopted version; timestamps never override this choice.
  if (sb.video_url && String(sb.video_url).trim()) {
    const adoptedUrl = resolveStoryboardVideoAdoption(db, storyboardId, sb.video_url, baseUrl)
    const base = baseUrl ? String(baseUrl).replace(/\/$/, '') : ''
    const adoptedPath = storyboardLocalPathForUrl(adoptedUrl, baseUrl, '视频')
    if (adoptedPath && base) return base + '/' + adoptedPath.replace(/^\//, '')
    return adoptedUrl
  }
  const vg = db.prepare(
    "SELECT video_url, local_path FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(storyboardId)
  if (vg?.local_path && String(vg.local_path).trim() && baseUrl) return baseUrl.replace(/\/$/, '') + '/' + String(vg.local_path).replace(/^\//, '')
  return vg?.video_url && String(vg.video_url).trim() ? vg.video_url : null
}

/**
 * Plan complete replacement sources, refusing mismatched pinned implementation blocks.
 * @param root - Upstream checkout at the Dockerfile revision.
 * @param readSource - Read staged source when composing independent compatibility patches.
 * @returns Absolute paths and source text; this function does not write files.
 */
export function planStoryboardCompatibility(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, transform) => {
    const path = resolve(root, 'backend-node/src/services', file)
    pending.push([path, transform(readSource(path).replace(/\r\n/g, '\n'), file)])
  }
  patch('storyboardService.js', (source, file) => {
    source = replaceFunction(source, 'function createStoryboard(', 'function updateStoryboard(', 'f46d7ad3c002e0119f2e8be5998887408cd7fa76017f9cb46ebf9b3f0076c661', [storyboardInputError, requireStoryboardReferences, storyboardLocalPathForUrl, resolveStoryboardVideoAdoption, resolveStoryboardImageAdoptions, createStoryboard].map(fn => fn.toString()).join('\n\n'), file)
    source = replaceOnce(source, 'function updateStoryboard(db, log, id, req) {', 'function updateStoryboard(db, log, id, req) {\n  return db.transaction(() => updateStoryboardRows(db, log, id, req)).immediate();\n}\n\nfunction updateStoryboardRows(db, log, id, req) {', file)
    source = replaceOnce(source, "SELECT id FROM storyboards WHERE id = ? AND deleted_at IS NULL", "SELECT id, episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL", file)
    source = replaceOnce(source, "  const allowed = ['title'", "  requireStoryboardReferences(db, row.episode_id, req);\n  req = resolveStoryboardImageAdoptions(db, id, req);\n  if (req.video_url !== undefined) req.video_url = resolveStoryboardVideoAdoption(db, id, req.video_url, require('../config').loadConfig().storage?.base_url);\n  const allowed = ['storyboard_number', 'lighting_style', 'depth_of_field', 'emotion', 'emotion_intensity', 'title'", file)
    source = replaceOnce(source, "    try {\n      syncStoryboardCharacterLinks(db, id, parsedDramaCharIdsForSync);\n    } catch (e) {\n      log.warn('syncStoryboardCharacterLinks failed', { id, message: e.message });\n    }", '    syncStoryboardCharacterLinks(db, id, parsedDramaCharIdsForSync);', file)
    source = replaceOnce(source, '    shot_type: r.shot_type,', '    lighting_style: r.lighting_style ?? null,\n    depth_of_field: r.depth_of_field ?? null,\n    emotion: r.emotion ?? null,\n    emotion_intensity: r.emotion_intensity ?? null,\n    shot_type: r.shot_type,', file)
    return source
  })
  patch('episodeStoryboardService.js', (source, file) => {
    source = replaceFunction(source, '/** 用最终解析的分镜对象覆盖已存在的行', '/**\n * 构建续写 prompt', '2f10775b78679a9315adc01ea16f259c5c13726f2c8572a17741ea64e111e2f7', [storyboardReplacementState, saveStoryboards].map(fn => fn.toString()).join('\n\n'), file)
    source = replaceFunction(source, 'async function processStoryboardGeneration(', 'function generateStoryboard(', 'f13c380e778872d59a7d129d9e2f4124a94a9c7c150a0f6cfa1d6436f510c851', processStoryboardGeneration.toString(), file)
    source = replaceOnce(source, "function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni) {\n  const cfg = loadConfig();", "function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni) {\n  const cfg = loadConfig();\n  const expectedState = db.transaction(() => storyboardReplacementState(db, Number(episodeId))).deferred();", file)
    source = replaceOnce(source, '      clipSec\n    );', '      clipSec,\n      expectedState\n    );', file)
    return source
  })
  patch('dramaService.js', (source, file) => {
    // The initial merge correction changes this line before planners are composed.
    source = source.replace('  const sbUrl = sb ? buildUrl(sb.video_url, sb.local_path) : null;', '  const sbUrl = sb?.video_url ? buildUrl(sb.video_url, null) : null;')
    return replaceFunction(source, 'function getVideoUrlForStoryboard(', 'function finalizeEpisode(', '7d578c68440af0b3ddbee9b03fb4d0bb4bfac26124b8afe4b014a4463dc0943c', [storyboardInputError, storyboardLocalPathForUrl, resolveStoryboardVideoAdoption, getVideoUrlForStoryboard].map(fn => fn.toString()).join('\n\n'), file)
  })
  patch('videoService.js', (source, file) => replaceOnce(source,
    "      db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(\n        videoUrl, localPath, now, row.storyboard_id\n      );",
    "      // Only populate an empty adoption; a later completion cannot replace a chosen version.\n      db.prepare(\"UPDATE storyboards SET video_url = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND (video_url IS NULL OR TRIM(video_url) = '')\").run(\n        localPath ? '/static/' + String(localPath).replace(/^\\//, '') : videoUrl, now, row.storyboard_id\n      );", file))
  return pending
}
