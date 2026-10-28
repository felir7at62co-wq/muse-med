---
description: "按情绪排序本地或公开音乐并下载选定曲目，可选用非商业分析。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-perception-bgm

[English](README.md) | 中文

## 概述

在 1–9 的愉悦度/能量坐标上查找接近目标情绪的 BGM 候选。`match` 读取本地索引或配置的公开曲库，不需要 Python 或模型权重。用 `download` 明确选定远端候选后，获得经校验、可用于合成的本地文件。`index` 和 `inspect` 需要单独准备的 Python 运行时和模型；MERT 骨干仅限非商业用途。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

组合包的[补丁](cordis.patch.yml)向已有工具注册表的 profile 贡献一行 `perception-bgm`。本包不会在运行中的 profile 自动安装或启用自身。桌面组装与 profile 安装验证仍由发布维护者负责。

不配置 `catalogUrl` 时，`match` 读取 `indexPath`，保持本地候选的 `path` 结果。缺失或空的本地索引会提示先建库。配置 `catalogUrl` 后，`match` 仅读取该公开曲库，返回 `track_id`、原始 `name`、公开 `url` 和测量值，绝不返回不存在的本地路径，也不自动下载音频。用选定的 `track_id` 调用 `download`，其已校验的 `path` 可直接作为 `drama_bgm` 的曲目来源。复用缓存时仍校验 SHA-256，且仍需读取在线曲库。`index` 和 `inspect` 保持为本地可选分析方法；只有启动对应 worker 才可能报 Python 依赖错误。

公开曲库 `https://muse.tos-cn-beijing.volces.com/bgm/catalog.json` 已通过无凭证、无 Python 的 `match` 与单曲校验下载测试。它不默认启用，由 profile 配置选用。公开音频权利与非商业分析模型许可是不同的义务。

候选、下载结果和已发布曲目都包含 `license_info`（`status`、`license`、`commercial_use`、`source`、`attribution`、`scope`）及 `license_warnings`。这些字段传递提供的权利声明，不表示授权已核验。缺失字段保持 `unknown`；允许商业使用的声明缺少许可、来源或范围时，商业权限降为 unknown。`match` 和 `download` 可选 `intended_use` 为 `commercial`、`non_commercial` 或 `unknown`（默认），只影响风险提示，不授予权限，也不阻断工具调用。非商业声明用于商业用途时返回风险提示。下载摘要只标识音频字节，不证明使用权。不支持的审批状态或非法字段类型会使声明校验失败；风险提示按本次用途重新计算，不直接采用已存提示。

选曲前向 `match` 传入绝对 `project` 和明确的剧情 `context_tags`。每次调用都会重新读取 `project_config.json` 中经用户确认的 `project_bible.bgm_feedback`；它通过 `drama_project` 的预览／版本校验流程保存。稳定曲目 ID 或内容摘要不受文件重命名影响。只有反馈的全部标签都出现在当前场景中，否决才生效；其他语境反馈仍可见，不是全局黑名单。后追加的适用用户决策可明确推翻先前否决，但不抹除历史。匹配保留原情绪距离，将适用的否决移入可审查的 `withheld_candidates`，不禁止下载。接受反馈仅作标注，不凭空赋予情绪分数。全部候选被否决时，无后加配乐是正常建议。旧项目缺少反馈不影响匹配；非法反馈明确报错，不悄悄丢弃。省略 `project` 不读取项目偏好；可选的 `story` 参数控制按剧情意图排序。

剧情配乐可选传入 `story`，包含非空 `intent`（最多 600 字符）、1–8 个 `desired_tags`、可选的 0–8 个 `avoid_tags`，以及 `dialogue_density`（`none`、`sparse`、`dense` 或默认 `unknown`）。音乐意图使用当前工具 schema 中的枚举，希望与避免标签不得重叠。Agent 根据实际剧本、观众所知信息和采用时间线确定这些意图；匹配器不解读意图文本。明确的曲名冲突移入可审查的 `review_candidates`；其余曲目先按 `desired_tags` 从高到低的优先级比较已有音频抽样标签命中，再比较曲名命中、情绪标签命中及未改动的情绪距离。音频/情绪标签冲突仅作提醒。`story_fit` 区分音频/曲名/情绪标签证据、未命中标签和未知音频属性；`supported` 仅表示有候选依据，不表示已试听或已认可。即使曲名适配，当前语境适用的用户否决仍会暂不推荐。三类候选列表分别限长。曲库缺少支持证据时建议考虑不加音乐；不确定和有冲突的候选仍可试听、下载。省略 `story` 保留仅按情绪排序；不含音频画像的曲库保留原有结果字段。

部署可启用 `requireStoryEvidence`（通用默认 false，Muse 创作预设启用）。剧情调用须提供 `story.evidence` 的 script 和 visual_review，可额外提供 transcript；每条含 kind、项目内 UTF-8 file 和 1–8 段最长 800 字符的真实 quotes。最多逐次读取八份、每份至多 2 MiB 的依据，引用匹配只忽略空白。画面记录为实际观察后的 JSON，含 video、video_sha256、observations；工具在 observations 中匹配引用，并流式核对项目内视频摘要。视频换版须重新检查。缺依据返回 needs_source_evidence；引用不符或视频换版返回 needs_source_correction、空候选和具体核对结果，均发生在曲库请求前。普通浏览仍为 reference_only。evidence_matched 仅证明文字引用和视频身份，不证明观察、剧情理解或音乐适配正确。现有通用部署保持兼容；见[生产迁移说明](../../../docs/upgrade-guide/v0.2.1-alpha.1/bgm-story-evidence/guide.zh.md)。

剧情调用返回实际试听检查项，对白密集时强调遮盖问题。文件名和标签不能核验人声、配器、时代、片段发展或音乐切点。逐场景检索、源曲偏移、揭示时机和渲染工具可听对比的操作见漫剧技能的[剧情选曲流程](../../drama/skills/skills/tweet-drama-background-render/references/story-bgm-selection.md)；本匹配器不生成完整配乐计划，也不保证创作验收通过。

连续下一段检索可传上一实选曲库 ID 或本地 SHA-256 的 `previous_track_id`。同一曲库提供真实测量和标签；身份不存在时返回 `missing_from_library`，不编造参考值。候选 `continuity_fit` 返回实测 V/A 绝对差之和、规范化标签集合交并比及共同标签。排序先保留本段主要剧情标签的证据，再优先阈值内的过渡，随后沿用原排序。缺少标签保持 `insufficient_tags`；提示只作建议，真实剧情转折可支持较大变化。检查完整序列及真实切点两侧；元数据检查不能核验速度、音色、响度或对白理解。

需要相邻两集优先换曲时，从当前项目 N−1 及已制作 N+1 集的实际配乐记录收集 `adjacent_episode_track_ids`，与同一集上一段音乐分开处理。主要剧情意图、衔接、冲突标签和音频抽样证据排序之后，匹配器给名单内曲目的排序距离增加 `adjacentEpisodeRepeatPenalty`，原始实测距离保持不变。候选公开惩罚值并保留可选性。摘要身份规范化大小写和可选 SHA 前缀；本地身份缺失保持 `unknown_identity`。匹配器不自行查找邻集计划，也不认证传入名单完整。真实跨集连续场景或主题回扣可保留同曲并记录依据。

曲库行可选携带版本 1 的 `audio_profile`，绑定曲目精确 SHA-256 和分析配方摘要。结果保留固定的模型标识、原始余弦标签分数、配器/人声推断、时长、估计节奏、RMS/peak dBFS 和抽样时间窗。此机器推断格式的 `human_reviewed` 必须为 false；相似度不是置信度百分比，抽样覆盖不等于整曲语义分析。源身份、采样边界/覆盖、测量值、标签分数或试听声明无效时拒绝该画像，不悄悄附上不相关证据。检索无需模型或 Python。缺少画像的旧曲库仍有效。

| 配置 | 解析方式 |
|---|---|
| `pythonExecutable` | 已存在的绝对可执行路径；未配置则用 `DSH_PERCEPTION_PYTHON`；路径不可用只阻止分析 |
| `weightsPath` | 已存在的情绪头权重绝对路径；未配置则用 `DSH_PERCEPTION_BGM_WEIGHTS`，再回落到 `<DSH_HOME>/perception/bgm/J_all.ckpt` |
| `dataDir` | 默认包内 `python/data`；分析部署必须提供外部目录，含包内**全部**静态数据和 `btc_model_large_voca.pt` |
| `indexPath` | 默认 `<DSH_HOME>/perception/bgm/bgm-index.json`；应可写且位于安装目录外 |
| `env` | 显式 worker 环境；用 `HF_HOME` 指向已准备的缓存，用 `HF_HUB_OFFLINE=1` 禁止下载 |
| `callTimeoutMs` | 每次分析默认 300000 毫秒 |
| `catalogUrl` | 省略则使用本地索引；配置后使用规范 HTTPS 曲库 URL，不允许凭证、查询参数或片段 |
| `cacheDir` | 默认 `<DSH_HOME>/perception/bgm/cache`；已校验下载的绝对目录 |
| `networkTimeoutMs` | 整个 match/download 操作默认 60000 毫秒 |
| `maxCatalogBytes` | 默认 2097152 解码字节 |
| `maxTrackBytes` | 每条曲库音频默认 134217728 字节 |
| `maxTransitionEmotionDistance` | 默认 3；相邻 V/A 绝对差之和建议上限，0–16 |
| `minTransitionTagOverlap` | 默认 0.2；规范化标签集合交并比建议下限，0–1 |
| `adjacentEpisodeRepeatPenalty` | 默认 2；对传入相邻集曲目 ID 增加的排序距离惩罚，0–16；零关闭该偏好 |
| `requireStoryEvidence` | 默认 false；剧情推荐要求当前剧本和绑定视频版本的画面观察原文 |

npm 不携带任何模型权重。获取权重前请阅读[来源与许可](SOURCES.md)；仅有包内默认数据目录不足以分析。不启用离线模式时，首次分析可能下载冻结的 MERT 快照。显式 `env` 项优先。设置 `HF_HOME`、`HF_HUB_CACHE`、`TRANSFORMERS_CACHE` 或 `HF_ENDPOINT` 中任一项时，不继承当前进程的这四项；未设置时才继承这组白名单。只读模型部署必须将 `HF_MODULES_CACHE`、`NUMBA_CACHE_DIR` 和应用缓存目录设在安装目录外的可写位置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

公开 manifest 为 `{version:1,tracks:[{id,name,sha256,bytes,url,valence,arousal,moods,license_info,license_warnings}]}`。每个 `id` 等于其 `sha256:<64 位小写十六进制>` 摘要。音轨 URL 默认精确等于曲库同源地址加 `/bgm/tracks/<hash>.<音频扩展名>`。曲目可声明 `object_key`（如 `bgm/tracks/1`）来引用已有编号对象，URL 必须精确等于同源地址加该键。键限定为 `bgm/tracks/` 下以 ASCII 字母或数字开头、仅含字母、数字、点、下划线或连字符的单个文件名；重复 URL 被拒绝。ID 与下载缓存路径仍按内容寻址，下载仍校验大小和 SHA-256。HTTPS 传输不发送凭证，并拒绝重定向、部分响应、超限内容、无效测量值、重复 ID 和不安全文件名。下载流式写入私有临时目录内的独占文件，校验大小与 SHA-256，再原子重命名到内容寻址缓存路径；错误时删除暂存文件。调用取消与插件卸载会中止网络操作。

维护者专用的 `scripts/build_tag_index.py` 读取已校验的本地音频和预先准备、固定版本的 CLAP 模型目录。每曲最多分布抽取十二个十秒片段，与记录的音乐意图提示文本比较，默认六个。它写出扩展曲库、独立 `tag-index.json`、CSV 和中文查阅表，不上传或修改音频。覆盖时长仅计算重叠区间一次。检查点只在音频与配方摘要一致时续用；配方记录提示文本、模型权重和依赖库版本。在独立环境准备 Torch 2.6.0、Transformers 4.57.6、librosa 0.11.0 和 soundfile 0.13.1；按 [SOURCES.md](SOURCES.md) 从官方来源获取固定版本模型。运行 `python scripts/build_tag_index.py --catalog <catalog.json> --audio-dir <numbered-audio-directory> --model-dir <prepared-model-directory> --output-dir <new-output-directory>`。发布元数据前审阅输出；音频推断不构成人工认可，也不改变音乐权利。

本地建库在复用测量值或声明前核对 SHA-256，即使大小和修改时间未变也核验。新曲或字节已变化的曲目授权设为 unknown；相同字节保留规范化后的声明。本地候选在索引含摘要时返回 `source_sha256`，供计划冻结选定字节。重分析失败也会清除已变化文件的旧声明。

TypeScript 工具对缓存或公开测量值排序，仅在分析时延迟启动隔离的 NDJSON Python worker。worker 使用维护中的 Music2Emotion 推理适配器和第三方辅助源码；分析库打印的诊断进入 stderr，stdout 只承载 NDJSON 响应。非响应 JSON 和诊断行会被忽略；响应必须含字符串请求 ID，才能结束对应的等待调用。调用取消与卸载会以明确的工具错误停止本地建库，普通单曲分析失败仍记录在建库结果中。卸载会移除工具注册、中止已接入操作、拒绝 worker 等待请求，并等候进程关闭和文件系统工作完成。已经开始的索引写入会在报告取消前完成；已完成的曲目记录保留供续跑，卸载后不会启动新的 worker 或索引写入。每次和弦/调性操作独占随机的系统临时目录，返回或异常时清理；不会向包内数据目录写中间文件。不发布 invariant 附件，因为本包没有需要核对的独立维护观测值。

在仓库根目录运行以下定向源码构建和离线检查：

```sh
pnpm exec tsc -p packages/perception/perception-bgm/tsconfig.json
pnpm exec tsdown --config packages/perception/perception-bgm/tsdown.config.ts
pnpm exec vitest run packages/perception/perception-bgm/tests/match-loader.spec.ts packages/perception/perception-bgm/tests/tools.spec.ts packages/perception/perception-bgm/tests/bundle-patch.spec.ts packages/perception/perception-bgm/tests/remote-library.spec.ts
python -B packages/perception/perception-bgm/tests/test_runtime_resources.py
```

构建后，在本包目录检查标准 npm 文件清单：

```sh
npm pack --dry-run --json --ignore-scripts --cache .test-npm-cache | node tests/check-pack.mjs
```

manifest 包含 `lib/index.js`、`lib/config.js`、`lib/worker.js`、类型声明、worker 脚本、第三方 Python、静态数据及来源/许可记录。显式允许列表排除 TypeScript 源文件、权重与缓存。Python 回归测试替代重型库，不分析音频也不访问网络。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [来源、版本与许可](SOURCES.md)
- [Harness profile 架构](../../../docs/architecture.zh.md)
- [工具实现](src/index.ts)

-----

<a id="model-experience"></a>
## 模型体验

### `bgm_match` 工具 schema

#### 模型看到什么

[生成的 `bgm_match` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-perception-bgm)提供 `match`、`download`、`index` 和 `inspect`。描述明确说明“返回的是候选排序，不是决定”，并标注 MERT“仅限非商业用途”。公开候选包含稳定 ID 而非本地路径；只有明确下载后才返回经校验的本地 `path`。结果包含测量的愉悦度/能量、情绪标签、候选距离、授权声明及用途风险提示，由代理选择曲目。

#### Token 影响

挂载增加一个固定工具 schema。match 最多返回 20 个推荐候选、20 个暂不推荐候选和 20 个剧情冲突复核候选，每个候选最多附八条近期身份匹配反馈摘要；文本及历史展示预算有明确的截断标记，`history_count` 和 `config_path` 指向未改动的完整历史。匹配使用完整记录，不使用展示摘要。index 失败列表随失败文件数增长。Python 分析不调用语言模型。

#### KV Cache 影响

仅追加。稳定的 schema 文本保留请求前缀；调用追加工具结果，不改写既有消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Python 运行时、解释器、模型权重与缓存都是由 `scripts/runtime.py` 在包外准备的选装本地数据；它写出的内容不进入 npm 包，未记录上游 wheel 的 hash，干净机器或可重新分发载荷的验证也尚未进行。不得因本包 MIT 元数据而将 MERT 当作可商用模型。
- worker 直接拥有本地子进程；接入 subprocess 服务仍属于独立生命周期工作。强制终止可能绕过 Python 临时目录清理。
- 即使复用已下载缓存，公开曲库也必须可访问。缓存不自动淘汰；不接收也不需要上传凭证。
- 同一索引的并发写入未协调。一次仅允许一个建库写入者；当前 JSON 损坏或不可读的索引被视为空；非法权利声明会使匹配失败。
- 反馈场景标签仍为明确标签：Agent 读取用户反馈后映射相近剧情语境。音频画像标签是预计算的抽样音频假设，不代表理解剧情、核实配器或校准适配度。更小的距离、模型分数或已接受曲目不能证明剧情适配、权利明确或对白可听；使用渲染工具可听的有配乐／无后加配乐对比。match 和 download 不加载分析模型。
- 工作区检查要求本包保持 private 并省略 `publishConfig`。桌面打包器必须解析 workspace 依赖范围并包含运行时依赖闭包；本包禁止公开发布到 npm。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`scripts/runtime.py` 是维护者工具，不进入 npm 包。`prepare`（仅 Windows x64）读取独立发行的 CPython 3.11.16 基底、一个已验证的 CPU 环境、冻结的 Hugging Face 缓存、两个检查点和两个按 hash 固定的 wheel，写出一个自包含目录树：复制进来的解释器、`Lib/site-packages`、MKL 与 Intel OpenMP 发行包记录在 site-packages 之外的 `Library/bin` DLL、`models/J_all.ckpt`、`models/data` 和 `models/hf-cache`。它只复制 RECORD 列出的资源，绝不从基底自身的 `site-packages` 或 `Scripts` 取任何文件，拒绝 venv 启动器、字节码、启动模块和指向外部的 `.pth` 路径，丢弃已审查的 setuptools `distutils-precedence.pth`，并把该决定与每个已安装文件的 SHA-256 一并记入 `runtime-manifest.json`。 清单用 `packageSource` 记录复制的发行包来源。

`verify` 在运行前后各重算一次该清单，用 `-I -B -X utf8` 探测并要求 `sys.prefix`、`sys.base_prefix` 和每一项 `sys.path` 都落在目录树内，重命名目录树后再探测一次，并通过 `worker_main.py` 离线分析一首真实曲目。由于基底解释器是复制进来的，运行时不读取 `%APPDATA%` 下 uv 管理的安装，源环境可以随时删除。

把 `pythonExecutable`、`weightsPath` 和 `dataDir` 指向目录树的 `python\python.exe`、`models\J_all.ckpt` 和 `models\data`，并把 `env.HF_HOME` 设为 `models\hf-cache`。worker 的启动白名单只转发 `HF_HOME` 与环境系统变量，从不转发 `OMP_NUM_THREADS`、`MKL_NUM_THREADS` 或 `OPENBLAS_NUM_THREADS`，因此需要固定 BLAS 线程数的部署必须在 `env` 里自行设置；已验证的分析运行对三者都取 `1`。

</details>
