/** Preserve requested video image inputs through the route, queue and provider adapter. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after, file) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama video input patch does not match pinned source: ${file}`)
  }
  return source.replace(before, after)
}

function resolveVideoReferenceInputs(options, referenceField = 'reference_urls') {
  if (['voice_reference_url', 'reference_audio_url', 'reference_audio_urls', 'audio_url', 'audio_urls', 'formal_voice_references']
    .some(field => Object.hasOwn(options, field)) || Array.isArray(options.content)
      && options.content.some(part => part?.type === 'audio_url' || part?.role === 'reference_audio')) {
    const error = new Error('Save explicit character-period voice bindings before generation; raw audio fields are unsupported here.')
    error.code = 'formal_voice_binding_required'
    error.status = 400
    throw error
  }
  const opts = { ...options }
  for (const field of ['image_url', 'first_frame_url', 'last_frame_url', 'first_frame_local_path', 'last_frame_local_path']) {
    if (opts[field] == null) continue
    if (typeof opts[field] !== 'string' || !opts[field].trim()) throw referenceInputError()
    opts[field] = opts[field].trim()
  }
  for (const [url, local] of [['first_frame_url', 'first_frame_local_path'], ['last_frame_url', 'last_frame_local_path']]) {
    if (opts[url] && opts[local] && opts[url] !== opts[local]) throw referenceInputError()
    opts[url] = opts[url] || opts[local]
  }
  const refs = opts[referenceField]
  if (refs != null) {
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || !ref.trim())) throw referenceInputError()
    opts[referenceField] = refs.map(ref => ref.trim())
    if (new Set(opts[referenceField]).size !== refs.length) throw referenceInputError()
    if (opts[referenceField].some(ref => [opts.image_url, opts.first_frame_url, opts.last_frame_url].includes(ref))) throw referenceInputError()
  }
  if (opts.image_url && opts.first_frame_url && opts.image_url !== opts.first_frame_url) throw referenceInputError()
  if (opts.first_frame_url && opts.first_frame_url === opts.last_frame_url) throw referenceInputError()
  return opts
}

function requireVideoReferenceMode(protocol, model, opts) {
  const refs = opts.reference_urls || []
  const first = opts.first_frame_url || opts.first_frame_local_path
  const last = opts.last_frame_url || opts.last_frame_local_path
  const main = opts.image_url
  let limit = null
  if (protocol === 'agnes') {
    limit = isAgnesVideo25Model(model) ? isAgnesVideo25FlashModel(model) ? 5 : 9 : 10
    if (refs.length && (main || first || last) || !isAgnesVideo25Model(model) && last && !first && !main) throw referenceInputError()
  } else if (protocol === 'xai') {
    limit = 10 - (main || first ? 1 : 0)
  } else if (protocol === 'minimax_h3') {
    limit = 9
    if (refs.length && (main || first || last)) throw referenceInputError()
  } else if (protocol === 'dashscope') {
    if (['wanx2.1-vace-plus', 'wan2.6-r2v-flash'].includes(model)) {
      if (main || first || last) throw referenceInputError()
      limit = model === 'wanx2.1-vace-plus' ? 3 : 5
    } else {
      if (refs.length || model === 'wan2.6-i2v-flash' && last) throw referenceInputError()
    }
  } else if (protocol === 'veo3' && refs.length) throw referenceInputError()
  if (shouldUseVolcOmniMultiReference(protocol, model, refs) && (first || last)) throw referenceInputError()
  if (limit != null && refs.length > limit) throw referenceInputError()
}

/**
 * Plan complete source replacements after the model-selection and reference planners.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read staged source from earlier compatibility planners.
 * @returns Absolute paths and replacement sources without writing files.
 */
export function planVideoInputs(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, transform) => {
    const path = resolve(root, 'backend-node/src', file)
    pending.push([path, transform(readSource(path).replaceAll('\r\n', '\n'), file)])
  }
  patch('services/videoClient.js', (source, file) => {
    source = replaceOnce(source, 'async function callVideoApi(db, log, opts) {', `${resolveVideoReferenceInputs.toString()}\n\n${requireVideoReferenceMode.toString()}\n\nasync function callVideoApi(db, log, opts) {\n  opts = resolveVideoReferenceInputs(opts);`, file)
    source = replaceOnce(source, '  const protocol = resolveVideoProtocol(config, preferredModel);', '  const protocol = resolveVideoProtocol(config, preferredModel);\n  requireVideoReferenceMode(protocol, model, opts);', file)
    source = replaceOnce(source, "const singleFrameProtocols = ['xai', 'gemini', 'vidu', 'kling', 'sora'];", "const singleFrameProtocols = ['xai', 'gemini', 'vidu', 'kling', 'sora', 'veo3'];", file)
    source = replaceOnce(source, '      if (r?.value) resolvedRefStrings.push(r.value);', '      resolvedRefStrings.push(requireResolvedReference(r?.value));', file)
    source = replaceOnce(source, "    const resolved = await resolveVeo3ImageForApi(rawMain, storage_local_path, log, String(video_gen_id || ''));", "    const resolved = await resolveVeo3ImageForApi(rawMain, storage_local_path, log, String(video_gen_id || ''));\n    requireResolvedReference(resolved?.value);", file)
    source = replaceOnce(source, "  return { kind: 'url', value: raw };\n}\n\n/**\n * Veo3", "  return { kind: 'url', value: requireResolvedReference(raw) };\n}\n\n/**\n * Veo3", file)
    return replaceOnce(source, 'module.exports = {\n  resolveVideoSelection,', 'module.exports = {\n  resolveVideoReferenceInputs,\n  resolveVideoSelection,', file)
  })
  patch('routes/videos.js', (source, file) => {
    source = replaceOnce(source, "const { normalizeAspectRatioForApi, resolveVideoSelection } = require('../services/videoClient');", "const { normalizeAspectRatioForApi, resolveVideoSelection, resolveVideoReferenceInputs } = require('../services/videoClient');", file)
    source = replaceOnce(source, '        const body = req.body || {};\n        const selection', "        const body = resolveVideoReferenceInputs(req.body || {}, 'reference_image_urls');\n        const selection", file)
    source = replaceOnce(source, 'JSON.stringify(body.reference_image_urls.slice(0, 10))', 'JSON.stringify(body.reference_image_urls)', file)
    return replaceOnce(source, "        if (err.code === 'MODEL_SELECTION_INVALID') return response.badRequest(res, err.message);", "        if (['MODEL_SELECTION_INVALID', 'REFERENCE_INPUT_UNAVAILABLE', 'formal_voice_binding_required'].includes(err.code)) return response.badRequest(res, err.message);", file)
  })
  patch('services/videoService.js', (source, file) => {
    for (const field of ['image_url', 'first_frame_url', 'last_frame_url']) {
      source = replaceOnce(source, `${field}: hasOmniRefs ? undefined : row.${field},`, `${field}: row.${field},`, file)
    }
    return source
  })
  return pending
}
