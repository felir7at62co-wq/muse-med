/** Connection-test evidence and durable media completion for the pinned studio. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

function replace(source, before, after, file) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama verification patch source changed: ${file}`)
  }
  return source.replace(before, after)
}

/**
 * Plan edits without writing until every pinned anchor has been validated.
 * @param root - Pinned upstream checkout.
 * @param readSource - Current staged source, allowing composition with other corrections.
 * @returns Complete files ready for the owning patch transaction.
 */
export function planVerification(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, edits) => {
    const path = join(root, file)
    let source = readSource(path).replaceAll('\r\n', '\n')
    for (const [before, after] of edits) source = replace(source, before, after, file)
    pending.push([path, source])
  }
  {
    const path = join(root, 'backend-node/src/services/aiConfigService.js')
    const source = readSource(path).replaceAll('\r\n', '\n')
    const from = source.indexOf('async function testConnection(opts) {')
    const to = source.indexOf('/**\n * 返回 vendor_lock', from)
    if (from < 0 || to < 0 || createHash('sha256').update(source.slice(from, to)).digest('hex') !== 'bb3fc282cdb9ae94dd781591767ffdb5719130be2886b038fedd04dcc5c0a5df') throw new Error('LocalMiniDrama connection verification source changed')
    pending.push([path, source.slice(0, from) + `async function testConnection(opts) {
  const base = String(opts.base_url || '').replace(/\\/$/, '');
  const address = new URL(base);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new Error('请填写不含凭据、查询参数和片段的 HTTP(S) 服务地址');
  }
  if (!String(opts.api_key || '').trim()) throw new Error('api_key 必填');
  const models = flattenModelIds(opts.model);
  if (!models.length) throw new Error('请选择供应商实际提供的模型 ID');
  const service = String(opts.service_type || '').toLowerCase();
  const media = ['image', 'storyboard_image', 'video', 'tts'].includes(service)
    || !service && /seedance|seedream|sora|kling|imagen|wanx|flux|dall.?e|agnes-(?:video|image)/i.test(models[0]);
  if (media) return {
    verification: 'configuration_only', authenticated: false, generation_verified: false,
    message: '配置格式已检查；未调用供应商，尚未验证 Key、模型权限、额度和实际生成能力。请在准备好后执行一次明确授权的小样生成。',
  };
  require('./modelId').assertTextChatConfig(opts);
  const endpoint = String(opts.endpoint || '/chat/completions');
  const url = base + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
  let body = { model: remapArkModelId(base, models[0]), messages: [{ role: 'user', content: 'Hello' }], max_tokens: 5 };
  if (isOfficialArkBase(base) && (/^deepseek-v4/i.test(body.model) || /^doubao-seed-2/i.test(body.model))) body.thinking = { type: 'disabled' };
  body = applyDeepSeekConnectivityOptions({ provider: opts.provider, base_url: base, settings: opts.settings }, body);
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.api_key },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('文本测试请求返回 HTTP ' + response.status + '；请核对协议、模型与访问权限'); }
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.choices) || typeof data.choices[0]?.message?.content !== 'string') {
    throw new Error('接口未返回有效的 Chat Completions 文本响应，未验证文本模型可用');
  }
  return { verification: 'request_verified', message: '文本接口已响应；仅覆盖本次测试请求' };
}\n\n` + source.slice(to)])
  }
  patch('backend-node/src/routes/aiConfig.js', [
    ['      await aiConfigService.testConnection({', '      const verification = await aiConfigService.testConnection({'],
    ['        settings: body.settings,\n      });', '        settings: body.settings,\n        api_protocol: body.api_protocol,\n      });'],
    ["      response.success(res, { message: '连接测试成功' });", "      response.success(res, verification || { verification: 'request_verified', message: '文本接口已响应；仅覆盖本次测试请求' });"],
  ])
  patch('frontweb/src/components/AIConfigContent.vue', [
    ['      <template v-else-if="testResult">', `      <el-alert v-else-if="testResult === 'configuration_only'" type="info" title="尚未验证生成能力"
        description="配置格式已检查，未调用供应商或执行生成；Key、模型权限、额度和生成结果仍需实际小样验证。" show-icon :closable="false" />
      <template v-else-if="testResult">`],
    ['    await aiAPI.testConnection({', '    const verification = await aiAPI.testConnection({'],
    ['      settings: row.settings\n    })', '      settings: row.settings,\n      api_protocol: row.api_protocol\n    })'],
    ['    testResult.value = true', "    testResult.value = verification?.verification === 'configuration_only' ? 'configuration_only' : true"],
  ])
  patch('backend-node/src/services/videoService.js', [
    ["const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');", "const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');"],
    ['    fs.writeFileSync(filePath, buf);', `    fs.writeFileSync(filePath, buf);
    const probe = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', filePath],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    let streams = [];
    try { streams = JSON.parse(probe.stdout || '{}').streams || []; } catch (_) {}
    if (probe.status !== 0 || !streams.some(stream => stream.codec_type === 'video')) {
      fs.unlinkSync(filePath);
      throw new Error('下载结果不是可读取的视频文件；请检查供应商结果地址或本机 FFprobe');
    }
    const decoded = spawnSync(getFfmpegPath(), ['-v', 'error', '-xerror', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 180000, windowsHide: true });
    if (decoded.status !== 0) {
      fs.unlinkSync(filePath);
      throw new Error('视频不能完整解码，未标为完成；请检查原结果文件，不要重新生成');
    }`],
    ["  if (requireAuthDownload && !localPath) {", '  if (!localPath) {'],
    ["    const errMsg = '成片鉴权下载失败（请检查 API Key，或稍后重试继续查询）';", "    const errMsg = '供应商已返回结果，但视频未能下载并校验；保留原任务，检查结果地址、鉴权和 FFprobe 后继续查询，不要重新生成';"],
    ['    setVideoGenFailed(db, videoGenId, errMsg, now);', "    db.prepare('UPDATE video_generations SET video_url = ? WHERE id = ?').run(videoUrl, videoGenId);\n    setVideoGenFailed(db, videoGenId, errMsg, now);"],
    ['  let localPath = null;\n  const requireAuthDownload', "  db.prepare('UPDATE video_generations SET video_url = ? WHERE id = ?').run(videoUrl, videoGenId);\n  let localPath = null;\n  const requireAuthDownload"],
    ["can_resume_poll: r.status === 'failed' && hasProviderTaskId(r),", "can_resume_poll: r.status === 'failed' && (hasProviderTaskId(r) || /^https?:\\/\\//i.test(r.video_url || '')),"],
    ['  if (!providerTaskId) return;', '  if (!providerTaskId && !/^https?:\\/\\//i.test(row.video_url || \'\')) return;'],
    ['    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);', `    if (providerTaskId) await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
    else await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, row.video_url, 'download recovery', config);`],
    ["  if (!hasProviderTaskId(row)) {\n    return { ok: false, status: 400, error: '缺少厂商任务 ID，无法继续查询，请重新生成' };\n  }", "  if (!hasProviderTaskId(row) && !/^https?:\\/\\//i.test(row.video_url || '')) {\n    return { ok: false, status: 400, error: '原记录没有可查询任务或结果地址；请先核对供应商记录，不要直接重新生成' };\n  }"],
    ["  if (row.status === 'processing' && hasProviderTaskId(row)) {", "  if (row.status === 'processing' && (hasProviderTaskId(row) || /^https?:\\/\\//i.test(row.video_url || ''))) {"],
    ["         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`", "         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')\n         AND (video_url IS NULL OR TRIM(video_url) = '')`"],
    ["         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''`", "         AND ((provider_task_id IS NOT NULL AND TRIM(provider_task_id) != '') OR (video_url IS NOT NULL AND TRIM(video_url) != ''))`"],
    ["  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';", "  const stuckMsg = '服务重启后缺少可查询的供应商任务或结果地址；请先核对原记录，不要直接重新生成';"],
  ])
  patch('backend-node/src/services/imageService.js', [
    ['    // 入库的 image_url：优先指向本地静态路径，避免前端仍用 Gemini 返回的 data URL', `    if (!localPath) {
      db.prepare('UPDATE image_generations SET image_url = ? WHERE id = ?').run(result.image_url, imageGenId);
      throw new Error('供应商已返回结果，但图片未能保存；检查结果地址与存储后再处理原生成记录，不要自动重新生成');
    }
    const savedImageRoot = path.isAbsolute(cfg.storage?.local_path) ? cfg.storage.local_path : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    db.prepare('UPDATE image_generations SET image_url = ?, local_path = ? WHERE id = ?').run(result.image_url, localPath, imageGenId);
    const savedImage = require('sharp')(path.join(savedImageRoot, localPath));
    const metadata = await savedImage.metadata();
    if (!metadata.width || !metadata.height) throw new Error('已下载的图片不能解码，未标为完成');
    await savedImage.stats();

    // 入库的 image_url：优先指向本地静态路径，避免前端仍用 Gemini 返回的 data URL`],
    ['    if (row.scene_id != null && row.storyboard_id == null) {', "    const adoptedScene = row.scene_id != null ? db.prepare('SELECT image_url, local_path FROM scenes WHERE id = ?').get(row.scene_id) : null;\n    if (row.scene_id != null && row.storyboard_id == null && !adoptedScene?.image_url && !adoptedScene?.local_path) {"],
    ["        bindStoryboardFrameImage(\n          db,\n          row.storyboard_id,\n          effectiveFrameTypeForBind,", "        const adopted = db.prepare('SELECT image_url, local_path, last_frame_image_url, last_frame_local_path FROM storyboards WHERE id = ?').get(row.storyboard_id);\n        const isLast = ['last', 'storyboard_last', 'tail', 'last_frame'].includes(String(effectiveFrameTypeForBind || ''));\n        if (!adopted?.[isLast ? 'last_frame_image_url' : 'image_url'] && !adopted?.[isLast ? 'last_frame_local_path' : 'local_path']) bindStoryboardFrameImage(\n          db,\n          row.storyboard_id,\n          effectiveFrameTypeForBind,"],
    ['module.exports = {\n  list,', `const activeDownloadRecoveries = new Set();
async function retrySavedImageDownload(db, log, id) {
  id = Number(id);
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { ok: false, status: 404, error: '图片记录不存在' };
  if (row.status !== 'failed' || !row.image_url || activeDownloadRecoveries.has(id)) return { ok: false, status: 409, error: '仅可恢复带有原结果地址且未在恢复中的失败图片记录' };
  activeDownloadRecoveries.add(id);
  try {
    const cfg = require('../config').loadConfig();
    const storage = path.isAbsolute(cfg.storage.local_path) ? cfg.storage.local_path : path.resolve(cfg.storage.local_path);
    const subdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    const local = await uploadService.downloadImageToLocal(storage, row.image_url, 'images', log, 'recovered', subdir);
    if (!local) throw new Error('原结果仍无法下载；请检查供应商结果地址，不会重新提交生成');
    const recoveredImage = require('sharp')(path.join(storage, local));
    const metadata = await recoveredImage.metadata();
    if (!metadata.width || !metadata.height) throw new Error('下载结果不是有效图片');
    await recoveredImage.stats();
    const url = '/static/' + String(local).replace(/^\\//, '');
    const now = new Date().toISOString();
    db.prepare("UPDATE image_generations SET status = 'completed', image_url = ?, local_path = ?, error_msg = NULL, completed_at = ?, updated_at = ? WHERE id = ?").run(url, local, now, now, id);
    if (row.task_id) {
      const saved = db.prepare('SELECT result FROM async_tasks WHERE id = ?').get(row.task_id);
      let previous = {};
      try { const value = JSON.parse(saved?.result || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) previous = value; } catch (_) {}
      taskService.updateTaskResult(db, row.task_id, { ...previous, image_generation_id: id, image_url: url, local_path: local, status: 'completed' });
    }
    return { ok: true, item: getById(db, id) };
  } catch (error) {
    const message = '原图片下载或校验失败，已保留原记录；请检查结果地址和本地存储，不要重新提交生成';
    db.prepare("UPDATE image_generations SET error_msg = ?, updated_at = ? WHERE id = ?").run(message, new Date().toISOString(), id);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, message);
    return { ok: false, status: 422, error: message };
  } finally { activeDownloadRecoveries.delete(id); }
}

module.exports = {
  retrySavedImageDownload,
  list,`],
  ])
  patch('backend-node/src/routes/index.js', [
    ["  r.get('/images/:id', images.get);", `  r.post('/images/:id/resume-download', async (req, res) => {
    try {
      const result = await require('../services/imageService').retrySavedImageDownload(db, log, req.params.id);
      if (!result.ok) return response.error(res, result.status, 'MEDIA_DOWNLOAD_NOT_CONFIRMED', result.error);
      return response.success(res, result.item);
    } catch (error) {
      log.error('Image result recovery failed', { image_generation_id: req.params.id });
      return response.internalError(res, '原图片恢复失败，记录状态尚未确认；请检查平台存储后查询原记录');
    }
  });
  r.get('/images/:id', images.get);`],
  ])
  patch('backend-node/src/services/uploadService.js', [
    ["uploadUrl: (ip.upload_url || 'https://imageproxy.zhongzhuan.chat/api/upload').trim(),", "uploadUrl: ip.enabled === true && typeof ip.upload_url === 'string' ? ip.upload_url.trim() : '',"],
    ["uploadUrl: 'https://imageproxy.zhongzhuan.chat/api/upload',", "uploadUrl: '',"],
    ['  const { uploadUrl, timeoutMs, maxAttempts } = getImageProxyUploadSettings();', `  const { uploadUrl, timeoutMs, maxAttempts } = getImageProxyUploadSettings();
  if (!uploadUrl) {
    log.warn('当前协议需要公网参考图：请提供公网素材地址，或显式配置 image_proxy.enabled 和 image_proxy.upload_url；未上传到第三方图床', { tag });
    return null;
  }
  const address = new URL(uploadUrl);
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) throw new Error('image_proxy.upload_url 必须是无内嵌凭据的 HTTP(S) 地址');`],
  ])
  return pending
}
