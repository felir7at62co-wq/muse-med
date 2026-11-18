/** Pinned LocalMiniDrama corrections for explicit image/video configuration selection. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after, file) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama model selection patch does not match pinned source: ${file}`)
  }
  return source.replace(before, after)
}

const selectionHelpers = `
/** Invalid selections have no generation/task side effects and never trigger a model request. */
function invalidGenerationSelection() {
  const error = new Error('所选供应商或模型未配置或未启用，请检查 AI 配置后重试');
  error.code = 'MODEL_SELECTION_INVALID';
  return error;
}

/** Select only an active configuration matching every explicit request field. */
function selectGenerationConfig(configs, preferredModel, preferredProvider, normalizeModel = (id) => id) {
  if (preferredModel != null && typeof preferredModel !== 'string') throw invalidGenerationSelection();
  if (preferredProvider != null && typeof preferredProvider !== 'string') throw invalidGenerationSelection();
  const model = preferredModel == null ? '' : preferredModel.trim();
  const provider = preferredProvider == null ? '' : preferredProvider.trim().toLowerCase();
  if (preferredModel != null && !model || preferredProvider != null && !provider) throw invalidGenerationSelection();
  const candidates = configs.filter((c) => c.is_active && (!provider || String(c.provider || '').toLowerCase() === provider))
    .map((c) => ({ ...c, model: flattenModelIds(c.model).map((id) => normalizeModel(id, c)),
      default_model: c.default_model ? normalizeModel(pickModelId(c.default_model), c) : null }));
  const matching = model ? candidates.filter((c) => c.model.includes(normalizeModel(model, c))) : candidates;
  const selected = matching.find((c) => c.is_default) || matching[0];
  if (!selected || !selected.model.length || !String(selected.provider || '').trim()) throw invalidGenerationSelection();
  return selected;
}

/** Resolve the configured default or reject a removed or mismatched explicit model. */
function requireGenerationModel(config, preferredModel) {
  const models = flattenModelIds(config.model);
  const requested = preferredModel == null ? '' : String(preferredModel).trim();
  const selected = requested || pickModelId(config.default_model) || models[0];
  if (!selected || !models.includes(selected)) throw invalidGenerationSelection();
  return selected;
}

/** Text requests use OpenAI chat JSON/SSE; reject native Gemini and Anthropic endpoints. */
function assertTextChatConfig(config) {
  const protocol = String(config.api_protocol || '').trim().toLowerCase();
  const endpoint = String(config.endpoint || '').toLowerCase();
  if (!['', 'openai', 'volcengine', 'dashscope'].includes(protocol)
      || /generatecontent|(^|\\/)messages(?:[/?]|$)/.test(endpoint)
      || (!protocol && ['gemini', 'google', 'anthropic'].includes(String(config.provider || '').toLowerCase()) && !/chat\\/completions/.test(endpoint))) {
    const error = new Error('文本生成仅支持 OpenAI 兼容的聊天接口，请配置兼容的 Base URL、/chat/completions 端点和 openai 接口规范');
    error.code = 'TEXT_PROTOCOL_UNSUPPORTED';
    throw error;
  }
}
`;

/**
 * Plan all model-selection edits without writing any source files.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read the latest staged source at an absolute path.
 * @returns Absolute filenames paired with their complete replacement source.
 */
export function planModelSelection(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, change) => {
    const path = resolve(root, 'backend-node/src', file)
    const source = readSource(path).replace(/\r\n/g, '\n')
    pending.push([path, change(source, (text, before, after) => replaceOnce(text, before, after, file))])
  }
  patch('services/modelId.js', (source, replace) => replace(source, 'module.exports = {\n  flattenModelIds,', `${selectionHelpers}\nmodule.exports = {\n  selectGenerationConfig,\n  requireGenerationModel,\n  assertTextChatConfig,\n  flattenModelIds,`))
  patch('services/aiClient.js', (source, replace) => {
    source = replace(source, "const { flattenModelIds, pickModelId, remapArkModelId } = require('./modelId');", "const { flattenModelIds, pickModelId, remapArkModelId, selectGenerationConfig, requireGenerationModel, assertTextChatConfig } = require('./modelId');")
    source = replace(source, `function getConfigForModel(db, serviceType, modelName) {
  const configs = aiConfigService.listConfigs(db, serviceType);
  for (const config of configs) {
    if (!config.is_active) continue;
    const models = flattenModelIds(config.model);
    if (models.includes(modelName) || models.includes(remapArkModelId(config.base_url, modelName))) return config;
  }
  return null;
}`, `function getConfigForModel(db, serviceType, modelName) {
  return selectGenerationConfig(aiConfigService.listConfigs(db, serviceType), modelName, null, (id, config) => remapArkModelId(config.base_url, id));
}`)
    source = replace(source, 'function buildChatUrl(config) {', 'function buildChatUrl(config) {\n  assertTextChatConfig(config);')
    source = replace(source, `  const models = flattenModelIds(config?.model);
  const preferred = pickModelId(preferredModel);
  const fallback = pickModelId(config?.default_model);
  let picked = models[0] || 'gpt-3.5-turbo';
  if (preferred && (models.includes(preferred) || models.includes(remapArkModelId(config?.base_url, preferred)))) {
    picked = remapArkModelId(config?.base_url, preferred);
  } else if (fallback && models.includes(fallback)) {
    picked = fallback;
  }
  return resolveArkTextModel(config, picked);`, `  const normalized = { ...config,
    model: flattenModelIds(config.model).map((id) => resolveArkTextModel(config, id)),
    default_model: config.default_model ? resolveArkTextModel(config, config.default_model) : null };
  return requireGenerationModel(normalized, preferredModel == null ? null : resolveArkTextModel(config, preferredModel));`)
    source = replace(source, "  // F2: 若传入 scene_key，优先从 ai_model_map 查找对应的模型路由配置", "  if (preferredModel != null) getConfigForModel(db, serviceType, preferredModel);\n\n  // F2: 若传入 scene_key，优先从 ai_model_map 查找对应的模型路由配置")
    return replace(source, "  const { model: preferredModel, temperature = 0.7, json_mode = false, min_max_tokens = null, scene_key = null } = options;", "  const { model: preferredModel, temperature = 0.7, json_mode = false, min_max_tokens = null, scene_key = null } = options;\n  if (preferredModel != null) getConfigForModel(db, serviceType, preferredModel);")
  })
  patch('services/videoClient.js', (source, replace) => {
    source = replace(source, "const { flattenModelIds, pickModelId, ARK_RETIRED_VIDEO_MODELS } = require('./modelId');", "const { flattenModelIds, pickModelId, ARK_RETIRED_VIDEO_MODELS, selectGenerationConfig, requireGenerationModel } = require('./modelId');")
    source = replace(source, `function getDefaultVideoConfig(db, preferredModel) {
  const configs = aiConfigService.listConfigs(db, 'video');
  const active = configs.filter((c) => c.is_active);
  if (active.length === 0) return null;
  if (preferredModel) {
    for (const c of active) {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      if (models.includes(preferredModel)) return c;
    }
  }
  const defaultOne = active.find((c) => c.is_default);
  return defaultOne != null ? defaultOne : active[0];
}`, `function getDefaultVideoConfig(db, preferredModel, preferredProvider) {
  return selectGenerationConfig(aiConfigService.listConfigs(db, 'video'), preferredModel, preferredProvider, normalizeVolcModel);
}

/** Resolve the actual provider/model before creating a generation or submitting a request. */
function resolveVideoSelection(db, model, provider) {
  const config = getDefaultVideoConfig(db, model, provider);
  return { config, provider: config.provider, model: getModelFromConfig(config, model) };
}`)
    source = replace(source, `  const models = flattenModelIds(config?.model);
  const preferred = pickModelId(preferredModel);
  const fallback = pickModelId(config?.default_model);
  if (preferred && models.includes(preferred)) return preferred;
  if (fallback && models.includes(fallback)) return fallback;
  return models[0] || '';`, '  return requireGenerationModel(config, preferredModel == null ? null : normalizeVolcModel(preferredModel, config));')
    source = replace(source, '  const config = getDefaultVideoConfig(db, preferredModel);', '  const config = getDefaultVideoConfig(db, preferredModel, opts.provider);')
    return replace(source, 'module.exports = {\n  getDefaultVideoConfig,', 'module.exports = {\n  resolveVideoSelection,\n  getDefaultVideoConfig,')
  })
  patch('services/imageClient.js', (source, replace) => {
    source = replace(source, "const { flattenModelIds, pickModelId } = require('./modelId');", "const { flattenModelIds, pickModelId, selectGenerationConfig, requireGenerationModel } = require('./modelId');")
    source = replace(source, `  let active = configs.filter((c) => c.is_active);
  if (active.length === 0) return null;
  if (preferredProvider && String(preferredProvider).trim()) {
    const want = String(preferredProvider).trim().toLowerCase();
    const byProvider = active.filter((c) => (c.provider || '').toLowerCase() === want);
    if (byProvider.length > 0) active = byProvider;
  }
  if (preferredModel) {
    for (const c of active) {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      if (models.includes(preferredModel)) return c;
    }
  }
  // 显式使用前端设置的「默认」：优先 is_default，再按 priority 降序（listConfigs 已按 is_default DESC, priority DESC 排序，取第一个即可）
  const defaultOne = active.find((c) => c.is_default);
  if (defaultOne) return defaultOne;
  return active[0];`, '  return selectGenerationConfig(configs, preferredModel, preferredProvider, (id, config) => resolveDashScopeImageModel(config, id));')
    source = replace(source, `  const models = flattenModelIds(config?.model);
  const preferred = pickModelId(preferredModel);
  const fallback = pickModelId(config?.default_model);
  let picked = models[0] || 'dall-e-3';
  if (preferred && models.includes(preferred)) picked = preferred;
  else if (fallback && models.includes(fallback)) picked = fallback;
  return resolveDashScopeImageModel(config, picked);`, `  return requireGenerationModel(config, preferredModel == null ? null : resolveDashScopeImageModel(config, preferredModel));`)
    source = replace(source, 'function getModelFromConfig(config, preferredModel) {', `/** Resolve the actual provider/model before creating a generation or submitting a request. */
function resolveImageSelection(db, model, provider, imageServiceType) {
  const config = getDefaultImageConfig(db, model, provider, imageServiceType);
  return { config, provider: config.provider, model: getModelFromConfig(config, model) };
}

function getModelFromConfig(config, preferredModel) {`)
    source = replace(source, "  const preferredProvider = preferred_provider ?? opts.preferredProvider;", "  const preferredProvider = preferred_provider ?? opts.preferredProvider ?? opts.provider;")
    source = replace(source, 'function createAndGenerateImage(db, log, opts) {\n  const {', `function createAndGenerateImage(db, log, opts) {
  const selection = resolveImageSelection(db, opts.model, opts.provider);
  opts = { ...opts, model: selection.model, provider: selection.provider };
  const {`)
    source = replace(source, '        image_gen_id: imageGenId,\n        user_negative_prompt:', '        image_gen_id: imageGenId,\n        preferred_provider: provider,\n        user_negative_prompt:')
    return replace(source, 'module.exports = {\n  getDefaultImageConfig,', 'module.exports = {\n  resolveImageSelection,\n  getDefaultImageConfig,')
  })
  patch('routes/videos.js', (source, replace) => {
    source = replace(source, "const { normalizeAspectRatioForApi } = require('../services/videoClient');", "const { normalizeAspectRatioForApi, resolveVideoSelection } = require('../services/videoClient');")
    source = replace(source, "        const body = req.body || {};\n        const task =", "        const body = req.body || {};\n        const selection = resolveVideoSelection(db, body.model, body.provider);\n        const task =")
    source = replace(source, "        const provider = body.provider || 'chatfire';", '        const provider = selection.provider;')
    source = replace(source, '        const model = body.model ?? null;', '        const model = selection.model;')
    return replace(source, "        log.error('videos create', { error: err.message });", "        if (err.code === 'MODEL_SELECTION_INVALID') return response.badRequest(res, err.message);\n        log.error('videos create', { error: err.message });")
  })
  patch('services/videoService.js', (source, replace) => {
    // Both fresh submissions and persisted-task polling must retain the recorded provider.
    const before = 'const config = videoClient.getDefaultVideoConfig(db, row.model);'
    if (source.split(before).length !== 3) throw new Error('Pinned video configuration call sites changed')
    source = source.replaceAll(before, 'const config = videoClient.getDefaultVideoConfig(db, row.model, row.provider);')
    source = replace(source, `  const config = videoClient.getDefaultVideoConfig(db, row.model, row.provider);
  if (!config) {`, `  let config;
  try {
    config = videoClient.getDefaultVideoConfig(db, row.model, row.provider);
  } catch (error) {
    setVideoGenFailed(db, videoGenId, error.message, new Date().toISOString());
    if (row.task_id) taskService.updateTaskError(db, row.task_id, error.message);
    return;
  }
  if (!config) {`)
    return replace(source, "  if (!row) return { ok: false, status: 404, error: '记录不存在' };", `  if (!row) return { ok: false, status: 404, error: '记录不存在' };
  try {
    videoClient.resolveVideoSelection(db, row.model, row.provider);
  } catch (error) {
    if (error.code !== 'MODEL_SELECTION_INVALID') throw error;
    return { ok: false, status: 400, error: error.message };
  }`)
  })
  patch('services/imageService.js', (source, replace) => {
    source = replace(source, 'function create(db, log, req) {\n  const now =', `function create(db, log, req) {
  const selection = imageClient.resolveImageSelection(db, req.model, req.provider, req.storyboard_id ? 'storyboard_image' : 'image');
  req = { ...req, model: selection.model, provider: selection.provider };
  const now =`)
    source = replace(source, "    const imageServiceType = row.storyboard_id ? 'storyboard_image' : 'image';", "    const imageServiceType = row.storyboard_id ? 'storyboard_image' : 'image';\n    const config = imageClient.getDefaultImageConfig(db, row.model, row.provider, imageServiceType);")
    source = replace(source, '    const config = imageClient.getDefaultImageConfig(db, row.model, null, imageServiceType);\n', '')
    return replace(source, '      image_gen_id: imageGenId,\n      imageServiceType,', '      image_gen_id: imageGenId,\n      preferred_provider: row.provider,\n      imageServiceType,')
  })
  patch('routes/images.js', (source, replace) => replace(source, "        log.error('images create', { error: err.message });", "        if (err.code === 'MODEL_SELECTION_INVALID') return response.badRequest(res, err.message);\n        log.error('images create', { error: err.message });"))
  for (const [file, functions] of [
    ['characterLibraryService.js', ['function generateCharacterImage(db, log, cfg, characterId, modelName, style) {', 'async function generateCharacterFourViewImage(db, log, cfg, characterId, modelName, style) {']],
    ['sceneService.js', ['async function generateSceneFourViewImage(db, log, cfg, sceneId, modelName, style) {', 'async function generateSceneSingleImage(db, log, cfg, sceneId, modelName, style) {']],
  ]) {
    patch(`services/${file}`, (source, replace) => {
      for (const signature of functions) source = replace(source, signature, `${signature}\n  imageClient.resolveImageSelection(db, modelName);`)
      const before = "    provider: 'openai',"
      if (source.split(before).length !== 3) throw new Error(`Pinned asset provider call sites changed: ${file}`)
      return source.replaceAll(before, '')
    })
  }
  patch('services/propImageGenerationService.js', (source, replace) => {
    source = replace(source, "  const preferredProvider = !model && cfg?.ai?.default_image_provider ? cfg.ai.default_image_provider : null;", '  const preferredProvider = opts && opts.provider;')
    source = replace(source, "  const task = taskService.createTask(db, log, 'prop_image_generation', String(propId));", `  const selection = imageClient.resolveImageSelection(db, opts && opts.model, opts && opts.provider);
  opts = { ...opts, model: selection.model, provider: selection.provider };
  const task = taskService.createTask(db, log, 'prop_image_generation', String(propId));`)
    return source
  })
  return pending
}
