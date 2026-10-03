# 剧变实时视频模型设置实施计划

[English](2026-09-21-jubian-live-video-model-settings.md) | 中文

> **面向智能体执行者：** 必需的子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行此计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让分镜原生生成验证并保留剧变实时分镜的完整 Seedance 模型设置，包括 Seedance 2.5 的 9:16/480p 与最长 30 秒内容，然后制作并交付第 11 集。

**架构：** 用实时分镜配置驱动的完整目录解析器替换固定 Seedance 2.0/720p 选择器。集中验证时长能力，使预览构建与验证一致，同时保留身份、核对、指纹与单次 PUT 保护。验证后使用现有集分包产物创建六个远端分镜，并运行正常生产流水线。

**技术栈：** TypeScript、Vitest、pnpm、DSH 剧变工具、Python 项目脚本、FFmpeg/drama_render。

---

## 文件映射

- 修改 `packages/jubian/jubian-api/src/native.ts`：完整实时模型目录解析与共享分镜原生时长能力。
- 修改 `packages/jubian/jubian-api/src/storyboard.ts`：接受受支持的实时分镜配置，替代固定 720p，同时保留直接生成的限制。
- 修改 `packages/jubian/jubian-api/tests/native.spec.ts`：Seedance 2.5/480p/30 秒解析器与预览测试。
- 修改 `packages/jubian/jubian-api/tests/storyboard.spec.ts`：非 720p 分镜读取的回归测试。
- 修改 `packages/jubian/tool-jubian/src/index.ts`：准确的工具说明。
- 修改 `packages/jubian/tool-jubian/tests/native.spec.ts` 与 `tests/methods.spec.ts`：工具层准备行为。
- 仅在针对性验证要求时，通过仓库现有生成器更新生成的工具文档。
- 生产期间在 `E:/aa-manju/short-drama/山海自有相逢处/_probe/` 与 `video_tasks/` 下创建项目审计和请求文件。

### 任务 1：为实时 Seedance 设置加入失败的 API 测试

**文件：**
- 修改：`packages/jubian/jubian-api/tests/native.spec.ts`
- 修改：`packages/jubian/jubian-api/tests/storyboard.spec.ts`

- [ ] **步骤 1：加入 Seedance 2.5 目录 fixture**

加入 FANG_ZHOU 行：modelId 为 `doubao-seedance-2-5-260628`，standardId 为 `61`，genType 3 的 id 为 `71`，9:16/480p 的 videoStandardId 为 `338`。

- [ ] **步骤 2：加入失败的完整解析测试**

测试包含 platformId FANG_ZHOU、上述 modelId、genType 3、ratio 9:16、resolution 480p 与 genNum 1 的实时配置解析为 `{ standardId: 61, modelGenerationTypeId: 71, videoStandardId: 338 }`；同时测试平台或分辨率不匹配时直接抛错，不回退。

- [ ] **步骤 3：加入失败的时长测试**

使用提供方时长 31 和 32 构建预览，分别对应 30 秒与 31 秒内容。断言 Seedance 2.5 的 31 通过、32 抛错；断言 Seedance 2.0 仍拒绝超过 14 秒的内容。

- [ ] **步骤 4：加入失败的分镜读取测试**

断言 `readStoryboard` 接受其他字段有效的 9:16/480p Seedance 配置，并从 `duration - 1` 推导内容时长。

- [ ] **步骤 5：确认测试为 RED**

运行：

```powershell
pnpm vitest run packages/jubian/jubian-api/tests/native.spec.ts packages/jubian/jubian-api/tests/storyboard.spec.ts
```

预期：新测试失败，因为实现只选择 Seedance 2.0/720p，且 `readStoryboard` 拒绝 480p。

- [ ] **步骤 6：提交失败的测试**

```powershell
git add packages/jubian/jubian-api/tests/native.spec.ts packages/jubian/jubian-api/tests/storyboard.spec.ts
git commit -m "test(jubian): cover live storyboard video settings"
```

### 任务 2：实现完整目录解析与时长能力

**文件：**
- 修改：`packages/jubian/jubian-api/src/native.ts`
- 修改：`packages/jubian/jubian-api/src/storyboard.ts`

- [ ] **步骤 1：替换固定选择器约定**

此设计签名省略实现与项目内的 `SeedanceVideoModel` 声明：

```ts ignore-check
export function selectSeedanceVideoModel(
  catalogue: unknown,
  requested: Record<string, unknown>,
): SeedanceVideoModel
```

要求 platformId、modelId、genType、ratio 与 resolution 在规范化后完全相等，要求 `genNum === 1`，并且只刷新目录拥有的 ID。零个或多个匹配行都拒绝。

- [ ] **步骤 2：加入共享时长能力函数**

此设计草图省略项目内的 `integer`、`text` 与 `invalid` 辅助函数：

```ts ignore-check
export function nativeContentDurationLimit(modelId: string): number {
  return modelId.toLowerCase() === 'doubao-seedance-2-5-260628' ? 30 : 14
}

export function requireNativeDuration(config: Record<string, unknown>): number {
  const duration = integer(config.duration)
  const content = duration - 1
  if (content < 1 || content > nativeContentDurationLimit(text(config.modelId))) invalid()
  return content
}
```

在预览构建与预览验证中使用该函数。直接 `withGenerationEnabled` 保留 4000–14000ms。

- [ ] **步骤 3：移除分镜读取中的固定分辨率**

在 `configOf` 中要求 9:16、genNum 1、非空 modelId/platformId/resolution 与整数时长，不要求 `resolution === '720p'`。

- [ ] **步骤 4：保留实时配置意图**

把已解析的实时配置传给目录解析器。刷新 `standardId`、`modelGenerationTypeId`、`videoStandardId` 与规范化目录值，不把请求的模型、平台、比例、分辨率或 genType 改成其他语义值。

- [ ] **步骤 5：确认测试为 GREEN**

运行相同的两份针对性 Vitest 文件。预期：全部测试通过。

- [ ] **步骤 6：运行 API 包测试集**

```powershell
pnpm vitest run packages/jubian/jubian-api/tests
```

预期：全部剧变 API 测试通过。

- [ ] **步骤 7：提交实现**

```powershell
git add packages/jubian/jubian-api/src/native.ts packages/jubian/jubian-api/src/storyboard.ts
git commit -m "fix(jubian): follow live storyboard video settings"
```

### 任务 3：更新工具层与说明

**文件：**
- 修改：`packages/jubian/tool-jubian/src/index.ts`
- 修改：`packages/jubian/tool-jubian/tests/native.spec.ts`
- 修改：`packages/jubian/tool-jubian/tests/methods.spec.ts`

- [ ] **步骤 1：加入失败的工具测试**

加入 prepare-video fixture：实时分镜为 Seedance 2.5/480p、时长 31，实时目录包含唯一匹配行。断言持久化预览保留 480p，解析 ID 61/71/338，并报告 `content_duration_ms: 30000`。

- [ ] **步骤 2：确认测试为 RED**

```powershell
pnpm vitest run packages/jubian/tool-jubian/tests/native.spec.ts packages/jubian/tool-jubian/tests/methods.spec.ts
```

预期：新测试在旧的固定设置行为下失败。

- [ ] **步骤 3：仅更新说明**

将 `prepare_video` 描述为对照实时目录验证分镜保存的 Seedance 模型、比例、分辨率、生成类型、数量与模型专属时长。删除其总会解析为非 Mini Seedance 2.0/720p 的说法。

- [ ] **步骤 4：确认 GREEN 并运行包测试**

```powershell
pnpm vitest run packages/jubian/tool-jubian/tests
pnpm --filter @deepseek-ai/dsh-tool-jubian typecheck
```

预期：全部测试与类型检查通过，没有警告。

- [ ] **步骤 5：提交工具改动**

```powershell
git add packages/jubian/tool-jubian/src/index.ts packages/jubian/tool-jubian/tests/native.spec.ts packages/jubian/tool-jubian/tests/methods.spec.ts
git commit -m "docs(jubian): expose live video setting validation"
```

### 任务 4：验证集成并重建当前工具包

**文件：**
- 仅当生成器产生改动时，检查或修改仓库定义的生成目录文件。

- [ ] **步骤 1：运行针对性集成测试**

```powershell
pnpm vitest run packages/jubian/jubian-api/tests packages/jubian/tool-jubian/tests
```

预期：全部通过。

- [ ] **步骤 2：构建包**

```powershell
pnpm --filter @deepseek-ai/dsh-jubian-api build
pnpm --filter @deepseek-ai/dsh-tool-jubian build
```

预期：两个构建均成功。

- [ ] **步骤 3：检查最终 diff**

确认没有暂存已有的无关工作区改动，且 diff 保留身份检查、双快照核对、指纹验证与单次 PUT 语义。

### 任务 5：创建并配置第 11 集分镜

**文件：**
- 创建：`E:/aa-manju/short-drama/山海自有相逢处/_probe/ep11-p1-create-body.json` 至 `ep11-p6-create-body.json`
- 创建：`jubian_model preview` 返回的项目目录内模型预览

- [ ] **步骤 1：同步流水线状态**

运行标准 `pipeline_state.py <project> sync`，记录当前投影。

- [ ] **步骤 2：重新验证编译后的分包**

运行 `_tools/check_shot_script.py --episode 11`、`_tools/build_ep_matches.py --episode 11`、`drama_shot compile` 与 `_tools/verify_ep_package.py --episode 11`。预期：43 个镜头、六个分包、零问题。

- [ ] **步骤 3：冻结六份创建请求体**

构建六份 `isGenerate=0` 请求体，包含 scriptId 2708、episodeId 46744、episodeCount 11、scriptName `山海自有相逢处`、正确分包名、提示词、有序素材与现有时长。在任何远端写入前保存每份请求体。

- [ ] **步骤 4：创建六个分镜但不生成**

对每份请求体调用一次 `jubian_storyboard create`，使用唯一、稳定的幂等键。记录返回的分镜 ID，不使用新键重试。

- [ ] **步骤 5：预览并应用模型设置**

对六个明确的分镜 ID 调用 `jubian_model preview`，设置 modelId `doubao-seedance-2-5-260628`、platformId `FANG_ZHOU`、ratio `9:16`、resolution `480p`、genType 3、genNum 1。审查每项前后值，再用预览指纹调用 apply。

- [ ] **步骤 6：选择并验证有序素材**

为每个分镜调用 `select_assets`，传入分包顺序的素材键与官方父素材 ID。回读验证身份、URL、名称与顺序。

### 任务 6：准备、提交与核算生成

**文件：**
- 创建：`video_tasks/` 下六份不可变预览
- 追加：通过现有核算路径写入项目计费账本

- [ ] **步骤 1：准备全部六个分包**

使用每个分镜 ID 与项目目录调用 `prepare_video`。验证每份预览都使用 Seedance 2.5、480p、正确时长、正确集元数据与完整有序素材。

- [ ] **步骤 2：报告扣费前估算**

使用实时费率与预览时长，在提交前报告六个分包的估算费用。用户已明确批准此批次采用价格更高的模型。

- [ ] **步骤 3：每份预览仅提交一次**

使用每个预览路径与其完整指纹作为幂等键调用 `submit_video`。结果未知时绝不发起第二次 PUT。

- [ ] **步骤 4：回读任务与费用**

使用 `jubian_video task/subtasks` 记录任务 ID、父子任务状态、全部身份字段、URL、分辨率与 `realCost`。实际总费用只根据回读报告。

### 任务 7：审查、清理并组装第 11 集

**文件：**
- 创建或更新：项目视频清单、下载的视频、审查证据、字幕状态、草稿文件、时间线、SRT 与渲染输入。

- [ ] **步骤 1：下载成功结果**

对每个已接受的子结果使用 `jubian_media download`，探测所有文件。

- [ ] **步骤 2：审查视觉与身份质量**

抽取代表帧，检查身份、服装、场景、道具、动作、口型、连续性、畸形肢体与嵌入文字。记录每个分包的通过或失败证据。

- [ ] **步骤 3：处理分辨率与字幕**

源输出为 480p，对照 1080p 交付要求，为报告 `needs_upscale=true` 的已接受片段调用 `jubian_video upscale`。只对含嵌入字幕的片段提交字幕擦除；异步轮询，并允许使用文档规定的五分钟后 pending 回退。

- [ ] **步骤 4：制作口播字幕与草稿**

加载 `tweet-drama-draft-build`，使用 faster_whisper 在本地转写组装后的整集音频，按实际说话时间对齐字幕，并对照原脚本纠正姓名与同音词。

- [ ] **步骤 5：选择 BGM 并准备渲染输入**

根据本集情感坐标调用 `bgm_match`，按照测得的 valence/arousal 选择最佳候选，并使用已接受镜头列表与 SRT 运行 `drama_render prepare`。

### 任务 8：渲染、验证与交付

**文件：**
- 创建：项目目录中的第 11 集最终 MP4、SRT、时间线、渲染日志与验证报告。

- [ ] **步骤 1：渲染固定交付输出**

加载 `tweet-drama-background-render`，再调用 `drama_render render`，设置 1440×2560、60fps、H.264 high@5.1、目标 24Mbps、AAC 192kbps、BGM 与片尾素材。

- [ ] **步骤 2：验证实际文件**

调用 `drama_render verify`。要求测得 1440×2560、60fps、H.264、音视频流、合理时长、无阻塞性黑屏或静音片段、字幕在范围内，且总码率至少 4.6Mbps。

- [ ] **步骤 3：同步最终流水线状态**

运行标准流水线同步，验证下游产物呈现第 11 集，没有把全部 50 集阶段错误标记为完成。

- [ ] **步骤 4：呈现交付物**

对最终 MP4、SRT、时间线与验证报告使用 `present`。报告实际生成、超分与字幕费用，以及最终测得的媒体属性。
