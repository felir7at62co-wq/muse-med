---
description: "按情绪排序本地或公开音乐并下载选定曲目，可选用非商业分析。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-perception-bgm

[English](README.md) | 中文

## 摘要

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

公开曲库 `https://muse.tos-cn-beijing.volces.com/bgm/index.json` 已通过无凭证、无 Python 的 `match` 与单曲校验下载测试。它不默认启用，由 profile 配置选用。公开音频权利与非商业分析模型许可是不同的义务。

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

npm 不携带任何模型权重。获取权重前请阅读[来源与许可](SOURCES.md)；仅有包内默认数据目录不足以分析。不启用离线模式时，首次分析可能下载冻结的 MERT 快照。当前进程的缓存位置环境变量会覆盖 `env` 中的同名项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

公开 manifest 为 `{version:1,tracks:[{id,name,sha256,bytes,url,valence,arousal,moods}]}`。每个 `id` 等于其 `sha256:<64 位小写十六进制>` 摘要。音轨 URL 必须精确等于曲库同源地址加 `/bgm/tracks/<hash>.<音频扩展名>`。HTTPS 传输不发送凭证，并拒绝重定向、部分响应、超限内容、无效测量值、重复 ID 和不安全文件名。下载流式写入私有临时目录内的独占文件，校验大小与 SHA-256，再原子重命名到内容寻址缓存路径；错误时删除暂存文件。调用取消与插件卸载会中止网络操作。

TypeScript 工具对缓存或公开测量值排序，仅在分析时延迟启动隔离的 NDJSON Python worker。worker 使用维护中的 Music2Emotion 推理适配器和第三方辅助源码。每次和弦/调性操作独占随机的系统临时目录，返回或异常时清理；不会向包内数据目录写中间文件。不发布 invariant 附件，因为本包没有需要核对的独立维护观测值。

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

manifest 包含全部 `lib/*.js` 产物、类型声明、worker 脚本、第三方 Python、静态数据及来源/许可记录。显式允许列表排除权重与缓存。Python 回归测试替代重型库，不分析音频也不访问网络。

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

一个工具提供 `match`、`download`、`index` 和 `inspect`。描述明确说明“返回的是候选排序，不是决定”，并标注 MERT“仅限非商业用途”。公开候选包含稳定 ID 而非本地路径；只有明确下载后才返回经校验的本地 `path`。结果包含测量的愉悦度/能量、情绪标签和候选距离，由代理选择曲目。

#### Token 影响

挂载增加一个固定工具 schema。match 最多返回 20 个候选；index 失败列表随失败文件数增长。Python 分析不调用语言模型。

#### KV Cache 影响

仅追加。稳定的 schema 文本保留请求前缀；调用追加工具结果，不改写既有消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Python 运行时、解释器、模型权重与缓存都是由 `scripts/runtime.py` 在包外准备的选装本地数据；它写出的内容不进入 npm 包，未记录上游 wheel 的 hash，干净机器或可重新分发载荷的验证也尚未进行。不得因本包 MIT 元数据而将 MERT 当作可商用模型。
- worker 直接拥有本地子进程；接入 subprocess 服务和等待进程完全退出属于独立生命周期工作。强制终止可能绕过 Python 临时目录清理。
- 即使复用已下载缓存，公开曲库也必须可访问。缓存不自动淘汰；不接收也不需要上传凭证。
- 同一索引的并发写入未协调。一次仅允许一个建库写入者；当前损坏或不可读的索引被视为空。
- 本包仍为 private，依赖使用 workspace 范围。发布打包器必须解析这些范围、包含运行时依赖闭包，并接入 Host TypeScript 聚合与包发现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`scripts/runtime.py` 是维护者工具，不进入 npm 包。`prepare`（仅 Windows x64）读取独立发行的 CPython 3.11.16 基底、一个已验证的 CPU 环境、冻结的 Hugging Face 缓存、两个检查点和两个按 hash 固定的 wheel，写出一个自包含目录树：复制进来的解释器、`Lib/site-packages`、MKL 与 Intel OpenMP 发行包记录在 site-packages 之外的 `Library/bin` DLL、`models/J_all.ckpt`、`models/data` 和 `models/hf-cache`。它只复制 RECORD 列出的资源，绝不从基底自身的 `site-packages` 或 `Scripts` 取任何文件，拒绝 venv 启动器、字节码、启动模块和指向外部的 `.pth` 路径，丢弃已审查的 setuptools `distutils-precedence.pth`，并把该决定与每个已安装文件的 SHA-256 一并记入 `runtime-manifest.json`。

`verify` 在运行前后各重算一次该清单，用 `-I -B -X utf8` 探测并要求 `sys.prefix`、`sys.base_prefix` 和每一项 `sys.path` 都落在目录树内，重命名目录树后再探测一次，并通过 `worker_main.py` 离线分析一首真实曲目。由于基底解释器是复制进来的，运行时不读取 `%APPDATA%` 下 uv 管理的安装，源环境可以随时删除。

把 `pythonExecutable`、`weightsPath` 和 `dataDir` 指向目录树的 `python\python.exe`、`models\J_all.ckpt` 和 `models\data`，并把 `env.HF_HOME` 设为 `models\hf-cache`。worker 的启动白名单只转发 `HF_HOME` 与环境系统变量，从不转发 `OMP_NUM_THREADS`、`MKL_NUM_THREADS` 或 `OPENBLAS_NUM_THREADS`，因此需要固定 BLAS 线程数的部署必须在 `env` 里自行设置；已验证的分析运行对三者都取 `1`。

</details>
