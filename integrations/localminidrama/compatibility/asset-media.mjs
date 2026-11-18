/** Keep asset generation results recoverable without replacing an adopted image. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after, file) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama asset media patch does not match pinned source: ${file}`)
  }
  return source.replace(before, after)
}

function replaceBlock(source, start, end, digest, after, file) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  const before = source.slice(from, to)
  if (from < 0 || to < 0 || createHash('sha256').update(before).digest('hex') !== digest) {
    throw new Error(`LocalMiniDrama asset media patch does not match pinned source: ${file}`)
  }
  return replaceOnce(source, before, after, file)
}

async function requireSavedAssetImage(localPath) {
  if (!localPath) throw new Error('供应商已返回图片，但未能保存；请使用原生成记录继续下载，不要重新生成')
  const path = require('path')
  const cfg = require('../config').loadConfig()
  const storage = path.isAbsolute(cfg.storage?.local_path) ? cfg.storage.local_path : path.join(process.cwd(), cfg.storage?.local_path || './data/storage')
  try {
    const image = require('sharp')(path.join(storage, localPath))
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('Missing image dimensions')
    await image.stats()
  } catch (error) {
    throw new Error('已保存的图片不能完整解码；请检查原生成记录的结果地址后继续下载，不要重新生成', { cause: error })
  }
}

function recordAssetImageResult(db, imageGenId, taskId, result) {
  const now = new Date().toISOString()
  db.prepare('UPDATE image_generations SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
    .run(result.image_url || null, result.local_path || null, now, imageGenId)
  db.prepare('UPDATE async_tasks SET result = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...result, image_generation_id: imageGenId, status: 'processing' }), now, taskId)
}

function failAssetImage(db, imageGenId, message) {
  db.prepare('UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('failed', String(message || '图片生成失败').slice(0, 500), new Date().toISOString(), imageGenId)
}

function createPropImageRecord(db, taskId, prop, prompt, model, provider, size, negativePrompt) {
  const now = new Date().toISOString()
  const info = db.prepare(
    `INSERT INTO image_generations (drama_id, provider, prompt, model, size, negative_prompt, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
  ).run(prop.drama_id, provider, prompt, model, size, negativePrompt || null, taskId, now, now)
  const id = Number(info.lastInsertRowid)
  db.prepare('UPDATE async_tasks SET result = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ prop_id: prop.id, image_generation_id: id, status: 'processing' }), now, taskId)
  return id
}

/** A completed alternative stays in history and extras; an existing URL or path remains adopted. */
function adoptAssetImage(db, log, kind, id, imageUrl, localPath, now) {
  const table = { character: 'characters', scene: 'scenes', prop: 'props' }[kind]
  if (!table) throw new Error('Unsupported image asset kind')
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id)
    if (!row) return false
    const chosen = [row.image_url, row.local_path].some(value => value != null && String(value).trim())
    if (chosen) {
      let extras = row.extra_images ? JSON.parse(row.extra_images) : []
      if (!Array.isArray(extras)) throw new Error('素材历史图片必须是数组，请修复后重试原生成记录')
      const alternative = localPath || imageUrl
      if (alternative && alternative !== row.local_path && alternative !== row.image_url && !extras.includes(alternative)) {
        extras = [...extras, alternative]
        db.prepare(`UPDATE ${table} SET extra_images = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(extras), now, id)
      }
      return false
    }
    if (kind === 'character') require('../utils/seedance2AssetGuards').markStaleOnCharacterMainImageDrift(db, log, row, {
      image_url: imageUrl, local_path: localPath,
    })
    db.prepare(`UPDATE ${table} SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?`).run(imageUrl, localPath, now, id)
    return true
  }).immediate()
}

const helperSource = `/** Asset media validation, result retention and atomic image adoption. */
${[requireSavedAssetImage, recordAssetImageResult, failAssetImage, createPropImageRecord, adoptAssetImage].map(fn => fn.toString()).join('\n\n')}

module.exports = { requireSavedAssetImage, recordAssetImageResult, failAssetImage, createPropImageRecord, adoptAssetImage };
`

/**
 * Plan validation and adoption corrections for every exposed asset image generation path.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read staged source after model, storyboard and verification corrections.
 * @returns Source replacements and one new backend helper, without writing files.
 */
export function planAssetMedia(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, transform) => {
    const path = resolve(root, 'backend-node/src/services', file)
    pending.push([path, transform(readSource(path).replaceAll('\r\n', '\n'), file)])
  }
  patch('imageClient.js', (source, file) => {
    source = replaceOnce(source, "const uploadService = require('./uploadService');", "const uploadService = require('./uploadService');\nconst { requireSavedAssetImage, recordAssetImageResult, adoptAssetImage } = require('./museAssetMedia');", file)
    source = replaceOnce(source, '      // 兼容旧库无 completed_at：先试完整 UPDATE，失败则只更新必有列', `      recordAssetImageResult(db, imageGenId, taskId, { image_url: result.image_url, local_path: localPath });
      await requireSavedAssetImage(localPath);
      // 兼容旧库无 completed_at：先试完整 UPDATE，失败则只更新必有列`, file)
    return replaceBlock(source,
      '      if (charIdNum != null) {\n        try {\n          // 旧图追加到 extra_images',
      "      log.info('Image generation completed'",
      '39ed18541f7a0194cf5d7cba2e400d1e750dfe7f7c3a02a8fe6e90477765c0ac',
      `      if (charIdNum != null) adoptAssetImage(db, log, 'character', charIdNum, result.image_url, localPath, now2);
      if (sceneIdNum != null) adoptAssetImage(db, log, 'scene', sceneIdNum, result.image_url, localPath, now2);
`, file)
  })
  patch('propImageGenerationService.js', (source, file) => {
    source = replaceOnce(source, "const uploadService = require('./uploadService');", "const uploadService = require('./uploadService');\nconst { requireSavedAssetImage, recordAssetImageResult, failAssetImage, createPropImageRecord, adoptAssetImage } = require('./museAssetMedia');", file)
    source = replaceOnce(source, '  const userNeg = imageClient.resolveAssetUserNegativeForApi(model, prop.negative_prompt);', `  const userNeg = imageClient.resolveAssetUserNegativeForApi(model, prop.negative_prompt);
  const imageGenId = createPropImageRecord(db, taskId, prop, fullPrompt, model, preferredProvider, imageSize, userNeg);`, file)
    source = replaceOnce(source, "    log.error('Prop image API failed', { prop_id: propId, error: err.message });", "    failAssetImage(db, imageGenId, errMsg);\n    log.error('Prop image API failed', { prop_id: propId, error: err.message });", file)
    source = replaceOnce(source, '  if (result.error) {\n    taskService.updateTaskError', '  if (result.error) {\n    failAssetImage(db, imageGenId, result.error);\n    taskService.updateTaskError', file)
    source = replaceOnce(source, "    const errMsg = '未返回图片地址';", "    const errMsg = '未返回图片地址';\n    failAssetImage(db, imageGenId, errMsg);", file)
    source = replaceBlock(source, '  // 旧图追加到 extra_images', '  taskService.updateTaskResult(db, taskId, {',
      '183ba6caaea0da55f7a6c98c9ea2c32220c69303799900f20aa6c095ad7b1ff6', `  recordAssetImageResult(db, imageGenId, taskId, { image_url: result.image_url, local_path: localPath, prop_id: propId });
  try {
    await requireSavedAssetImage(localPath);
    adoptAssetImage(db, log, 'prop', propId, result.image_url, localPath, now);
  } catch (error) {
    failAssetImage(db, imageGenId, error.message);
    taskService.updateTaskError(db, taskId, error.message);
    db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?').run(error.message, now, propId);
    return;
  }
  db.prepare('UPDATE image_generations SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run('completed', now, now, imageGenId);

`, file)
    return replaceOnce(source, '  taskService.updateTaskResult(db, taskId, {\n    image_url:', '  taskService.updateTaskResult(db, taskId, {\n    image_generation_id: imageGenId,\n    image_url:', file)
  })
  pending.push([resolve(root, 'backend-node/src/services/museAssetMedia.js'), helperSource])
  return pending
}
