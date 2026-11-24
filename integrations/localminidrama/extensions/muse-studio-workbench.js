/** Gallery selection and free, receipt-backed edits; supplier generation belongs to Muse. */
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
const clone = value => JSON.parse(JSON.stringify(value))
const blankDraft = () => ({ imagePrompt: '', videoPrompt: '', imageBindings: [], videoBindings: [] })

/**
 * Split a stored prompt into text and exact reference tokens without interpreting HTML.
 * @param text - Prompt belonging to this revision or generation.
 * @param bindings - References captured with that same prompt.
 * @returns Ordered text, bound asset or unavailable-token pieces.
 */
export function studioPromptParts(text, bindings = []) {
  const parts = [], source = typeof text === 'string' ? text : '', byId = new Map(bindings.map(item => [item.bindingId, item]))
  let offset = 0
  for (const match of source.matchAll(/@asset\(([A-Za-z0-9_-]{1,64})\)/g)) {
    if (match.index > offset) parts.push({ kind: 'text', text: source.slice(offset, match.index) })
    const binding = byId.get(match[1])
    parts.push(binding ? { kind: 'asset', text: match[0], binding } : { kind: 'missing', text: match[0] })
    offset = match.index + match[0].length
  }
  if (offset < source.length) parts.push({ kind: 'text', text: source.slice(offset) })
  return parts
}

/**
 * Create document-local state. Callers may make it reactive before creating the controller.
 * @returns Empty state with no inferred generation or workflow status.
 */
export function createStudioWorkbenchState() {
  return { projectId: null, project: null, episodeId: null, packages: [], packageId: null, trace: null,
    versionId: null, loading: false, traceLoading: false, loadingMore: false, saving: false,
    error: '', traceError: '', notice: '', stale: false, draft: blankDraft(), baseline: '',
    pending: null, pendingMissing: false }
}

function validateTrace(value, packageId) {
  if (!value || value.schema !== 'muse-studio-package-v1' || value.packageId !== packageId
    || !positive(value.projectId) || !positive(value.episodeId) || typeof value.databaseId !== 'string'
    || !value.current || typeof value.current.snapshotSha256 !== 'string'
    || !Array.isArray(value.current.imageBindings) || !Array.isArray(value.current.videoBindings)
    || !Array.isArray(value.videos?.items) || !Array.isArray(value.images?.items) || !Array.isArray(value.assets)) {
    throw new Error('制作包记录无法核对，请重新读取')
  }
  for (const version of [...value.videos.items, ...value.images.items]) {
    if (!positive(version.generationId) || !version.inputs || !Array.isArray(version.inputs.bindings)
      || !Array.isArray(version.inputs.references)) throw new Error('生成版本记录不完整，请重新读取')
  }
  return value
}

function draftOf(current) {
  return { imagePrompt: current.imagePrompt, videoPrompt: current.videoPrompt,
    imageBindings: clone(current.imageBindings), videoBindings: clone(current.videoBindings) }
}

/**
 * Bind a private gallery controller to the existing HTTP client and document state.
 * @param options - Reactive state, authenticated request client and browser storage/crypto owners.
 * @returns Selection, query and free-edit actions; dispose fences every outstanding response.
 */
export function createStudioWorkbenchController({ state, request, storage = globalThis.localStorage, crypto = globalThis.crypto }) {
  let epoch = 0, traceEpoch = 0, alive = true, reads = new AbortController(), traceRead = new AbortController()
  const current = (ticket, projectId) => alive && epoch === ticket && state.projectId === projectId
  const pendingKey = databaseId => 'muse-studio-pending:' + databaseId
  const dirty = () => state.baseline !== '' && JSON.stringify(state.draft) !== state.baseline
  const message = error => error?.response?.data?.error?.message || error?.message || '操作未确认，请核对原记录'
  const persistPending = pending => {
    storage.setItem(pendingKey(pending.databaseId), JSON.stringify(pending))
    if (storage.getItem(pendingKey(pending.databaseId)) !== JSON.stringify(pending)) throw new Error('无法保留原保存编号，请先检查浏览器存储')
    state.pending = pending
    state.pendingMissing = false
  }
  const clearPending = pending => {
    const stored = storage.getItem(pendingKey(pending.databaseId))
    if (stored && JSON.parse(stored).operationId !== pending.operationId) throw new Error('另一个窗口已更改保存记录，请重新读取')
    storage.removeItem(pendingKey(pending.databaseId))
    state.pending = null
    state.pendingMissing = false
  }
  const restorePending = databaseId => {
    const raw = storage.getItem(pendingKey(databaseId))
    if (!raw) return
    const pending = JSON.parse(raw)
    if (pending.databaseId !== databaseId || !positive(pending.packageId) || !positive(pending.projectId)
      || typeof pending.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(pending.operationId)
      || !['revision', 'adopt', 'capture'].includes(pending.kind) || typeof pending.path !== 'string'
      || !pending.body || !pending.draft) throw new Error('原保存记录无法核对，请保留浏览器数据并读取项目记录')
    const expectedPath = pending.kind === 'capture' ? '/muse/studio/assets/versions'
      : '/muse/studio/packages/' + pending.packageId + (pending.kind === 'revision' ? '/revisions' : '/adopt')
    if (pending.path !== expectedPath || pending.kind !== 'capture' && pending.body.databaseId !== databaseId
      || pending.kind === 'capture' && pending.body.projectId !== pending.projectId) {
      throw new Error('原保存目标无法核对，请保留原记录并检查项目')
    }
    state.pending = pending
    if (pending.packageId === state.packageId && pending.projectId === state.projectId) {
      state.draft = clone(pending.draft)
      state.notice = '有一次保存尚未确认，原草稿和编号已保留，请先读取原回执'
    }
  }
  async function selectPackage(packageId, { keepDraft = false } = {}) {
    if (!positive(packageId)) return
    const changed = state.packageId !== Number(packageId), previousDraft = clone(state.draft)
    state.packageId = Number(packageId)
    if (changed) { state.trace = null; state.versionId = null; state.draft = blankDraft(); state.baseline = '' }
    traceRead.abort(); traceRead = new AbortController()
    const ticket = ++traceEpoch, projectId = state.projectId, owner = epoch
    state.traceLoading = true; state.traceError = ''
    try {
      const value = validateTrace(await request.get('/muse/studio/packages/' + state.packageId,
        { signal: traceRead.signal }), Number(packageId))
      if (!current(owner, projectId) || ticket !== traceEpoch || value.projectId !== projectId || value.episodeId !== state.episodeId) return
      state.trace = value; state.stale = false
      state.baseline = JSON.stringify(draftOf(value.current))
      state.draft = keepDraft ? previousDraft : draftOf(value.current)
      if (!value.videos.items.some(item => item.generationId === state.versionId)) {
        state.versionId = (value.videos.items.find(item => item.adopted) || value.videos.items[0])?.generationId ?? null
      }
      restorePending(value.databaseId)
    } catch (error) {
      if (current(owner, projectId) && ticket === traceEpoch) state.traceError = message(error)
    } finally { if (current(owner, projectId) && ticket === traceEpoch) state.traceLoading = false }
  }
  async function selectEpisode(episodeId, preferredPackageId) {
    if (!positive(episodeId) || !state.project?.episodes?.some(item => item.id === Number(episodeId))) return
    reads.abort(); reads = new AbortController(); traceRead.abort(); ++traceEpoch
    const owner = ++epoch, projectId = state.projectId
    const changed = state.episodeId !== Number(episodeId)
    state.episodeId = Number(episodeId); state.error = ''; state.loading = true
    if (changed) { state.packages = []; state.packageId = null; state.trace = null; state.draft = blankDraft(); state.baseline = '' }
    try {
      const value = await request.get('/muse/packages/episodes/' + state.episodeId, { signal: reads.signal })
      if (!current(owner, projectId)) return
      if (!value || value.episode_id !== state.episodeId || !Array.isArray(value.items)) throw new Error('本集制作包无法核对，请重新读取')
      state.packages = value.items
      const candidate = [preferredPackageId, state.packageId].find(id => value.items.some(item => item.id === Number(id)))
      const target = candidate ? Number(candidate) : value.items[0]?.id
      if (target) await selectPackage(target, { keepDraft: !changed && dirty() })
      else { state.packageId = null; state.trace = null }
    } catch (error) { if (current(owner, projectId)) state.error = message(error) }
    finally { if (current(owner, projectId)) state.loading = false }
  }
  async function loadProject(projectId, preferredEpisodeId, preferredPackageId) {
    if (!positive(projectId)) { state.error = '项目地址无效，请返回项目列表'; return }
    reads.abort(); reads = new AbortController(); traceRead.abort(); ++traceEpoch
    const owner = ++epoch, changed = state.projectId !== Number(projectId)
    state.projectId = Number(projectId); state.loading = true; state.error = ''
    if (changed) {
      state.project = null; state.episodeId = null; state.packages = []; state.packageId = null
      state.trace = null; state.draft = blankDraft(); state.baseline = ''; state.pending = null; state.notice = ''
      state.saving = false; state.loadingMore = false; state.traceLoading = false
    }
    try {
      const project = await request.get('/dramas/' + state.projectId, { signal: reads.signal })
      if (!current(owner, Number(projectId))) return
      if (!project || project.id !== Number(projectId) || !Array.isArray(project.episodes)) throw new Error('项目记录无法核对，请重新读取')
      state.project = project
      const candidate = [preferredEpisodeId, state.episodeId].find(id => project.episodes.some(item => item.id === Number(id)))
      const target = candidate ? Number(candidate) : project.episodes[0]?.id
      if (target) await selectEpisode(target, preferredPackageId)
      else {
        state.episodeId = null; state.packages = []; state.packageId = null; state.trace = null
        if (dirty()) state.notice = '当前项目已没有可读取的分集，原草稿仍保留，请先核对项目记录'
      }
    } catch (error) { if (current(owner, Number(projectId))) state.error = message(error) }
    finally { if (current(owner, Number(projectId))) state.loading = false }
  }
  async function moreVersions(kind) {
    if (!state.trace || state.loadingMore) return
    const list = kind === 'video' ? state.trace.videos : state.trace.images
    if (!list.nextCursor) return
    const owner = epoch, ticket = traceEpoch, projectId = state.projectId, packageId = state.packageId
    state.loadingMore = true
    try {
      const value = validateTrace(await request.get('/muse/studio/packages/' + packageId,
        { params: { [kind === 'video' ? 'videoCursor' : 'imageCursor']: list.nextCursor }, signal: traceRead.signal }), packageId)
      if (!current(owner, projectId) || ticket !== traceEpoch || value.databaseId !== state.trace.databaseId) return
      const next = kind === 'video' ? value.videos : value.images
      const byId = new Map(list.items.map(item => [item.generationId, item]))
      for (const item of next.items) if (!byId.has(item.generationId)) byId.set(item.generationId, item)
      state.trace[kind === 'video' ? 'videos' : 'images'] = { items: [...byId.values()], nextCursor: next.nextCursor }
      if (value.current.snapshotSha256 !== state.trace.current.snapshotSha256) state.stale = true
    } catch (error) { if (current(owner, projectId) && ticket === traceEpoch) state.traceError = message(error) }
    finally { if (current(owner, projectId) && ticket === traceEpoch) state.loadingMore = false }
  }
  const snapshot = () => {
    if (!state.trace || state.traceError || state.stale) throw new Error('请先重新读取当前版本，草稿仍保留')
    return { databaseId: state.trace.databaseId, expectedSnapshotSha256: state.trace.current.snapshotSha256 }
  }
  function addBinding(version, field, bindingId = crypto.randomUUID().replaceAll('-', '_'), cursor) {
    const promptKey = field === 'image' ? 'imagePrompt' : 'videoPrompt', refsKey = field === 'image' ? 'imageBindings' : 'videoBindings'
    const existing = state.draft[refsKey].find(item => item.versionId === version.versionId)
    const id = existing?.bindingId || bindingId, token = '@asset(' + id + ')'
    if (!existing) state.draft[refsKey].push({ ...version, bindingId: id, referenceToken: token })
    const text = state.draft[promptKey], at = Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, text.length)) : text.length
    state.draft[promptKey] = text.slice(0, at) + (at && !/\s$/.test(text.slice(0, at)) ? ' ' : '') + token + ' ' + text.slice(at)
  }
  function removeBinding(bindingId, field) {
    const promptKey = field === 'image' ? 'imagePrompt' : 'videoPrompt', refsKey = field === 'image' ? 'imageBindings' : 'videoBindings'
    const binding = state.draft[refsKey].find(item => item.bindingId === bindingId)
    if (!binding) return
    state.draft[promptKey] = state.draft[promptKey].split(binding.referenceToken).join('')
    state.draft[refsKey] = state.draft[refsKey].filter(item => item.bindingId !== bindingId)
  }
  async function newOperation(kind, path, body, context = {}) {
    if (state.pending) throw new Error('请先核对原保存回执，再提交其他修改')
    const pending = { operationId: crypto.randomUUID(), databaseId: state.trace.databaseId, projectId: state.projectId,
      packageId: state.packageId, episodeId: state.episodeId, kind, path, body, context, draft: clone(state.draft) }
    persistPending(pending)
    return await executePending(pending)
  }
  async function acceptResult(pending, result) {
    if (!alive || pending.projectId !== state.projectId || pending.databaseId !== state.trace?.databaseId) return
    if (pending.kind === 'capture') {
      if (!result || result.assetId !== pending.body.assetId || result.assetKind !== pending.body.assetKind
        || typeof result.versionId !== 'string' || typeof result.sha256 !== 'string') throw new Error('参考图版本无法核对，请读取原回执')
      if (state.packageId !== pending.packageId) throw new Error('请先返回原制作包，再恢复这次参考图操作')
      state.draft = clone(pending.draft)
      addBinding(result, pending.context.field, pending.context.bindingId, pending.context.cursor)
      clearPending(pending)
      state.notice = '参考图已保存并绑定到提示词，保存内容后成为新修订；未付费生成'
    } else {
      if (!result || result.databaseId !== pending.databaseId || !result.current) throw new Error('保存回执无法核对，请重新读取原记录')
      clearPending(pending)
      await selectPackage(pending.packageId)
      if (pending.kind === 'adopt') {
        const owner = epoch, projectId = state.projectId, episodeId = state.episodeId
        const results = await Promise.allSettled([request.get('/dramas/' + projectId), request.get('/muse/packages/episodes/' + episodeId)])
        if (!current(owner, projectId)) return
        const [project, packages] = results
        if (project.status === 'fulfilled' && project.value?.id === projectId) state.project = project.value
        if (packages.status === 'fulfilled' && packages.value?.episode_id === episodeId && Array.isArray(packages.value.items)) state.packages = packages.value.items
        if (results.some(item => item.status === 'rejected')) state.error = '采用已保存，画廊尚未更新，请重新读取项目记录'
      }
      state.notice = pending.kind === 'adopt' ? '已切换采用版本，其他生成记录仍保留；尚未代表最终验收' : '已保存新修订，旧视频的提示词和参考图保持原样；未付费生成'
    }
  }
  async function executePending(pending) {
    if (state.saving) return
    const owner = epoch, projectId = state.projectId
    state.saving = true; state.notice = ''
    try {
      const result = await request.post(pending.path, { ...pending.body, operationId: pending.operationId })
      if (!current(owner, projectId)) return
      await acceptResult(pending, result)
    } catch (error) {
      if (current(owner, projectId)) {
        state.notice = message(error) + '。原草稿和编号仍保留，请先读取原回执'
        if (error?.response?.data?.error?.committed === false) persistPending({ ...state.pending, rejected: true })
      }
    } finally { if (current(owner, projectId)) state.saving = false }
  }
  async function saveRevision() {
    if (state.saving) return
    state.notice = ''
    try {
      const input = { ...snapshot(), imagePrompt: state.draft.imagePrompt, videoPrompt: state.draft.videoPrompt }
      for (const [field, prompt] of [['imageBindings', input.imagePrompt], ['videoBindings', input.videoPrompt]]) {
        const parts = studioPromptParts(prompt, state.draft[field])
        if (parts.some(part => part.kind === 'missing')) throw new Error('提示词中有未绑定的参考图，请重新选择或移除该引用')
        const ordered = new Map()
        for (const part of parts) if (part.kind === 'asset' && !ordered.has(part.binding.bindingId)) ordered.set(part.binding.bindingId, part.binding)
        input[field] = [...ordered.values()].map(({ bindingId, assetKind, assetId, versionId }) => ({ bindingId, assetKind, assetId, versionId }))
      }
      await newOperation('revision', '/muse/studio/packages/' + state.packageId + '/revisions', input)
    } catch (error) { state.notice = message(error) }
  }
  async function adoptVersion(version) {
    if (state.saving) return
    try {
      if (dirty()) throw new Error('请先保存或放弃当前草稿，再切换采用版本')
      if (version.status !== 'completed' || !version.mediaUrl) throw new Error('仅可采用已完成并可读取的同包版本')
      await newOperation('adopt', '/muse/studio/packages/' + state.packageId + '/adopt',
        { ...snapshot(), kind: version.kind, generationId: version.generationId })
    } catch (error) { state.notice = message(error) }
  }
  async function captureAsset(asset, field, cursor) {
    if (state.saving) return
    try {
      snapshot()
      await newOperation('capture', '/muse/studio/assets/versions', { projectId: state.projectId,
        assetKind: asset.assetKind, assetId: asset.assetId, expectedAsset: asset.snapshotGuard },
      { field, cursor, bindingId: crypto.randomUUID().replaceAll('-', '_') })
    } catch (error) { state.notice = message(error) }
  }
  async function inspectPending() {
    const pending = state.pending
    if (!pending || state.saving) return
    const owner = epoch, projectId = state.projectId
    state.saving = true; state.notice = ''
    try {
      const receipt = await request.get('/muse/studio/operations/' + encodeURIComponent(pending.operationId))
      if (!current(owner, projectId)) return
      if (receipt?.state === 'recorded') await acceptResult(pending, receipt.result)
      else if (receipt?.state === 'missing') {
        state.pendingMissing = true
        state.notice = '尚未找到原成功回执，可使用同一编号原样重试；不会调用付费生成'
      } else throw new Error('原保存回执暂时无法核对')
    } catch (error) { if (current(owner, projectId)) state.notice = message(error) }
    finally { if (current(owner, projectId)) state.saving = false }
  }
  async function refreshRejected() {
    const pending = state.pending
    if (!pending?.rejected || !state.pendingMissing) return
    const draft = clone(pending.draft)
    clearPending(pending)
    await selectPackage(pending.packageId)
    state.draft = draft
    state.notice = state.traceError ? '当前版本未能读取，原草稿仍保留，请重新读取后再保存'
      : '已重新读取当前版本，原草稿仍保留。请比较参考图与提示词，再明确保存新修订'
  }
  return { dirty, loadProject, selectEpisode, selectPackage, moreVersions, saveRevision, adoptVersion,
    captureAsset, addBinding, removeBinding, inspectPending, refreshRejected,
    retryPending: async () => { if (state.pending && state.pendingMissing) await executePending(state.pending) },
    dispose() { alive = false; ++epoch; ++traceEpoch; reads.abort(); traceRead.abort() } }
}

/**
 * Label real native package state without declaring unknown results successful.
 * @param item - Native package summary.
 * @returns Concise status, tone and attention flag.
 */
export function studioPackageStatus(item) {
  if (item.pending_generations > 0) return { label: '生成中', tone: 'primary', attention: false }
  if (item.adopted_video_present && item.adopted_generation_id !== null) return { label: '已采用', tone: 'success', attention: false }
  if (item.adopted_video_present) return { label: '版本待核对', tone: 'warning', attention: true }
  if (item.failed_generations > 0) return { label: '需要检查', tone: 'warning', attention: true }
  return { label: '尚未采用', tone: '', attention: false }
}

/**
 * Keep only additional reference images not already identified by a bound asset's exact SHA.
 * @param version - Selected generation with its own captured inputs.
 * @returns Original ordered references whose identity has not been displayed as a binding.
 */
export function studioOtherReferences(version) {
  const bound = new Set(version.inputs.bindings.map(binding => binding.sha256).filter(Boolean))
  return version.inputs.references.filter(reference => !reference.sha256 || !bound.has(reference.sha256))
}

/**
 * Ask before leaving a local draft; Enter, Escape and closing keep the current edit.
 * @param confirm - The application's confirmation dialog function.
 * @returns True only when the user presses the explicitly labelled discard button.
 */
export async function confirmStudioDiscard(confirm) {
  try {
    await confirm('切换会离开尚未保存的草稿，旧生成版本不会改变。是否继续编辑？', '保留或放弃草稿',
      { confirmButtonText: '继续编辑', cancelButtonText: '放弃草稿并切换', distinguishCancelAndClose: true, type: 'warning' })
    return false
  } catch (action) { return action === 'cancel' }
}

/**
 * Distinguish saved images of the same named asset without assigning a changing list rank.
 * @param version - Immutable asset version returned by the native server.
 * @returns Display name, recorded timestamp and a short byte digest.
 */
export function studioAssetVersionLabel(version) {
  const time = version.createdAt && !Number.isNaN(Date.parse(version.createdAt))
    ? new Date(version.createdAt).toLocaleString('zh-CN') : '时间未记录'
  return version.sha256.slice(0, 8) + ' · ' + version.displayName + ' · ' + time
}

/**
 * Preview the explicitly selected saved image, retaining current-image identity when none was chosen.
 * @param asset - Project asset and its immutable versions.
 * @param versionId - User-selected immutable image identity.
 * @returns Exact selected version or a clearly labelled current image without an invented hash.
 */
export function studioAssetChoice(asset, versionId) {
  return asset.versions.find(version => version.versionId === versionId)
    || { mediaUrl: asset.currentMediaUrl, displayName: asset.name + ' · 当前图' }
}

/**
 * Format measured seconds; a missing measurement remains unknown.
 * @param seconds - Media duration reported by the native server.
 * @returns Compact duration without substituting a target duration.
 */
export function studioDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '时长未知'
  const rounded = Math.round(seconds)
  return Math.floor(rounded / 60).toString().padStart(2, '0') + ':' + (rounded % 60).toString().padStart(2, '0')
}
