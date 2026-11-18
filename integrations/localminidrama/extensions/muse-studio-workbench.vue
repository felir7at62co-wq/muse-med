<template>
  <div class="muse-workbench">
    <header class="muse-wb-header">
      <div class="muse-wb-title">
        <el-button text aria-label="返回项目总览" @click="navigate('/drama/' + state.projectId)"><el-icon><ArrowLeft /></el-icon></el-button>
        <div><h1>{{ state.project?.title || '制作工作台' }}<template v-if="episode"> / {{ episode.title || '第 ' + episode.episode_number + ' 集' }}</template></h1>
          <p class="muse-wb-subtitle">每个制作包保留独立版本，提示词与当次参考图一起追溯</p></div>
      </div>
      <div class="muse-wb-actions">
        <el-button type="primary" :disabled="!bridgeState.available || bridgeState.pending || dirty" @click="askMuse('continue_production')">
          <el-icon><VideoPlay /></el-icon>让 Muse 规划制作
        </el-button>
        <el-dropdown trigger="click" @command="moreAction"><el-button>更多<el-icon><ArrowDown /></el-icon></el-button>
          <template #dropdown><el-dropdown-menu>
            <el-dropdown-item command="refresh">刷新项目记录</el-dropdown-item>
            <el-dropdown-item command="budget">项目预算与账目</el-dropdown-item>
            <el-dropdown-item command="audio">声音与配音</el-dropdown-item>
            <el-dropdown-item command="revisions">编辑记录与恢复</el-dropdown-item>
            <el-dropdown-item command="admission">生成提交记录</el-dropdown-item>
            <el-dropdown-item command="postproduction">视频后期处理</el-dropdown-item>
            <el-dropdown-item command="media" divided>媒体素材库</el-dropdown-item>
            <el-dropdown-item command="canvas">画布模式</el-dropdown-item>
            <el-dropdown-item command="advanced">高级制作工具</el-dropdown-item>
            <el-dropdown-item command="theme">{{ isDark ? '切换浅色' : '切换暗色' }}</el-dropdown-item>
          </el-dropdown-menu></template>
        </el-dropdown>
      </div>
    </header>

    <div class="muse-wb-notice" role="status">生成后端尚未接入；项目、资产和历史可正常管理</div>

    <nav class="muse-wb-tabs" role="tablist" aria-label="制作阶段">
      <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" class="muse-wb-tab"
        :aria-selected="activeTab === tab.id" :aria-controls="'muse-stage-' + tab.id" @click="activeTab = tab.id">
        <el-icon><component :is="tab.icon" /></el-icon>{{ tab.label }}
      </button>
    </nav>
    <div v-if="state.error" class="muse-wb-notice" data-kind="error" role="alert"><p>{{ state.error }}</p>
      <el-button size="small" @click="refreshProject">重新读取</el-button></div>
    <div v-if="state.loading && !state.project" class="muse-wb-loading" role="status" aria-label="正在读取项目"><el-icon class="is-loading"><Loading /></el-icon></div>

    <template v-else-if="state.project">
      <div class="muse-wb-toolbar">
        <el-select :model-value="state.episodeId" aria-label="当前分集" placeholder="暂无分集" :disabled="blocked" @change="changeEpisode">
          <el-option v-for="item in state.project.episodes" :key="item.id" :value="item.id" :label="item.title || '第 ' + item.episode_number + ' 集'" />
        </el-select>
        <p v-if="dirty" class="muse-wb-help">有未保存的修改，请先保存新修订</p>
        <p v-else class="muse-wb-help">{{ state.packages.length }} 个制作包 · 单包可包含多个镜头</p>
      </div>

      <section v-show="activeTab === 'packages'" id="muse-stage-packages" role="tabpanel" aria-label="分镜制作">
        <div class="muse-wb-layout">
          <section class="muse-wb-gallery" aria-label="制作包画廊">
            <div class="muse-wb-toolbar"><h2>制作包</h2><div class="muse-wb-filter" aria-label="制作包筛选">
              <button type="button" :aria-pressed="filter === 'all'" @click="filter = 'all'">全部 {{ state.packages.length }}</button>
              <button type="button" :aria-pressed="filter === 'attention'" @click="filter = 'attention'">待处理 {{ attentionCount }}</button>
            </div></div>
            <p class="muse-wb-filmstrip-hint">左右滑动选择制作包，内容和生成记录显示在下方</p>
            <div v-if="state.loading && !state.packages.length" class="muse-wb-loading" role="status" aria-label="正在读取制作包"><el-icon class="is-loading"><Loading /></el-icon></div>
            <div v-else-if="!filteredPackages.length" class="muse-wb-empty"><el-icon><Film /></el-icon>
              <h3>{{ state.packages.length ? '当前没有待处理的制作包' : '从剧本开始，交给 Muse 拆成制作包' }}</h3>
              <p>{{ state.packages.length ? '切换到全部查看已采用版本' : '导入剧本或让 Muse 整理分集与资产' }}</p>
              <el-button v-if="!state.packages.length" :disabled="!bridgeState.available || bridgeState.pending" @click="askMuse('continue_production')">让 Muse 规划制作</el-button>
            </div>
            <div v-else class="muse-wb-grid" role="group" aria-label="制作包，可用 Tab 键选择">
              <button v-for="item in filteredPackages" :key="item.id" type="button" class="muse-wb-card"
                :aria-pressed="state.packageId === item.id" :data-attention="status(item).attention" :disabled="blocked" @click="changePackage(item.id)">
                <div class="muse-wb-thumbnail">
                  <img v-if="packageImage(item)" :src="packageImage(item)" :alt="item.title || '制作包参考画面'" loading="lazy" />
                  <video v-else-if="item.adopted_video_url" :src="media(item.adopted_video_url)" preload="metadata" muted playsinline aria-label="已采用视频缩略图" @loadedmetadata="seekThumbnail" />
                  <div v-else class="muse-wb-placeholder"><el-icon><Film /></el-icon><span>尚无已保存画面</span></div>
                  <span v-if="item.actual_duration !== null" class="muse-wb-duration">{{ duration(item.actual_duration) }}</span>
                </div>
                <div class="muse-wb-card-footer"><div class="muse-wb-card-name"><span class="muse-wb-card-number">{{ packageLabel(item) }}</span><span>{{ item.title || '未命名制作包' }}</span></div>
                  <span class="muse-wb-tag" :data-tone="status(item).tone">{{ status(item).label }}</span></div>
              </button>
            </div>
          </section>

          <aside class="muse-wb-inspector" aria-label="制作包检查与修改">
            <div class="muse-wb-inspector-header"><div><h2>{{ selectedPackage?.title || '选择一个制作包' }}</h2>
              <p v-if="selectedPackage" class="muse-wb-subtitle">{{ packageLabel(selectedPackage) }} · {{ status(selectedPackage).label }}</p></div></div>
            <div class="muse-wb-tabs" role="tablist" aria-label="检查面板">
              <button type="button" role="tab" class="muse-wb-tab" :aria-selected="inspectorTab === 'content'" @click="inspectorTab = 'content'">内容</button>
              <button type="button" role="tab" class="muse-wb-tab" :aria-selected="inspectorTab === 'versions'" @click="inspectorTab = 'versions'">生成记录</button>
            </div>
            <div class="muse-wb-inspector-body">
              <div v-if="state.traceError" class="muse-wb-notice" data-kind="error" role="alert"><p>{{ state.traceError }}</p><el-button size="small" @click="refreshPackage">重新读取</el-button></div>
              <div v-if="state.notice" class="muse-wb-notice" role="status">{{ state.notice }}</div>
              <div v-if="state.pending" class="muse-wb-section" aria-label="原保存恢复">
                <p class="muse-wb-help">请先核对尚未确认的保存，当前草稿和原编号均保留；这里只处理免费内容与采用操作</p>
                <div class="muse-wb-actions"><el-button :loading="state.saving" @click="controller.inspectPending()">读取原回执</el-button>
                  <el-button v-if="state.pending.packageId !== state.packageId" :disabled="state.saving" @click="openPendingPackage">返回原保存的制作包</el-button>
                  <el-button v-if="state.pendingMissing && !state.pending.rejected" :disabled="state.saving" @click="controller.retryPending()">原样重试保存</el-button>
                  <el-button v-if="state.pendingMissing && state.pending.rejected" :disabled="state.saving" @click="controller.refreshRejected()">保留草稿并读取当前版本</el-button></div>
              </div>
              <div v-if="state.stale" class="muse-wb-notice" role="status">当前内容已在其他操作中变化，请重新读取并比较草稿后再保存</div>
              <div v-if="state.traceLoading && !state.trace" class="muse-wb-loading" role="status" aria-label="正在读取生成记录"><el-icon class="is-loading"><Loading /></el-icon></div>
              <div v-else-if="!state.trace" class="muse-wb-empty"><el-icon><Mouse /></el-icon><p>在画廊里选择制作包，查看内容和每次生成依据</p></div>

              <template v-else>
                <div v-show="inspectorTab === 'content'" class="muse-wb-section">
                  <div class="muse-wb-section-header"><h3>当前内容</h3><span class="muse-wb-help">{{ state.trace.current.revisionId ? '已保存修订' : '尚未保存为修订' }}</span></div>
                  <p class="muse-wb-help">编辑提示词或绑定参考图后，保存为新修订；不会改写旧视频的生成输入</p>
                  <div class="muse-wb-edit-form">
                    <label><span>图片提示词</span><MuseStudioPrompt :text="state.draft.imagePrompt" :bindings="state.draft.imageBindings" editable
                      :disabled="blocked" label="当前图片提示词" @update:text="state.draft.imagePrompt = $event" @preview="previewAsset" /></label>
                    <div class="muse-wb-actions"><el-button size="small" :disabled="blocked" @click="openBindings('image')"><el-icon><Picture /></el-icon>绑定图片参考</el-button></div>
                    <label><span>视频提示词</span><MuseStudioPrompt :text="state.draft.videoPrompt" :bindings="state.draft.videoBindings" editable
                      :disabled="blocked" label="当前视频提示词" @update:text="state.draft.videoPrompt = $event" @preview="previewAsset" /></label>
                    <div class="muse-wb-actions"><el-button size="small" :disabled="blocked" @click="openBindings('video')"><el-icon><Picture /></el-icon>绑定视频参考</el-button></div>
                    <label v-if="state.draft.parentGenerationId"><span>基于视频版本 {{ state.draft.parentGenerationId }} 的修改原因</span><el-input v-model="state.draft.changeReason" type="textarea" :disabled="blocked" maxlength="2000" placeholder="说明问题所在时段、剧本依据和本次修改" /></label>
                    <div v-if="allDraftBindings.length" class="muse-wb-section"><h3>本修订绑定的参考图</h3>
                      <div v-for="row in allDraftBindings" :key="row.field + row.binding.bindingId" class="muse-wb-section-header">
                        <button type="button" class="muse-wb-chip" @click="previewAsset(row.binding)"><img v-if="row.binding.mediaUrl" :src="media(row.binding.mediaUrl)" alt="" /><span>{{ row.field === 'image' ? '图片' : '视频' }} · {{ row.binding.displayName }}</span></button>
                        <el-button text size="small" :disabled="blocked" @click="controller.removeBinding(row.binding.bindingId, row.field)">移除引用</el-button>
                      </div>
                    </div>
                    <el-button type="primary" :loading="state.saving" :disabled="blocked || !dirty || state.stale || !!state.traceError" @click="controller.saveRevision()">保存新修订</el-button>
                  </div>
                  <section v-if="state.trace.images.items.length" class="muse-wb-section"><h3>图片版本</h3><div class="muse-wb-version-grid">
                    <div v-for="version in state.trace.images.items" :key="version.generationId" class="muse-wb-version">
                      <button type="button" class="muse-wb-image-preview" @click="previewAsset({mediaUrl:version.mediaUrl,displayName:'图片版本 ' + version.generationId})"><img v-if="version.mediaUrl" :src="media(version.mediaUrl)" alt="图片版本" /></button>
                      <div class="muse-wb-version-info"><span>{{ generationState(version.status) }}</span><span v-if="version.adopted">当前采用</span>
                        <el-button v-else text size="small" :disabled="blocked || dirty || version.status !== 'completed'" @click="controller.adoptVersion(version)">采用此图片</el-button></div>
                    </div></div><el-button v-if="state.trace.images.nextCursor" :loading="state.loadingMore" @click="controller.moreVersions('image')">更早图片版本</el-button></section>
                </div>

                <div v-show="inspectorTab === 'versions'" class="muse-wb-section">
                  <div v-if="!state.trace.videos.items.length" class="muse-wb-empty"><el-icon><VideoCamera /></el-icon><p>尚无视频生成记录</p><p class="muse-wb-help">保存内容后可交给 Muse 继续制作，付费生成前另行授权</p></div>
                  <template v-else>
                    <h3>视频版本</h3>
                    <div class="muse-wb-version-grid"><button v-for="version in state.trace.videos.items" :key="version.generationId" type="button" class="muse-wb-version"
                      :aria-pressed="state.versionId === version.generationId" @click="state.versionId = version.generationId">
                      <video v-if="version.mediaUrl" :src="media(version.mediaUrl)" preload="metadata" muted playsinline @loadedmetadata="seekThumbnail" />
                      <div v-else class="muse-wb-placeholder"><el-icon><VideoCamera /></el-icon></div>
                      <div class="muse-wb-version-info"><span>版本 {{ version.generationId }}</span><span>{{ version.adopted ? '当前采用' : generationState(version.status) }}</span></div>
                    </button></div>
                    <article v-for="version in selectedVideo ? [selectedVideo] : []" :key="'inputs-' + version.generationId" class="muse-wb-section" :aria-label="'视频版本 ' + version.generationId + ' 的生成输入'">
                      <div class="muse-wb-section-header"><h3>版本 {{ version.generationId }} · 当次生成输入</h3><span class="muse-wb-tag" :data-tone="version.adopted ? 'success' : ''">{{ version.adopted ? '当前采用' : generationState(version.status) }}</span></div>
                      <video v-if="state.versionId === version.generationId && version.mediaUrl" :key="version.generationId" class="muse-wb-player" :src="media(version.mediaUrl)" controls preload="metadata" aria-label="所选版本视频预览" />
                      <p class="muse-wb-help">{{ formatTime(version.createdAt) }}<template v-if="version.inputs.model"> · {{ version.inputs.model }}</template> · 记录时长 {{ duration(version.durationSeconds) }}</p>
                      <p v-if="version.inputs.state !== 'captured'" class="muse-wb-notice">{{ version.inputs.state === 'partial' ? '仅保存了部分当次输入，未核实的参考图不能视为原始依据' : '未保存可核对的当次输入，不用当前素材补作历史' }}</p>
                      <MuseStudioPrompt :text="version.inputs.prompt || ''" :bindings="version.inputs.bindings" :label="'版本 ' + version.generationId + ' 当次提示词'" @preview="previewAsset" />
                      <div v-if="version.inputs.bindings.length" class="muse-wb-chip-list" aria-label="当次绑定的资产图"><button v-for="binding in version.inputs.bindings" :key="binding.bindingId" type="button" class="muse-wb-chip" @click="previewAsset(binding)"><img v-if="binding.mediaUrl" :src="media(binding.mediaUrl)" alt="" /><span>{{ binding.displayName }}</span></button></div>
                      <div v-if="otherReferences(version).length" class="muse-wb-chip-list" aria-label="当次其他参考图"><button v-for="(reference,index) in otherReferences(version)" :key="index" type="button" class="muse-wb-chip" :data-missing="reference.evidence !== 'immutable-copy'" :disabled="!reference.mediaUrl" @click="previewAsset({...reference,displayName:'当次参考 ' + (index + 1)})"><img v-if="reference.mediaUrl" :src="media(reference.mediaUrl)" alt="" /><span>参考 {{ index + 1 }} · {{ reference.evidence === 'immutable-copy' ? '已保存原图' : reference.evidence === 'recorded-url' ? '仅有原地址' : '不可读取' }}</span></button></div>
                      <p v-if="!version.inputs.bindings.length && !version.inputs.references.length" class="muse-wb-help">没有已记录的参考图</p>
                      <details v-if="version.inputs.submittedPrompt"><summary>实际提交给模型的文本</summary><pre class="muse-wb-submitted-prompt">{{ version.inputs.submittedPrompt }}</pre></details>
                      <div v-if="state.versionId === version.generationId" class="muse-wb-actions"><el-button v-if="!version.adopted" :disabled="blocked || dirty || version.status !== 'completed' || !version.mediaUrl" @click="controller.adoptVersion(version)">采用此视频</el-button>
                        <el-button :disabled="blocked || !version.inputs.prompt" @click="editVideoVersion(version)">基于此版本修改</el-button>
                        <el-button :disabled="!bridgeState.available || bridgeState.pending || dirty" @click="askMuse('propose_fix', version)">交给 Muse 修复</el-button></div>
                      <p v-if="version.inputs.parentGenerationId" class="muse-wb-help">基于视频版本 {{ version.inputs.parentGenerationId }} 修改 · {{ version.inputs.changeReason }}</p>
                      <details v-if="version.inputs.operationId"><summary>原生成记录</summary><p class="muse-wb-help">{{ version.inputs.operationId }}</p>
                        <p v-if="version.inputs.requestSha256" class="muse-wb-help">请求摘要 {{ version.inputs.requestSha256 }}</p>
                        <p v-if="version.inputs.revisionId" class="muse-wb-help">输入修订 {{ version.inputs.revisionId }}</p>
                        <template v-if="version.inputs.supplier"><p class="muse-wb-help">原生成任务 {{ version.inputs.supplier.taskId || '未记录' }} · 子结果 {{ version.inputs.supplier.subtaskId || '未记录' }}</p>
                          <p class="muse-wb-help">预占报价与供应商实际费用分别保留，未核实账单不视为已确认费用</p>
                          <details><summary>报价与供应商费用原值</summary><pre>{{ JSON.stringify({ quote: version.inputs.supplier.quote ?? null, supplierReportedCost: version.inputs.supplier.observedCost ?? null }, null, 2) }}</pre></details></template>
                      </details>
                      <p v-if="version.inputs.parentGenerationId" class="muse-wb-help">基于视频版本 {{ version.inputs.parentGenerationId }} 修改：{{ version.inputs.changeReason }}</p>
                    </article>
                    <el-button v-if="state.trace.videos.nextCursor" :loading="state.loadingMore" @click="controller.moreVersions('video')">更早视频版本</el-button>
                  </template>
                </div>

                <div class="muse-wb-section"><el-button type="primary" :disabled="!bridgeState.available || bridgeState.pending || dirty" @click="askMuse('propose_fix', selectedVideo)"><el-icon><MagicStick /></el-icon>交给 Muse 检查与修复</el-button>
                  <p class="muse-wb-help">保留原结果，正常编辑和采用无需重新生成；新付费调用仍需费用授权</p></div>
              </template>
            </div>
          </aside>
        </div>
      </section>

      <section v-show="activeTab === 'script'" id="muse-stage-script" role="tabpanel" aria-label="剧本" class="muse-wb-panel">
        <div class="muse-wb-section-header"><h2>本集剧本</h2><el-button :disabled="!bridgeState.available || bridgeState.pending" @click="askMuse('propose_fix')">交给 Muse 调整剧本</el-button></div>
        <div class="muse-wb-script">{{ episode?.script_content || '尚未保存本集剧本，可将原文交给 Muse 整理并创建分集' }}</div>
      </section>
      <section v-show="activeTab === 'assets'" id="muse-stage-assets" role="tabpanel" aria-label="资产" class="muse-wb-panel">
        <div class="muse-wb-section-header"><h2>本项目资产</h2><el-button :disabled="!state.project || state.loading" @click="openAssetInspection"><el-icon><MagicStick /></el-icon>让 Muse 检查资产</el-button></div>
        <p class="muse-wb-help">这里展示当前项目素材；每次视频实际使用的图片请在该包的生成记录中查看</p>
        <div class="muse-wb-asset-toolbar"><div class="muse-wb-filter" role="group" aria-label="资产分类">
          <button v-for="group in projectAssetGroups" :key="group.kind" type="button" :aria-pressed="assetCategory === group.kind" @click="assetCategory = group.kind"><el-icon><component :is="group.icon" /></el-icon>{{ group.label }} <span>{{ group.items.length }}</span></button>
        </div></div>
        <section :aria-label="selectedAssetGroup.label + '资产'">
        <div v-if="selectedAssetGroup.items.length" class="muse-wb-asset-grid"><button v-for="asset in selectedAssetGroup.items" :key="asset.kind + asset.id" type="button" class="muse-wb-asset" @click="previewAsset({mediaUrl:asset.url,displayName:asset.name})">
          <img v-if="asset.url" :src="media(asset.url)" alt="" loading="lazy" /><div v-else class="muse-wb-placeholder"><el-icon><Picture /></el-icon></div><h3>{{ asset.name }}</h3><p class="muse-wb-help">{{ asset.label }}</p></button></div>
        <div v-else class="muse-wb-empty"><el-icon><component :is="selectedAssetGroup.icon" /></el-icon><h3>尚无{{ selectedAssetGroup.label }}资产</h3><p>Muse 可根据剧本建立{{ selectedAssetGroup.label }}，已有资产会显示在对应分类中</p></div>
        </section>
      </section>
      <section v-show="activeTab === 'output'" id="muse-stage-output" role="tabpanel" aria-label="成片" class="muse-wb-panel">
        <div class="muse-wb-section-header"><h2>本集成片</h2><el-button :disabled="!bridgeState.available || bridgeState.pending" @click="askMuse('continue_production')">让 Muse 继续合成与检查</el-button></div>
        <video v-if="episode?.video_url" :src="media(episode.video_url)" controls preload="metadata" class="muse-wb-player" aria-label="本集已保存成片预览" />
        <div v-else class="muse-wb-empty"><el-icon><VideoPlay /></el-icon><p>尚无已保存的本集成片</p><p class="muse-wb-help">Muse 会按制作包顺序合成候选视频，再交你最终验收</p></div>
        <p class="muse-wb-help">已保存媒体与最终验收分开记录，不以可播放代替质量检查</p>
      </section>

      <details class="muse-wb-collaboration"><summary><el-icon><ChatDotRound /></el-icon><span>Muse 协作与运行记录</span><span class="muse-wb-help">{{ bridgeLabel }}</span></summary>
        <div class="muse-wb-collaboration-body"><p class="muse-wb-help">只把当前项目、集、制作包和生成版本交给 Muse 主会话。供应商任务与自动制作进度以原会话的真实记录为准</p>
          <div class="muse-wb-actions"><el-button :disabled="!bridgeState.available || bridgeState.pending" @click="askMuse('inspect_project')">检查项目</el-button><el-button :disabled="!state.packageId || !bridgeState.available || bridgeState.pending" @click="askMuse('inspect_package', selectedVideo)">检查当前制作包</el-button><el-button @click="dialog = 'admission'">查看生成提交记录</el-button></div>
        </div>
      </details>
    </template>

    <el-dialog v-model="assetInspectionOpen" title="资产检查" width="min(760px, 94vw)" destroy-on-close>
      <p class="muse-wb-help">先核对已保存的资产资料，再交给 Muse 检查图片内容、剧本要求和镜头引用。检查不会修改资产或提交生成</p>
      <h3>资料初检</h3>
      <div class="muse-wb-asset-check-counts"><div v-for="group in assetInspection.groups" :key="group.kind"><span>{{ group.label }}</span><strong>{{ group.total }}</strong><small>缺主图 {{ group.missingImage }} · 缺名称 {{ group.missingName }}</small></div></div>
      <p v-if="!assetInspection.total" class="muse-wb-help">项目中还没有资产，Muse 可以根据已保存的剧本列出需要准备的人物、场景和道具</p>
      <ul v-else-if="assetInspection.issues.length" class="muse-wb-asset-check-issues"><li v-for="issue in assetInspection.issues" :key="issue.key"><button type="button" @click="showAssetCategory(issue.kind)">{{ issue.label }} · {{ issue.name }}</button><span>{{ issue.reasons.join('；') }}</span></li></ul>
      <p v-else class="muse-wb-help">未发现缺名称、缺主图或同类重名。尚未检查图片能否读取、内容是否正确和镜头绑定是否一致</p>
      <div class="muse-wb-asset-check-handoff">
        <h3>Muse 深入检查</h3>
        <p v-if="!bridgeState.available" class="muse-wb-help">当前页面未连接 Muse 会话。请在 Muse 左侧的「制作平台」打开同一项目，再使用此按钮选择接收检查结果的会话</p>
        <p v-else-if="!canInspectAssets" class="muse-wb-help">当前 Muse 尚不支持资产检查，请更新此分支的 Muse 后重新打开制作平台</p>
        <p v-else class="muse-wb-help">Muse 会核对人物、场景、道具及其镜头引用，查看可读取的图片，并在你选择的会话中给出问题位置和修复建议</p>
        <p v-if="dirty" class="muse-wb-help">当前镜头有未保存的修改，本次只检查已保存的项目内容</p>
        <p v-if="assetInspectionError" class="muse-wb-help" role="alert">{{ assetInspectionError }}</p>
        <div class="muse-wb-actions"><el-button type="primary" :disabled="!canInspectAssets || bridgeState.pending" @click="inspectAssetsWithMuse">{{ bridgeState.pending ? '等待选择 Muse 会话' : '交给 Muse 深入检查' }}</el-button><el-button @click="assetInspectionOpen = false">关闭</el-button></div>
        <p class="muse-wb-help" role="status">{{ bridgeLabel }}</p>
      </div>
    </el-dialog>
    <el-dialog v-model="assetPicker" title="将资产图绑定到提示词" width="min(760px, 94vw)" destroy-on-close>
      <p class="muse-wb-help">选择已保存参考版本，或把当前资产图保存为独立参考。绑定只修改本修订，旧视频仍显示当次原图</p>
      <section v-for="group in bindingAssetGroups" :key="group.kind" class="muse-wb-asset-group" :aria-label="group.label + '参考图'">
        <h3 class="muse-wb-asset-group-title"><el-icon><component :is="group.icon" /></el-icon>{{ group.label }}<span class="muse-wb-help">{{ group.items.length }}</span></h3>
        <div class="muse-wb-asset-grid"><article v-for="asset in group.items" :key="asset.assetKind + asset.assetId" class="muse-wb-asset">
        <button type="button" class="muse-wb-image-preview" :aria-label="'预览 ' + assetChoice(asset).displayName" @click="previewAsset(assetChoice(asset))"><img v-if="assetChoice(asset).mediaUrl" :src="media(assetChoice(asset).mediaUrl)" :alt="assetChoice(asset).displayName" /></button><h3>{{ asset.name }}</h3>
        <el-select v-model="assetSelections[asset.assetKind + asset.assetId]" :aria-label="asset.name + ' 的参考版本'" placeholder="选择已保存版本" popper-class="muse-wb-asset-options"><el-option v-for="version in asset.versions" :key="version.versionId" :value="version.versionId" :label="assetVersionLabel(version)"><div class="muse-wb-asset-option"><img :src="media(version.mediaUrl)" alt="" /><div><span>{{ version.displayName }}</span><small>{{ formatTime(version.createdAt) }} · {{ version.sha256.slice(0,8) }}</small></div></div></el-option></el-select>
        <div class="muse-wb-actions"><el-button size="small" :disabled="blocked || !assetSelections[asset.assetKind + asset.assetId]" @click="bindSavedAsset(asset)">绑定此版本</el-button>
          <el-button size="small" :disabled="blocked || !asset.currentMediaUrl" @click="captureCurrentAsset(asset)">保存并绑定当前图</el-button></div>
        </article></div>
        <p v-if="!group.items.length" class="muse-wb-help">尚无可绑定的{{ group.label }}图</p>
      </section>
    </el-dialog>
    <el-dialog v-model="previewOpen" :title="preview?.displayName || '参考图预览'" width="min(860px, 94vw)" destroy-on-close><img v-if="preview?.mediaUrl" :src="media(preview.mediaUrl)" :alt="preview.displayName" class="muse-wb-preview" /><p v-else>当次参考图暂时不可读取，未用当前图片替代</p><details v-if="preview?.sha256"><summary>查看图片校验信息</summary><p class="muse-wb-help">SHA-256：{{ preview.sha256 }}</p></details></el-dialog>
    <el-dialog :model-value="!!dialog" :title="dialogTitle" width="min(1080px, 95vw)" destroy-on-close :close-on-click-modal="false" @close="dialog = ''">
      <MuseBudgetPanel v-if="dialog === 'budget'" :project-id="state.projectId" />
      <MuseAudioPanel v-else-if="dialog === 'audio'" :drama-id="state.projectId" :characters="state.project?.characters || []" :storyboards="episode?.storyboards || []" :target-id="state.packageId || 0" target-kind="dialogue" @adopted="refreshProject" />
      <MuseRevisionsPanel v-else-if="dialog === 'revisions'" :project-id="state.projectId" @restored="refreshProject" />
      <MuseAdmissionPanel v-else-if="dialog === 'admission'" />
      <MusePostproductionPanel v-else-if="dialog === 'postproduction'" :drama-id="state.projectId" @adopted="refreshProject" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { ArrowLeft, ArrowDown, VideoPlay, Document, User, Film, Picture, Loading, Mouse, VideoCamera, MagicStick, ChatDotRound, Location, Box } from '@element-plus/icons-vue'
import request from '@/utils/request'
import { museMediaUrl } from '@/utils/museStudioPath'
import { useTheme } from '@/composables/useTheme'
import { createMuseStudioBridge } from '@/utils/museStudioBridge'
import { createStudioWorkbenchState, createStudioWorkbenchController, studioDuration, studioPackageStatus, studioOtherReferences, confirmStudioDiscard, studioAssetVersionLabel, studioAssetChoice, studioAssetInspection } from '@/utils/museStudioWorkbench'
import MuseStudioPrompt from '@/components/MuseStudioPrompt.vue'
import MuseBudgetPanel from '@/components/MuseBudgetPanel.vue'
import MuseAudioPanel from '@/components/MuseAudioPanel.vue'
import MuseRevisionsPanel from '@/components/MuseRevisionsPanel.vue'
import MuseAdmissionPanel from '@/components/MuseAdmissionPanel.vue'
import MusePostproductionPanel from '@/components/MusePostproductionPanel.vue'
import '@/styles/museStudioWorkbench.css'

const route = useRoute(), router = useRouter(), { isDark, toggle: toggleTheme } = useTheme()
const state = reactive(createStudioWorkbenchState())
const controller = createStudioWorkbenchController({ state, request })
const activeTab = ref('packages'), inspectorTab = ref('content'), filter = ref('all'), dialog = ref('')
const assetCategory = ref('character')
const assetInspectionOpen = ref(false)
const assetInspectionError = ref('')
const previewOpen = ref(false), preview = ref(null), assetPicker = ref(false), bindingField = ref('video'), assetSelections = reactive({})
const bridgeState = reactive({ available: false, pending: false, outcome: null, intents: [] })
const bridge = createMuseStudioBridge({ onState: value => Object.assign(bridgeState, value) })
const tabs = [{ id: 'script', label: '剧本', icon: Document }, { id: 'assets', label: '资产', icon: User },
  { id: 'packages', label: '分镜制作', icon: Film }, { id: 'output', label: '成片', icon: VideoPlay }]
const dialogTitles = { budget: '项目预算与账目', audio: '声音与配音', revisions: '编辑记录与恢复', admission: '生成提交记录', postproduction: '视频后期处理' }
const dialogTitle = computed(() => dialogTitles[dialog.value] || '')
const episode = computed(() => state.project?.episodes.find(item => item.id === state.episodeId))
const selectedPackage = computed(() => state.packages.find(item => item.id === state.packageId))
const selectedVideo = computed(() => state.trace?.videos.items.find(item => item.generationId === state.versionId))
const dirty = computed(() => controller.dirty())
const blocked = computed(() => state.saving || !!state.pending)
const filteredPackages = computed(() => filter.value === 'attention' ? state.packages.filter(item => status(item).attention || !item.adopted_video_present) : state.packages)
const attentionCount = computed(() => state.packages.filter(item => status(item).attention || !item.adopted_video_present).length)
const allDraftBindings = computed(() => ['image', 'video'].flatMap(field => state.draft[field + 'Bindings'].filter(binding => state.draft[field + 'Prompt'].includes(binding.referenceToken)).map(binding => ({ field, binding }))))
const assetCategories = [{ kind: 'character', label: '人物', source: 'characters', icon: User }, { kind: 'scene', label: '场景', source: 'scenes', icon: Location }, { kind: 'prop', label: '道具', source: 'props', icon: Box }]
const projectAssetGroups = computed(() => assetCategories.map(group => ({ ...group, items: (state.project?.[group.source] || []).map(item => ({ id: item.id, kind: group.kind, label: group.label, name: item.name || item.location || '未命名资产', url: item.image_url || item.local_path || '' })) })))
const selectedAssetGroup = computed(() => projectAssetGroups.value.find(group => group.kind === assetCategory.value))
const bindingAssetGroups = computed(() => {
  const assets = state.trace?.assets || []
  const groups = assetCategories.map(group => ({ ...group, items: assets.filter(asset => asset.assetKind === group.kind) }))
  const storyboards = assets.filter(asset => asset.assetKind === 'storyboard')
  if (storyboards.length) groups.push({ kind: 'storyboard', label: '分镜参考', icon: Film, items: storyboards })
  return groups
})
const assetInspection = computed(() => studioAssetInspection(state.project))
const canInspectAssets = computed(() => bridgeState.available && bridgeState.intents.includes('inspect_assets'))
const bridgeLabel = computed(() => bridgeState.pending ? '等待在 Muse 中选择会话' : ({ draft_prepared: '已在所选会话准备草稿', sent: '已交给所选会话', cancelled: '已取消交接', failed: '交接未完成，可重新打开', unavailable: '请在 Muse 中打开以协作' }[bridgeState.outcome] || (bridgeState.available ? '可交给 Muse 主会话' : '当前没有连接 Muse 会话')))
const media = value => museMediaUrl(value || '')
const status = studioPackageStatus, duration = studioDuration, otherReferences = studioOtherReferences, assetVersionLabel = studioAssetVersionLabel
const generationState = value => ({ completed: '已完成', failed: '失败记录', pending: '等待中', processing: '处理中', generating: '生成中', unknown: '结果待核对' }[value] || '状态待核对')
const formatTime = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未记录'
const packageLabel = item => 'EP' + String(episode.value?.episode_number || 1).padStart(2, '0') + '-P' + String(item.order || 1).padStart(2, '0')
function packageImage(item) { const card = episode.value?.storyboards?.find(row => row.id === item.id); return card ? media(card.image_url || card.local_path) : '' }
function previewAsset(value) { preview.value = value; previewOpen.value = true }
function showAssetCategory(kind) { assetCategory.value = kind; activeTab.value = 'assets'; assetInspectionOpen.value = false }
function openAssetInspection() { assetInspectionError.value = ''; assetInspectionOpen.value = true }
function inspectAssetsWithMuse() { if (askMuse('inspect_assets')) assetInspectionOpen.value = false; else assetInspectionError.value = '检查任务未能交给 Muse，请确认会话连接后重试' }
function assetChoice(asset) { return studioAssetChoice(asset, assetSelections[asset.assetKind + asset.assetId]) }
function openBindings(field) { bindingField.value = field; assetPicker.value = true }
function bindSavedAsset(asset) { const version = asset.versions.find(item => item.versionId === assetSelections[asset.assetKind + asset.assetId]); if (!version || blocked.value) return; controller.addBinding(version, bindingField.value); assetPicker.value = false }
async function captureCurrentAsset(asset) { await controller.captureAsset(asset, bindingField.value); if (!state.pending) assetPicker.value = false }
async function allowDiscard() { return !dirty.value || await confirmStudioDiscard(ElMessageBox.confirm) }
function seekThumbnail(event) { const video = event.currentTarget; if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.01, video.duration / 2) }
async function navigate(path) { if (!blocked.value && await allowDiscard()) await router.push(path) }
async function changeEpisode(id) { if (!blocked.value && await allowDiscard()) { await controller.selectEpisode(id); await updateLocation() } }
async function changePackage(id) { if (id === state.packageId || blocked.value) return; if (await allowDiscard()) { await controller.selectPackage(id); await updateLocation() } }
async function updateLocation() { await router.replace({ path: route.path, query: { ...route.query, episode: state.episodeId || undefined, package: state.packageId || undefined } }) }
async function refreshProject() { await controller.loadProject(state.projectId || route.params.id, state.episodeId || route.query.episode, state.packageId || route.query.package) }
async function refreshPackage() { if (state.packageId) await controller.selectPackage(state.packageId, { keepDraft: dirty.value }) }
async function openPendingPackage() { const pending = state.pending; if (!pending) return; if (pending.projectId !== state.projectId) await router.push({ path: '/film/' + pending.projectId, query: { episode: pending.episodeId, package: pending.packageId } }); else await controller.selectEpisode(pending.episodeId, pending.packageId) }
async function editVideoVersion(version) { if (blocked.value || !version.inputs.prompt || !(await allowDiscard())) return; state.draft.videoPrompt = version.inputs.prompt; state.draft.videoBindings = JSON.parse(JSON.stringify(version.inputs.bindings)); state.draft.parentGenerationId = version.generationId; state.draft.changeReason = ''; inspectorTab.value = 'content'; state.notice = '已根据此视频的当次提示词和绑定资产准备新草稿，保存后不会改变原版本' + (version.inputs.references.length ? '。其他当次参考图仍在生成记录中，请核对本次需要绑定的资产' : '') }
async function moreAction(command) { if (command === 'refresh') return await refreshProject(); if (command === 'theme') return toggleTheme(); if (command === 'media') return await navigate('/media-library'); if (command === 'canvas') return await navigate('/film/' + state.projectId + '/canvas'); if (command === 'advanced') return await navigate('/film/' + state.projectId + '/advanced'); dialog.value = command }
function askMuse(intent, version) { if (!state.projectId) return false; if (dirty.value && !['inspect_assets', 'inspect_project', 'inspect_package', 'inspect_operation'].includes(intent)) { state.notice = '请先保存镜头修改，再交给 Muse 继续处理'; return false } const selection = { projectId: state.projectId }; if (intent !== 'inspect_assets') { if (state.episodeId) selection.episodeId = state.episodeId; if (state.packageId) selection.storyboardId = state.packageId } if (version) { selection.kind = version.kind; selection.generationId = version.generationId; if (version.inputs.operationId) selection.operationId = version.inputs.operationId } const sent = bridge.request(intent, selection); if (!sent) state.notice = '未能交给 Muse，请检查会话连接后重试'; return sent }
watch(() => route.params.id, id => { void controller.loadProject(id, route.query.episode, route.query.package) }, { immediate: true })
onMounted(() => bridge.start())
onBeforeUnmount(() => { bridge.stop(); controller.dispose() })
</script>
