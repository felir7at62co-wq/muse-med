/** Refuse generation requests that would silently omit an explicitly requested image reference. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('Pinned reference-input anchor changed')
  return source.replace(before, after)
}

function changeFunction(source, name, digest, change) {
  let start = source.indexOf(`async function ${name}(`)
  if (start < 0) start = source.indexOf(`function ${name}(`)
  const end = source.indexOf('\n}', start) + 2
  const original = source.slice(start, end)
  if (start < 0 || end < 2 || createHash('sha256').update(original).digest('hex') !== digest) throw new Error(`Pinned reference-input function changed: ${name}`)
  return source.slice(0, start) + change(original) + source.slice(end)
}

function referenceInputError() {
  const error = new Error('参考图未能完整读取或转换，尚未提交生成；请检查原图地址、本地文件和已启用的图床配置后重试')
  error.code = 'REFERENCE_INPUT_UNAVAILABLE'
  return error
}

function requireResolvedReference(value) {
  const text = value == null ? '' : String(value).trim()
  if (/^data:[^;]+;base64,.+/s.test(text) || text.startsWith('asset://') && text.length > 8) return value
  let address
  try { address = new URL(text) } catch (error) { throw referenceInputError() }
  if (!['http:', 'https:'].includes(address.protocol) || /^(localhost|127\..*|0\.0\.0\.0|\[::1\])$/i.test(address.hostname)) throw referenceInputError()
  return value
}

const helperSource = `${referenceInputError.toString()}\n\n${requireResolvedReference.toString()}\n\n`

/**
 * Plan strict reference retention without writing source files.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Read the latest staged source at an absolute path.
 * @returns Absolute filenames paired with complete replacement source.
 */
export function planReferences(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (name, transform) => {
    const path = resolve(root, 'backend-node/src/services', name)
    pending.push([path, transform(readSource(path).replaceAll('\r\n', '\n'))])
  }
  patch('videoClient.js', source => {
    source = replaceOnce(source, "const fs = require('fs');", helperSource + "const fs = require('fs');")
    source = changeFunction(source, 'callAgnesVideoApi', '9bd94e4e1133c4a733a30a5f27138f4371645d0564798bea012240eacd5fdf15', fn => {
      fn = replaceOnce(fn, '    if (r && !seen.has(r)) {', '    requireResolvedReference(r);\n    if (r && !seen.has(r)) {')
      return replaceOnce(fn, '  let body;\n  let imageStrategy;', '  if (useOmniReference && (rawFirst || rawLast)) throw referenceInputError();\n  if (!useOmniReference && ((rawFirst && !firstResolved) || (rawLast && !lastResolved))) throw referenceInputError();\n\n  let body;\n  let imageStrategy;')
    })
    source = changeFunction(source, 'callViduVideoApi', '7ec5707aa9b4a79bafb3bd1097e6f0a70ace0364c9d1f4d37bb616c64700e764', fn => {
      const from = fn.indexOf('    if (/localhost|127\\.0\\.0\\.1/i.test(rawImgUrl)) {')
      const to = fn.indexOf('    if (publicImgUrl) {', from + 1)
      // The first nested success branch belongs to the old proxy logic.
      const end = fn.indexOf('    if (publicImgUrl) {\n      let imageUrlForVidu', to)
      if (from < 0 || end < 0) throw new Error('Pinned Vidu image resolution changed')
      return fn.slice(0, from) + `    if (isPublicHttpUrl(rawImgUrl)) publicImgUrl = rawImgUrl;
    else {
      publicImgUrl = publicUrlFromLocalRef(rawImgUrl, files_base_url);
      if (!publicImgUrl && storage_local_path) publicImgUrl = await uploadLocalImageToProxy(storage_local_path, rawImgUrl, log, 'vidu_vg' + video_gen_id);
    }
    requireResolvedReference(publicImgUrl);
` + fn.slice(end)
    })
    for (const [name, digest, anchor, replacement] of [
      ['callVolcengineOmniVideoApi', 'fa7685887005f8d465faf278acf6825789350c4b01bbd307eae36223297771ba', '  const urls = orderedUrls.slice(0, maxRef);', '  if (orderedUrls.length > maxRef) throw referenceInputError();\n  const urls = orderedUrls;'],
      ['callKlingOmniVideoApi', '5cd60fd68f6f7e3b0d235e56ec47dd82e01d39d369586234c02476a7f3279180', '    if (!resolved) continue;', '    requireResolvedReference(resolved);'],
      ['callJimengAiApiVideo', '86d11fd11f1185df82240c11ef684999ede231f048b0bfab98dd886ea82f04e1', '  if (seedance && fileParts.length === 0) {', '  if (fileParts.length !== orderedUrls.length) throw referenceInputError();\n  if (seedance && fileParts.length === 0) {'],
    ]) source = changeFunction(source, name, digest, fn => replaceOnce(fn, anchor, replacement))
    source = changeFunction(source, 'resolveImageInputForOmniLocalBase64', 'db1b4e6dbe869290954767c2cad1b837a346b3c9fc7d57741c13d9769694cf0b', fn => replaceOnce(fn, '  return raw;\n}', "  return resolveVolcClassicImage(raw, files_base_url, storage_local_path, log, video_gen_id, 'reference');\n}"))
    source = changeFunction(source, 'resolveVolcClassicImage', '3381764dcd56933351ef94a403da883e8b4e0b30d5c83199741e34f50e6fd0ac', fn => replaceOnce(fn, '  return u;\n}', '  return requireResolvedReference(u);\n}'))
    source = changeFunction(source, 'resolveSoraImageToDataUrl', 'da2094a61f34fbc8470523916b5d1161baec6751253d73d4c9e0009bb05c8141', fn => {
      fn = replaceOnce(fn, '  if (/localhost|127\\.0\\.0\\.1/i.test(raw) && storage_local_path) {', '  if ((/localhost|127\\.0\\.0\\.1/i.test(raw) || !/^https?:\\/\\//i.test(raw)) && storage_local_path) {')
      fn = replaceOnce(fn, "      const afterStatic = raw.split('/static/')[1];", "      const afterStatic = raw.split('/static/')[1] || (!/^https?:\\/\\//i.test(raw) ? raw.replace(/^\\/+/, '') : null);")
      return replaceOnce(fn, "        const localFile = path.join(storage_local_path, afterStatic.replace(/^\\//, ''));", "        const localFile = path.resolve(storage_local_path, afterStatic.replace(/^\\//, ''));\n        const relative = path.relative(path.resolve(storage_local_path), localFile);\n        if (relative.startsWith('..') || path.isAbsolute(relative)) throw referenceInputError();")
    })
    source = changeFunction(source, 'callSoraVideoApi', 'd733a949da122e9d577dfa3a521c5758b1b29966b65759569f67bfb933c3bacf', fn => {
      fn = replaceOnce(fn, "    const rawList = (refList.length > 0 ? refList : [(image_url || '').trim()]).slice(0, maxImages);", "    const primary = (image_url || '').trim();\n    const rawList = [...(primary ? [primary] : []), ...refList.filter(ref => ref !== primary)];\n    if (rawList.length > maxImages) throw referenceInputError();")
      fn = replaceOnce(fn, '      if (resolved) images.push(resolved);', '      images.push(requireResolvedReference(resolved));')
      fn = replaceOnce(fn, "  const rawImgUrl = (image_url || '').trim();", `  let rawImgUrl = (image_url || '').trim();
  if (rawImgUrl && !rawImgUrl.startsWith('data:') && (!/^https?:\\/\\//i.test(rawImgUrl) || /localhost|127\\.0\\.0\\.1/i.test(rawImgUrl))) {
    rawImgUrl = requireResolvedReference(await resolveSoraImageToDataUrl(rawImgUrl, storage_local_path, log, video_gen_id, 0));
  }`)
      return replaceOnce(fn, '  // ?? ???? resize ?? size ???Sora ?????????????????', '  if (rawImgUrl && (!imageBuffer || !imageBuffer.length)) throw referenceInputError();\n\n  // ?? ???? resize ?? size ???Sora ?????????????????')
    })
    source = changeFunction(source, 'callDashScopeVideoApi', 'dbbd76fcdfdab78cfe137530abf06a50d2d42e6574744106da2a0c7e74974bb8', fn => {
      fn = replaceOnce(fn, '  async function toImageInput(value) {\n    if (!value || !String(value).trim()) return null;', "  async function toImageInput(value) {\n    if (!value || !String(value).trim()) return null;\n    if (String(value).trim().startsWith('data:')) return requireResolvedReference(String(value).trim());")
      for (const limit of [3, 5]) {
        fn = replaceOnce(fn, `    const rawRefs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean).slice(0, ${limit}) : [];`, `    const rawRefs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean) : [];\n    if (rawRefs.length > ${limit}) throw referenceInputError();`)
      }
      const anchor = '    const refs = rawRefs.map(toImageInput).filter(Boolean);'
      if (fn.split(anchor).length !== 3) throw new Error('Pinned DashScope multi-reference calls changed')
      fn = fn.replaceAll(anchor, '    const refs = (await Promise.all(rawRefs.map(toImageInput))).map(requireResolvedReference);')
      return replaceOnce(fn, "  } else if (model === 'wan2.6-t2v') {", "  } else if (model === 'wan2.6-t2v') {\n    if (image_url || first_frame_url || last_frame_url || reference_urls?.some(Boolean)) throw referenceInputError();")
    })
    source = changeFunction(source, 'callMinimaxH3VideoApi', '5ed773c4e0f2ddbda7db4f354713be0fe3e075d7695b73219f3e5339cdb93b30', fn => replaceOnce(fn, '  const useFirstLast = !!(firstForApi || lastForApi);', '  const useFirstLast = !!(firstForApi || lastForApi);\n  if (refs.length > 9 || refs.length && useFirstLast) throw referenceInputError();'))
    source = replaceOnce(source, '  const protocol = resolveVideoProtocol(config, preferredModel);', `  const protocol = resolveVideoProtocol(config, preferredModel);
  const requestedFirst = opts.first_frame_url || opts.first_frame_local_path;
  const requestedLast = opts.last_frame_url || opts.last_frame_local_path;
  const requestedRefs = Array.isArray(opts.reference_urls) && opts.reference_urls.some(Boolean);
  const singleFrameProtocols = ['xai', 'gemini', 'vidu', 'kling', 'sora'];
  if (singleFrameProtocols.includes(protocol)) {
    if (requestedLast || requestedFirst && opts.image_url && requestedFirst !== opts.image_url) throw referenceInputError();
    if (requestedFirst) opts = { ...opts, image_url: requestedFirst };
  }
  if (['kling_omni', 'volcengine_omni'].includes(protocol) && (requestedFirst || requestedLast)) throw referenceInputError();
  if (requestedRefs && ['gemini', 'vidu', 'kling'].includes(protocol)) throw referenceInputError();
  if (requestedRefs && protocol === 'sora' && !configSupportsUniversalOmni(config)) throw referenceInputError();`)
    return replaceOnce(source, '  const url = buildVideoUrl(config);\n  const dur = duration ? Number(duration) : 5;', '  if (opts.reference_urls?.some(Boolean)) throw referenceInputError();\n  const url = buildVideoUrl(config);\n  const dur = duration ? Number(duration) : 5;')
  })
  patch('imageClient.js', source => {
    source = replaceOnce(source, "const fs = require('fs');", helperSource + "const fs = require('fs');")
    source = replaceOnce(source, "  const protocol = (config.api_protocol || '').toLowerCase() || inferProtocol(provider, model);", "  const protocol = (config.api_protocol || '').toLowerCase() || inferProtocol(provider, model);\n  if (protocol === 'kling' && opts.reference_image_urls?.filter(Boolean).length > 1) throw referenceInputError();")
    source = changeFunction(source, 'callGeminiImageApi', '73d4e9001390e471b1c7a95e31613a5d543a4fec63dda4e88b3283345dcf6a83', fn => {
      fn = replaceOnce(fn, '  // 解析 system_prompt 中的每张参考图标签', '  if (rawRefs.length > MAX_GEMINI_REF_IMAGES) throw referenceInputError();\n\n  // 解析 system_prompt 中的每张参考图标签')
      const end = fn.indexOf('  // 构建 parts：')
      const before = fn.slice(0, end)
      if (end < 0 || before.split('continue;').length !== 8) throw new Error('Pinned Gemini reference skip paths changed')
      return before.replaceAll('continue;', 'throw referenceInputError();').replaceAll('跳过', '未提交生成') + fn.slice(end)
    })
    source = changeFunction(source, 'resolveImageRef', 'c4b7c4af7e7151503e1a3dd724a728b60afbd6193fb39d78e2294088a9439f17', fn => {
      fn = replaceOnce(fn, '  const s = String(value).trim();', "  const s = String(value).trim();\n  if (s.startsWith('data:')) return requireResolvedReference(s);")
      fn = replaceOnce(fn, "    relPath = s.replace(/^\\//, '');", "    relPath = (s.startsWith('/static/') ? s.slice('/static/'.length) : s).replace(/^\\//, '');")
      const anchor = 'return toPublicUrl(s);'
      if (fn.split(anchor).length !== 4) throw new Error('Pinned image reference fallback paths changed')
      return fn.replaceAll(anchor, 'return requireResolvedReference(toPublicUrl(s));')
    })
    return changeFunction(source, 'callDashScopeImageApi', '6e62a9327c003ff64078bc936f5e22a9d35de64a0a09710a27a5c65a585c34dc', fn => {
      fn = replaceOnce(fn, '  if (isQwenImage) {', '  if (isQwenImage) {\n    if (reference_image_urls?.some(Boolean)) throw referenceInputError();')
      return replaceOnce(fn, '  for (const ref of refs.slice(0, 10)) {', '  if (refs.length > 10) throw referenceInputError();\n  for (const ref of refs) {')
    })
  })
  return pending
}
