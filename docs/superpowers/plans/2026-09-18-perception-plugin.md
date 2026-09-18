# 感知插件（字幕扫描 + BGM 匹配）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增两个 DSH 插件包——`perception-subs`（抽帧找字幕区间）与 `perception-bgm`（按 valence/arousal 为镜头选 BGM 候选），都不依赖 MUSE。

**Architecture:** 一个共享前置（ffmpeg 定位）加两个插件。`perception-bgm` 在包内 vendor Music2Emo 的算法代码并用常驻 Python worker 跑推理；排序用 valence/arousal 距离，不用文本嵌入。`perception-subs` 只用 ffmpeg 抽帧，把判断交给调用方的视觉模型。

**Tech Stack:** TypeScript（Node ESM，`tsc -b` 出 `lib/types`，tsdown 打包）、Cordis 插件、vitest、Python 3.11 + torch 2.3.1(CPU) + transformers 4.44、ffmpeg/ffprobe。

**依据文档：** `docs/superpowers/specs/2026-09-18-subtitle-bgm-plugin-design.md`

---

## 关键前置事实（全部已实测，不要重新推导）

| 事实 | 出处 |
|---|---|
| **`Music2emo.predict()` 在 5% 输入上必然崩溃**：音频长度非 30 秒整数倍且尾部残段极短时，`utils/mert.py:27` 的 `.squeeze()` 压掉帧轴 | spec §4.8.1 |
| 崩溃边界实测：失败者 remainder 全为 **2915** 样本，成功者最小 **7392** 样本；按 24 kHz 换算约 0.12 s vs 0.31 s | `mechanism-confirmation.json` |
| **丢弃短于 0.5 秒的尾部残段即可规避**这一整类崩溃，且对结果无损 | spec §4.8.2 |
| 匹配主力是 **valence/arousal 距离**：57 首 × 15 查询得 **15/15**；最好的文本变体只有 14/15 | spec §4.9.1 |
| 文本变体的相似度全挤在 0.33–0.62 窄带，排序靠噪声 | spec §4.9.2 |
| 全库索引实测 **33.1 分钟 / 60 首**；单首 7.1–71.3 s | `library-emotions.ndjson` |
| MERT 权重 **360 MB**（下载）；情感头 12.4 MB + 和弦模型 11.7 MB **随仓库自带** | spec §4.2 |
| MERT 是 **`cc-by-nc-4.0`（非商用）** | spec §5 |
| **必须钉住 HF revision**：`trust_remote_code=True` 会执行下载来的 `modeling_MERT.py` | spec §4.8 安全发现 |
| MUSE 的 Python 调用形状：`spawn(python, ['-I','-B','-X','utf8', script, ...])`，环境只留 `SystemRoot`/`WINDIR`/`SYSTEMROOT`，超时 `SIGKILL`，stdout+stderr 合计字节上限 | `muse-product/src/asr-worker.ts:84-112` |
| 工具定义用 `defineTool`，`output.schema` + `output.render` 必填 | `packages/fs/tool-fs/src/read.ts:77-130` |
| `ctx.tools.register(definition)` 返回 disposer；`exec.signal` 是取消信号 | `packages/core/tools/src/index.ts:401` |
| `dshHomePath(...segments)` 可用 | `packages/util/home-paths/src/index.ts:98` |
| 新包必须在 `tsconfig.host.json` 的 references 显式登记，否则 `tsc -b` 失败 | `tsconfig.json:11-14` |
| 新包必须跑 `pnpm run gen-tsconfig-paths` 才会被 vitest 按源码解析 | `vitest.config.ts:16-20` |
| **仓库禁用非空断言 `!`**（oxlint），pre-commit 会拦 | 前一份计划的实施教训 |
| Python 3.11.16 实测可用；系统解释器是 3.14.5（不可用，依赖钉在 2024 年版） | spec §4.2 |

## 本轮不做

- 不实现 `perception_setup`（显式准备）。本轮用**已建好的验证环境**（`E:\aa-manju\M2E-verify\.venv`）跑通功能，准备流程单独一轮。
- 不做字幕的视觉模型调用。`perception-subs` 只产出帧与候选区间，判断交给调用方。
- 不接剧变资产（spec 阶段 5）。
- 不做客户端 UI。

## 文件结构

```
packages/perception/
  perception-ffmpeg/                 共享前置：定位或获取 ffmpeg/ffprobe
    package.json  tsconfig.json
    src/index.ts                     resolveFfmpeg()
    tests/resolve.spec.ts
  perception-bgm/                    BGM 情感与匹配
    package.json  tsconfig.json
    src/config.ts                    Python 解释器解析、模型目录、权重来源
    src/worker.ts                    常驻 worker 池（NDJSON over stdio）
    src/index.ts                     Cordis 插件：注册 bgm 工具
    python/
      PROVENANCE.md                  来源、版本、每文件 sha256、MIT 许可副本
      emo_pipeline.py                自写管线（规避 squeeze 陷阱、丢弃短残段）
      worker_main.py                 常驻入口：NDJSON 循环
      vendored/                      上游 utils/ 与 model/ 的机械搬运
    tests/worker.spec.ts             协议单测（用假 worker 脚本）
    tests/pipeline.spec.ts           管线单测（用 stub 模型，不碰真模型）
  perception-subs/                   字幕扫描
    package.json  tsconfig.json
    src/frames.ts                    抽帧命令构造（照搬 media-worker.ts 的滤镜）
    src/index.ts                     Cordis 插件：probe / frames / scan
    tests/frames.spec.ts
```

---

## Phase 1 — `perception-ffmpeg`

### Task 1: ffmpeg 定位与获取

**Files:**
- Create: `packages/perception/perception-ffmpeg/package.json`
- Create: `packages/perception/perception-ffmpeg/tsconfig.json`
- Create: `packages/perception/perception-ffmpeg/src/index.ts`
- Create: `packages/perception/perception-ffmpeg/tests/resolve.spec.ts`
- Modify: `tsconfig.host.json`（references 里加一行）

- [ ] **Step 1: 写失败的测试**

Create `packages/perception/perception-ffmpeg/tests/resolve.spec.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveFfmpeg } from '../src/index.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'perception-ffmpeg-')) })

/** A probe that answers like a real `ffmpeg -version` run. */
const okProbe = async () => true
const noProbe = async () => false

describe('resolveFfmpeg', () => {
  it('prefers an explicitly configured pair and reports where it came from', async () => {
    const ffmpeg = join(dir, 'ffmpeg.exe'), ffprobe = join(dir, 'ffprobe.exe')
    await writeFile(ffmpeg, 'x'); await writeFile(ffprobe, 'x')
    const found = await resolveFfmpeg({ ffmpegExecutable: ffmpeg, ffprobeExecutable: ffprobe,
      probe: okProbe, which: async () => undefined, download: async () => { throw new Error('must not download') } })
    expect(found).toEqual({ ffmpegExecutable: ffmpeg, ffprobeExecutable: ffprobe, source: 'configured' })
  })

  it('falls back to PATH when nothing is configured', async () => {
    const found = await resolveFfmpeg({ probe: okProbe,
      which: async (name) => (name === 'ffmpeg' ? 'C:/bin/ffmpeg.exe' : 'C:/bin/ffprobe.exe'),
      download: async () => { throw new Error('must not download') } })
    expect(found.source).toBe('path')
    expect(found.ffmpegExecutable).toBe('C:/bin/ffmpeg.exe')
  })

  it('reports unavailable without downloading when nothing is found', async () => {
    const found = await resolveFfmpeg({ probe: okProbe, which: async () => undefined,
      download: async () => { throw new Error('must not download') } })
    expect(found).toEqual({ ffmpegExecutable: '', ffprobeExecutable: '', source: 'unavailable' })
  })

  it('rejects a configured path that does not run, rather than trusting its name', async () => {
    const ffmpeg = join(dir, 'ffmpeg.exe'), ffprobe = join(dir, 'ffprobe.exe')
    await writeFile(ffmpeg, 'x'); await writeFile(ffprobe, 'x')
    expect(await resolveFfmpeg({ ffmpegExecutable: ffmpeg, ffprobeExecutable: ffprobe,
      probe: noProbe, which: async () => undefined, download: async () => { throw new Error('no') } }))
      .toEqual({ ffmpegExecutable: '', ffprobeExecutable: '', source: 'unavailable' })
  })

  it('downloads into the configured cache only when asked to', async () => {
    const calls: string[] = []
    const found = await resolveFfmpeg({ probe: okProbe, which: async () => undefined,
      allowDownload: true,
      download: async (target) => { calls.push(target); return { ffmpegExecutable: join(target, 'ffmpeg'),
        ffprobeExecutable: join(target, 'ffprobe'), source: 'downloaded' } } })
    expect(calls.length).toBe(1)
    expect(found.source).toBe('downloaded')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/perception/perception-ffmpeg/tests/resolve.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/index.ts"`

- [ ] **Step 3: 写实现**

Create `packages/perception/perception-ffmpeg/src/index.ts`:

```ts
/**
 * Locate a usable ffmpeg/ffprobe pair, in the order a deployment can actually control.
 *
 * Both perception plugins need the pair before they can do anything, and neither
 * shipped binary is on PATH on this machine. Resolution therefore has three
 * tiers — configuration, PATH, an explicit download — and the last one only runs
 * when the caller opts in, because downloading an executable is a decision that
 * belongs to a human, not to a first tool call.
 *
 * A configured path is never trusted by name: it must actually run, because a
 * stale path in configuration otherwise surfaces later as a confusing frame
 * extraction failure.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Where a resolved pair came from, so a failure can name the reason. */
export type FfmpegSource = 'configured' | 'path' | 'downloaded' | 'unavailable'

export interface FfmpegResolution {
  ffmpegExecutable: string
  ffprobeExecutable: string
  source: FfmpegSource
}

export interface FfmpegResolveOptions {
  ffmpegExecutable?: string
  ffprobeExecutable?: string
  /** Directory a download would land in. */
  cacheDir?: string
  /** Whether a download is permitted at all; the default refuses. */
  allowDownload?: boolean
  /** Runs the candidate and reports whether it is a working binary. Injected for tests. */
  probe: (executable: string) => Promise<boolean>
  /** PATH lookup. Injected for tests. */
  which: (name: string) => Promise<string | undefined>
  /** Performs the download. Injected so tests never touch the network. */
  download: (targetDir: string) => Promise<FfmpegResolution>
}

const UNAVAILABLE: FfmpegResolution = { ffmpegExecutable: '', ffprobeExecutable: '', source: 'unavailable' }

/**
 * Resolve the pair in configuration → PATH → download order.
 * @param options - Stated paths, the cache directory, and the injected probes.
 * @returns The pair and its provenance, or an empty pair marked `unavailable`.
 */
export async function resolveFfmpeg(options: FfmpegResolveOptions): Promise<FfmpegResolution> {
  const usable = async (executable: string | undefined): Promise<boolean> =>
    typeof executable === 'string' && executable.length > 0 && isAbsolute(executable)
    && existsSync(executable) && await options.probe(executable)

  if (await usable(options.ffmpegExecutable) && await usable(options.ffprobeExecutable)) {
    return { ffmpegExecutable: resolve(options.ffmpegExecutable as string),
      ffprobeExecutable: resolve(options.ffprobeExecutable as string), source: 'configured' }
  }

  const [onPath, onPathProbe] = await Promise.all([options.which('ffmpeg'), options.which('ffprobe')])
  if (onPath !== undefined && onPathProbe !== undefined
    && await options.probe(onPath) && await options.probe(onPathProbe)) {
    return { ffmpegExecutable: onPath, ffprobeExecutable: onPathProbe, source: 'path' }
  }

  if (options.allowDownload !== true) return UNAVAILABLE
  const target = options.cacheDir ?? join(process.cwd(), '.perception', 'ffmpeg')
  const downloaded = await options.download(target)
  if (!await options.probe(downloaded.ffmpegExecutable) || !await options.probe(downloaded.ffprobeExecutable)) {
    return UNAVAILABLE
  }
  return downloaded
}
```

Create `packages/perception/perception-ffmpeg/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-perception-ffmpeg",
  "description": "Locate or obtain the ffmpeg/ffprobe pair the perception plugins need",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT"
}
```

Create `packages/perception/perception-ffmpeg/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": []
}
```

Modify `tsconfig.host.json`: 在 references 里按现有顺序插入（`perception` 排在 `plan` 之前）：

```json
    { "path": "./packages/perception/perception-ffmpeg" },
    { "path": "./packages/perception/perception-bgm" },
    { "path": "./packages/perception/perception-subs" },
```

再跑生成器，让 vitest 能按源码解析这三个包：

```bash
pnpm run gen-tsconfig-paths
```

- [ ] **Step 4: 安装链接并运行测试**

Run: `pnpm install --prefer-offline` 然后 `npx vitest run packages/perception/perception-ffmpeg/tests/resolve.spec.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 类型检查**

Run: `npx tsc -b packages/perception/perception-ffmpeg`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add packages/perception/perception-ffmpeg tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(perception): add ffmpeg resolver"
```

---

## Phase 2 — `perception-bgm` 的 Python 侧

### Task 2: vendor 上游算法代码

**Files:**
- Create: `packages/perception/perception-bgm/python/vendored/*`（从上游机械复制）
- Create: `packages/perception/perception-bgm/python/PROVENANCE.md`
- Create: `packages/perception/perception-bgm/python/data/*`（权重与映射）

这是**机械搬运**，不写新逻辑。上游路径：`E:\aa-manju\开源可fork项目\Music2Emotion-main`。

- [ ] **Step 1: 复制上游文件并记录哈希**

```powershell
$src = 'E:\aa-manju\开源可fork项目\Music2Emotion-main'
$dst = 'E:\deepseek-harness\packages\perception\perception-bgm\python'
New-Item -ItemType Directory -Force -Path "$dst\vendored","$dst\data" | Out-Null
foreach ($f in 'mert.py','btc_model.py','chords.py','constants.py','hparams.py','preprocess.py',
               'transformer_modules.py','custom_early_stopping.py','logger.py','pytorch_utils.py',
               'tf_logger.py','mir_eval_modules.py') {
  Copy-Item "$src\utils\$f" "$dst\vendored\$f" -Force
}
foreach ($f in 'linear.py','linear_attn_ck.py','linear_mt_attn_ck.py','__init__.py') {
  Copy-Item "$src\model\$f" "$dst\vendored\model_$f" -Force
}
Copy-Item "$src\inference\data\btc_model_large_voca.pt" "$dst\data\" -Force
Copy-Item "$src\inference\data\chord*.json" "$dst\data\" -Force
Copy-Item "$src\inference\data\run_config.yaml" "$dst\data\" -Force
Copy-Item "$src\inference\data\tag_list.npy" "$dst\data\" -Force
Copy-Item "$src\LICENSE" "$dst\LICENSE-Music2Emo" -Force
Get-ChildItem "$dst" -Recurse -File | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.FullName.Replace($dst,'')
}
```

- [ ] **Step 2: 写 PROVENANCE.md**

把上一步输出的每一行哈希填进下表。文件必须写明：

```markdown
# Vendored Music2Emo inference code

Source: https://github.com/AMAAI-Lab/Music2Emotion (local copy at
`E:\aa-manju\开源可fork项目\Music2Emotion-main`, 2026-09-18)
License: MIT — see `LICENSE-Music2Emo` in this directory.

Copied verbatim; only the module layout was flattened (upstream `model/*.py` becomes
`model_*.py`) and the demo/UI entry points were NOT copied. The emotion inference
entry point (`music2emo.py`) is deliberately NOT vendored: it imports gradio at
module scope and its `predict()` crashes deterministically on 5% of a real library
(see design doc §4.8). `emo_pipeline.py` is our own pipeline instead.

| File | SHA-256 |
|---|---|
| vendored/mert.py | <在这里填> |
| ... | ... |

Model weights (`data/btc_model_large_voca.pt`, and the emotion head fetched during
preparation) are MIT-covered artifacts; their source URLs and hashes must be
recorded here too when they are added.
```

- [ ] **Step 3: 提交**

```bash
git add packages/perception/perception-bgm/python
git commit -m "chore(perception-bgm): vendor Music2Emo inference code with provenance"
```

### Task 3: 自写管线（规避上游陷阱）

**Files:**
- Create: `packages/perception/perception-bgm/python/emo_pipeline.py`
- Create: `packages/perception/perception-bgm/python/worker_main.py`
- Create: `packages/perception/perception-bgm/tests/pipeline.spec.ts`（Node 侧，用桩 worker 验证协议与守卫）

- [ ] **Step 1: 写管线**

Create `packages/perception/perception-bgm/python/emo_pipeline.py`:

```python
"""
Emotion inference over one audio file, written here rather than reusing upstream's
`Music2emo.predict()` because that entry point crashes on a real library.

Measured on this machine (60 tracks): three files died with
    IndexError: too many indices for tensor of dimension 2
inside `utils/mert.py:27`:
    torch.stack(model_outputs.hidden_states).squeeze()[1:, :, :]

Cause: `split_audio` cuts 30-second segments, so a 60.12 s track yields
[720000, 720000, 2915]. The 2915-sample tail (0.12 s) produces exactly ONE frame at
24 kHz, so `hidden_states` are (1, 1, 768) each; `stack` gives (13, 1, 1, 768) and
`squeeze()` collapses BOTH the batch and frame axes to (13, 768). The three-index
read then fails.

Failures' remainders: 2915 samples, all three. Smallest remainder among successes:
7392 samples. So the guard below drops any trailing remainder under 0.5 s, which on
a three-minute track is inaudible and removes the whole failure class.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import time
from pathlib import Path

import numpy as np
import torch

TARGET_SR = 24000
SEGMENT_SECONDS = 30
# 0.5 s at 24 kHz. The measured boundary sits between 2915 (fails) and 7392 (passes);
# this is the conservative side of it.
MIN_TRAILING_SAMPLES = 12000
DEFAULT_REVISION = 'main'


def checksum(path: Path) -> str:
    with path.open('rb') as stream:
        return 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()


def _resample(waveform: torch.Tensor, source_rate: int, target_rate: int) -> torch.Tensor:
    if source_rate == target_rate:
        return waveform
    import torchaudio
    return torchaudio.functional.resample(waveform, source_rate, target_rate)


def split_segments(waveform: torch.Tensor, sample_rate: int) -> tuple[list[torch.Tensor], int]:
    """Cut 30-second segments and drop a trailing remainder too short to be safe.

    @returns (segments, dropped_samples) — the dropped count is reported so a caller
      can see that audio was discarded, rather than it happening silently.
    """
    step = SEGMENT_SECONDS * sample_rate
    total = waveform.size(0)
    segments: list[torch.Tensor] = []
    dropped = 0
    start = 0
    while start < total:
        end = min(start + step, total)
        chunk = waveform[start:end]
        if chunk.size(0) < step and chunk.size(0) < MIN_TRAILING_SAMPLES:
            # Too short to yield more than a single frame; upstream's squeeze would
            # collapse the frame axis here.
            dropped = chunk.size(0)
            break
        segments.append(chunk)
        start = end
    return segments, dropped


def _mert_embedding(extractor, segments: list[torch.Tensor], sample_rate: int) -> np.ndarray:
    """Mean of layer-5 and layer-6 embeddings across segments, as upstream computes it."""
    per_segment: list[np.ndarray] = []
    for segment in segments:
        batch = extractor.processor(segment.float(), sampling_rate=sample_rate, return_tensors='pt')
        with torch.no_grad():
            outputs = extractor.model(**batch, output_hidden_states=True)
        states = torch.stack(outputs.hidden_states)
        squeezed = states.squeeze()
        # Refuse to guess if the axes collapsed: an explicit error beats a wrong number.
        if squeezed.ndim != 3:
            raise ValueError(f'EMBEDDING_SHAPE_COLLAPSED:{tuple(states.shape)}')
        picked = squeezed[1:, :, :].unsqueeze(0)
        mean_over_layers = picked.mean(dim=2)
        per_segment.append(mean_over_layers.cpu().detach().numpy().squeeze())
    stacked = np.array(per_segment)
    return np.mean(stacked, axis=0)


def analyse(audio_path: Path, model_dir: Path, weights_path: Path,
            revision: str = DEFAULT_REVISION, source_sha256: str | None = None) -> dict:
    """Run one file end to end and return a JSON-serialisable emotion result."""
    import torchaudio
    import sys

    if not audio_path.is_absolute() or not audio_path.is_file():
        raise ValueError('AUDIO_INVALID_SOURCE')
    actual = checksum(audio_path)
    if source_sha256 is not None and actual != source_sha256:
        raise ValueError('AUDIO_SOURCE_CHANGED')

    vendored = Path(__file__).resolve().parent / 'vendored'
    if str(vendored) not in sys.path:
        sys.path.insert(0, str(vendored))

    started = time.monotonic()
    waveform, sample_rate = torchaudio.load(str(audio_path))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    waveform = waveform.squeeze()
    waveform = _resample(waveform, sample_rate, TARGET_SR)

    segments, dropped = split_segments(waveform, TARGET_SR)
    if not segments:
        raise ValueError('AUDIO_TOO_SHORT')

    from mert import FeatureExtractorMERT
    extractor = FeatureExtractorMERT(model_name='m-a-p/MERT-v1-95M',
                                     device=torch.device('cpu'), sr=TARGET_SR)
    embedding = _mert_embedding(extractor, segments, TARGET_SR)

    # The emotion head and its vocabulary come from the vendored copy.
    from model_linear_mt_attn_ck import FeedforwardModelMTAttnCK
    head = FeedforwardModelMTAttnCK(input_size=768 * 2, output_size_classification=56,
                                    output_size_regression=2)
    checkpoint = torch.load(str(weights_path), map_location='cpu', weights_only=False)
    state = {key.replace('model.', ''): value for key, value in checkpoint['state_dict'].items()}
    head.load_state_dict({k: v for k, v in state.items() if k in set(head.state_dict().keys())})
    head.eval()

    with torch.no_grad():
        output = head(torch.from_numpy(embedding).float().unsqueeze(0))
    probs = output[0].squeeze().tolist() if isinstance(output, (tuple, list)) else output.squeeze().tolist()
    tags = np.load(str(model_dir / 'tag_list.npy'), allow_pickle=True).tolist()

    # Upstream thresholds mood tags at 0.5; valence/arousal are the two regression heads.
    regression = output[1].squeeze().tolist() if isinstance(output, (tuple, list)) else [0.0, 0.0]
    moods = [tags[i] for i, p in enumerate(probs) if isinstance(p, float) and p > 0.5]

    return {
        'schema_version': 1,
        'source_sha256': actual,
        'seconds': round(waveform.size(0) / TARGET_SR, 3),
        'segments_used': len(segments),
        'dropped_trailing_samples': dropped,
        'valence': float(regression[0]),
        'arousal': float(regression[1]),
        'moods': moods,
        'model_revision': revision,
        'elapsed_seconds': round(time.monotonic() - started, 2),
        'dependencies': {name: importlib.metadata.version(name)
                         for name in ('torch', 'transformers', 'librosa', 'music21')},
    }
```

> **实现者注意**：`FeedforwardModelMTAttnCK` 的**真实前向返回形状**必须以 vendored 代码为准。上面按"返回 (分类, 回归) 二元组"处理；若实际是单个张量或别的顺序，**改 `analyse` 里解析输出的那几行，不要改 vendored 文件**。这一步在 Step 3 会被真实运行验证。

- [ ] **Step 2: 写常驻入口**

Create `packages/perception/perception-bgm/python/worker_main.py`:

```python
"""
Resident NDJSON worker: one process per face, model loaded once.

Protocol, one JSON object per line in each direction:
  -> {"id": "...", "method": "analyse", "params": {...}}
  <- {"id": "...", "status": "ok", "result": {...}}
  <- {"id": "...", "status": "error", "error": {"code": "...", "message": "..."}}

The first line out is a handshake so a caller learns about missing dependencies
before the first analysis rather than during it. Nothing but protocol JSON ever
reaches stdout; anything else goes to stderr, because a stray print would corrupt
the stream and the failure would look like a protocol bug.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + '\n')
    sys.stdout.flush()


def handshake() -> dict:
    missing = []
    for name in ('torch', 'torchaudio', 'transformers', 'librosa', 'music21', 'numpy'):
        try:
            __import__(name)
        except Exception as error:  # noqa: BLE001
            missing.append(f'{name}: {type(error).__name__}')
    return {'ready': not missing, 'face': 'emotion', 'missing': missing,
            'python': sys.version.split()[0]}


def dispatch(method: str, params: dict) -> dict:
    if method != 'analyse':
        raise ValueError(f'UNKNOWN_METHOD:{method}')
    from emo_pipeline import analyse
    return analyse(audio_path=Path(params['audio_path']),
                   model_dir=Path(params.get('model_dir', HERE / 'data')),
                   weights_path=Path(params['weights_path']),
                   revision=params.get('revision', 'main'),
                   source_sha256=params.get('source_sha256'))


def main() -> int:
    emit({'id': '__handshake__', 'status': 'ok', 'result': handshake()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            result = dispatch(request['method'], request.get('params') or {})
            emit({'id': request_id, 'status': 'ok', 'result': result})
        except Exception as error:  # noqa: BLE001 - every failure must answer, never die
            emit({'id': request_id, 'status': 'error',
                  'error': {'code': type(error).__name__, 'message': str(error)[:500],
                            'traceback': traceback.format_exc()[-800:]}})
    return 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        raise SystemExit(main())
    except Exception:
        print('WORKER_FAILED', file=sys.stderr)
        raise
```

- [ ] **Step 3: 用真实环境验证管线（这一步不能跳过）**

```powershell
$py = 'E:\aa-manju\M2E-verify\.venv\Scripts\python.exe'
$pyi = 'E:\deepseek-harness\packages\perception\perception-bgm\python'
echo '{"id":"1","method":"analyse","params":{"audio_path":"E:\\aa-manju\\M2E-verify\\audio-all\\track018.mp3","weights_path":"E:\\aa-manju\\开源可fork项目\\Music2Emotion-main\\saved_models\\J_all.ckpt"}}' |
  & $py -I -B -X utf8 "$pyi\worker_main.py"
```

Expected: 第一行握手 `{"ready": true, ...}`；第二行 `status:"ok"`。

**关键验收点**：`track018.mp3` 是**已知会让上游 `predict()` 崩溃**的那一首（spec §4.8）。如果这里返回 `status:"ok"` 且 `dropped_trailing_samples` 接近 2915，说明规避生效。**若仍报 `EMBEDDING_SHAPE_COLLAPSED` 或 IndexError，停下来报告，不要继续。**

再对 `track010.mp3`（已知正常）跑一次，确认结果合理（valence/arousal 在 1–9 之间）。

- [ ] **Step 4: 提交**

```bash
git add packages/perception/perception-bgm/python
git commit -m "feat(perception-bgm): add emotion pipeline that avoids the upstream squeeze crash"
```

---

## Phase 3 — `perception-bgm` 的 Node 侧

### Task 4: 常驻 worker 池

**Files:**
- Create: `packages/perception/perception-bgm/package.json`
- Create: `packages/perception/perception-bgm/tsconfig.json`
- Create: `packages/perception/perception-bgm/src/worker.ts`
- Create: `packages/perception/perception-bgm/tests/worker.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/perception/perception-bgm/tests/worker.spec.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { EmotionWorker } from '../src/worker.ts'

let dir: string
let script: string

/** A stand-in worker that speaks the real protocol without loading a model. */
async function writeWorker(body: string): Promise<string> {
  const path = join(dir, 'fake_worker.py')
  await writeFile(path, body, 'utf8')
  return path
}

const ECHO_WORKER = `
import json, sys
sys.stdout.write(json.dumps({"id": "__handshake__", "status": "ok",
                             "result": {"ready": True, "face": "emotion", "missing": []}}) + "\\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    if req.get("method") == "boom":
        sys.stdout.write(json.dumps({"id": req["id"], "status": "error",
            "error": {"code": "ValueError", "message": "nope"}}) + "\\n")
    else:
        sys.stdout.write(json.dumps({"id": req["id"], "status": "ok",
            "result": {"echo": req.get("params")}}) + "\\n")
    sys.stdout.flush()
`

const DEAF_WORKER = `
import sys, time
sys.stdout.write("not json\\n"); sys.stdout.flush()
time.sleep(60)
`

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'perception-bgm-')) })

describe('EmotionWorker', () => {
  it('starts a resident process, reads the handshake and answers a request', async () => {
    script = await writeWorker(ECHO_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 20000 })
    try {
      const handshake = await worker.start()
      expect(handshake.ready).toBe(true)
      const result = await worker.call('analyse', { audio_path: 'x.mp3' })
      expect(result).toEqual({ echo: { audio_path: 'x.mp3' } })
    } finally { await worker.dispose() }
  }, 30000)

  it('surfaces a worker error with its code instead of hanging', async () => {
    script = await writeWorker(ECHO_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 20000 })
    try {
      await worker.start()
      await expect(worker.call('boom', {})).rejects.toThrow(/nope/)
    } finally { await worker.dispose() }
  }, 30000)

  it('times out and marks itself dead when the worker never answers', async () => {
    script = await writeWorker(DEAF_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 2000 })
    await expect(worker.start()).rejects.toThrow(/handshake/i)
    expect(worker.alive).toBe(false)
  }, 30000)

  it('invokes the interpreter with the isolation flags MUSE uses', async () => {
    script = await writeWorker(ECHO_WORKER)
    const calls: string[][] = []
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script,
      readyTimeoutMs: 20000, spawn: (argv) => { calls.push(argv) } })
    try { await worker.start() } finally { await worker.dispose() }
    expect(calls[0]!.slice(1, 4)).toEqual(['-I', '-B', '-X'])
  }, 30000)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/perception/perception-bgm/tests/worker.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/worker.ts"`

- [ ] **Step 3: 写实现**

Create `packages/perception/perception-bgm/src/worker.ts`:

```ts
/**
 * One resident Python process for emotion analysis.
 *
 * Resident because loading the MERT backbone costs ~10–16 s, which a per-call
 * spawn would pay on every analysis. The protocol is newline-delimited JSON in
 * both directions, and the child is started with `-I -B -X utf8` under a
 * scrubbed environment, matching how the rest of the harness launches Python:
 * `-I` isolates it from user site-packages and `PYTHON*` variables, `-B` keeps
 * bytecode caches out of the install, `-X utf8` makes the text protocol
 * encoding-independent.
 *
 * A timeout or a crash kills the process rather than leaving a half-read stream:
 * a Python thread cannot be interrupted reliably, so the process is the only
 * boundary that actually holds.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export interface EmotionWorkerOptions {
  pythonExecutable: string
  scriptPath: string
  /** Extra environment for the child; credentials are never inherited. */
  env?: Record<string, string>
  readyTimeoutMs?: number
  callTimeoutMs?: number
  /** Test seam: observe the argv without spawning. */
  spawn?: (argv: string[]) => void
}

export interface Handshake {
  ready: boolean
  face: string
  missing: string[]
  python?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_READY_TIMEOUT = 60000
const DEFAULT_CALL_TIMEOUT = 300000

export class EmotionWorker {
  private readonly options: EmotionWorkerOptions
  private child?: ReturnType<typeof nodeSpawn>
  private reader?: Interface
  private pending = new Map<string, Pending>()
  private counter = 0
  private ready?: Handshake
  private dead = false

  constructor(options: EmotionWorkerOptions) {
    this.options = options
  }

  /** Whether the process is still usable; false after a timeout, crash or disposal. */
  get alive(): boolean {
    return !this.dead && this.child !== undefined && this.child.exitCode === null
  }

  /**
   * Start the process and wait for its handshake.
   * @returns The handshake, including any dependency the worker could not import.
   * @throws When the process dies or does not hand shake within `readyTimeoutMs`.
   */
  async start(): Promise<Handshake> {
    if (this.ready !== undefined) return this.ready
    const { pythonExecutable, scriptPath } = this.options
    const argv = [pythonExecutable, '-I', '-B', '-X', 'utf8', scriptPath]
    this.options.spawn?.(argv)
    // Only what a Windows process needs to start; no credentials, no proxy, no
    // inherited secrets. A model process has no business reading the environment.
    const env: NodeJS.ProcessEnv = { ...this.options.env }
    for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMROOT', 'PATH', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    const child = nodeSpawn(argv[0]!, argv.slice(1),
      { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.once('exit', () => { this.failAll(new Error('worker exited')) })
    child.once('error', () => { this.failAll(new Error('worker failed to start')) })
    child.stderr?.on('data', () => { /* diagnostics never enter the JSON channel */ })
    this.reader = createInterface({ input: child.stdout! })
    this.reader.on('line', (line) => { this.onLine(line) })

    const handshake = new Promise<Handshake>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill()
        reject(new Error('worker handshake timeout'))
      }, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT)
      this.pending.set('__handshake__', {
        resolve: (value) => { clearTimeout(timer); resolve(value as Handshake) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
    })
    this.ready = await handshake
    return this.ready
  }

  /**
   * Send one request and await its answer.
   * @param method - Worker method name.
   * @param params - Method parameters.
   * @returns The worker's result.
   * @throws When the worker reports an error, dies, or exceeds `callTimeoutMs`.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) throw new Error('worker is not running')
    this.counter += 1
    const id = `c${this.counter}`
    const timeout = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.kill()
        reject(new Error(`worker call "${method}" timed out after ${timeout} ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Kill the process and reject everything still waiting. */
  async dispose(): Promise<void> {
    this.kill()
    this.failAll(new Error('worker disposed'))
  }

  private onLine(line: string): void {
    let parsed: { id?: string; status?: string; result?: unknown
      error?: { code?: string; message?: string } }
    try { parsed = JSON.parse(line) as typeof parsed }
    catch { return /* a non-JSON line is the child's bug, not a protocol message */ }
    const id = parsed.id
    if (id === undefined) return
    const waiter = this.pending.get(id)
    if (waiter === undefined) return
    this.pending.delete(id)
    clearTimeout(waiter.timer)
    if (parsed.status === 'ok') waiter.resolve(parsed.result)
    else waiter.reject(new Error(`${parsed.error?.code ?? 'WORKER_ERROR'}: ${parsed.error?.message ?? ''}`))
  }

  private kill(): void {
    this.dead = true
    this.reader?.close()
    try { this.child?.kill('SIGKILL') } catch { /* already gone */ }
  }

  private failAll(error: Error): void {
    this.dead = true
    for (const [, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.pending.clear()
  }
}
```

Create `packages/perception/perception-bgm/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-perception-bgm",
  "description": "BGM emotion analysis and valence/arousal matching for the DeepSeek Harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts", "python"],
  "license": "MIT",
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^" },
  "dependencies": {
    "@deepseek-ai/dsh-home-paths": "workspace:^",
    "@deepseek-ai/dsh-perception-ffmpeg": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  }
}
```

Create `packages/perception/perception-bgm/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../core/tools" },
    { "path": "../../util/home-paths" },
    { "path": "../perception-ffmpeg" }
  ]
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm install --prefer-offline` 然后 `npx vitest run packages/perception/perception-bgm/tests/worker.spec.ts`
Expected: PASS（4 个用例）

> 测试用 `pythonExecutable: 'python'`，走 PATH 上的 3.14——这里只验证协议，不加载模型，所以解释器版本无关。真实推理用 3.11 环境，见 Task 3 Step 3。

- [ ] **Step 5: 提交**

```bash
git add packages/perception/perception-bgm
git commit -m "feat(perception-bgm): add resident python worker with NDJSON protocol"
```

### Task 5: Cordis 插件与 `bgm_match` 工具

**Files:**
- Create: `packages/perception/perception-bgm/src/config.ts`
- Create: `packages/perception/perception-bgm/src/index.ts`
- Create: `packages/perception/perception-bgm/tests/tools.spec.ts`

- [ ] **Step 1: 写配置解析**

Create `packages/perception/perception-bgm/src/config.ts`:

```ts
/**
 * Where the interpreter and the weights come from.
 *
 * The interpreter is deployment configuration, never a model parameter: a model
 * must not be able to point this plugin at an arbitrary executable. Order is
 * explicit configuration, then the environment variable, then the running
 * interpreter as a last resort.
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export interface BgmConfig {
  pythonExecutable?: string
  /** Directory holding the vendored `tag_list.npy` and `btc_model_large_voca.pt`. */
  dataDir?: string
  /** The Music2Emo emotion head checkpoint. */
  weightsPath?: string
  /** HuggingFace revision to pin MERT to; never `main` in a shipped deployment. */
  mertRevision?: string
  callTimeoutMs?: number
}

export const PYTHON_ENV_VAR = 'DSH_PERCEPTION_PYTHON'
export const WEIGHTS_ENV_VAR = 'DSH_PERCEPTION_BGM_WEIGHTS'

/**
 * Resolve the interpreter path.
 * @param configured - Value stated in plugin configuration.
 * @returns An absolute path, or an empty string when nothing usable is stated.
 */
export function resolvePython(configured: string | undefined): string {
  const candidate = configured ?? process.env[PYTHON_ENV_VAR]
  if (candidate === undefined || !candidate.trim()) return ''
  return isAbsolute(candidate) && existsSync(candidate) ? candidate : ''
}

/**
 * Resolve the emotion-head checkpoint path.
 * @param configured - Value stated in plugin configuration.
 * @returns The path, falling back to the plugin data directory.
 */
export function resolveWeights(configured: string | undefined): string {
  const candidate = configured ?? process.env[WEIGHTS_ENV_VAR]
  if (candidate !== undefined && isAbsolute(candidate) && existsSync(candidate)) return candidate
  return dshHomePath('perception', 'bgm', 'J_all.ckpt')
}
```

- [ ] **Step 2: 写工具注册测试**

Create `packages/perception/perception-bgm/tests/tools.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/index.ts'

async function mount(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const registered: { name: string; description: string }[] = []
  ctx.provide('tools', { register: (definition: { name: string; description: string }) => {
    registered.push({ name: definition.name, description: definition.description })
    return () => {}
  } })
  await ctx.plugin({ apply, inject, name: 'perception-bgm' }, config)
  return registered
}

describe('bgm tool registration', () => {
  it('registers exactly one tool', async () => {
    const registered = await mount()
    expect(registered.map(entry => entry.name)).toEqual(['bgm_match'])
  })

  it('states the non-commercial restriction in the description the model reads', async () => {
    const registered = await mount()
    expect(registered[0]!.description).toContain('非商业')
  })

  it('says the result is candidates, not a decision', async () => {
    const registered = await mount()
    expect(registered[0]!.description).toContain('候选')
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run packages/perception/perception-bgm/tests/tools.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/index.ts"`

- [ ] **Step 4: 写插件**

Create `packages/perception/perception-bgm/src/index.ts`:

```ts
/**
 * BGM matching: rank the library by emotional distance to a target, and report
 * what each track actually measures.
 *
 * The description a model reads is the whole interface, so two facts live in it
 * rather than in the code: the underlying backbone is **non-commercial**, and the
 * result is a ranked list of candidates, never a decision. The second matters
 * because an agent that reads "matched" will stop thinking; an agent that reads
 * "candidates with measured valence/arousal" still has to choose.
 *
 * Ranking is by valence/arousal distance. A 57-track × 15-query evaluation put
 * that at 15/15 while the best text-embedding variant scored 14/15 and every
 * text variant's similarities sat in a 0.33–0.62 band — too narrow to order on.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EmotionWorker } from './worker.ts'
import type { Handshake } from './worker.ts'
import { resolvePython, resolveWeights } from './config.ts'
import type { BgmConfig } from './config.ts'
import { fileURLToPath } from 'node:url'

export const name = 'perception-bgm'
export const inject = ['tools']

const SCRIPT = fileURLToPath(new URL('../python/worker_main.py', import.meta.url))
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'])

/** One analysed track. */
interface TrackEmotion {
  path: string
  sha256: string
  valence: number
  arousal: number
  moods: string[]
}

/** Rank tracks by distance to a target point; the scale is the model's own 1–9. */
function rank(tracks: TrackEmotion[], target: { valence: number; arousal: number }, limit: number): unknown[] {
  return tracks
    .map(track => ({ track,
      distance: Math.abs(track.valence - target.valence) + Math.abs(track.arousal - target.arousal) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
    .map(({ track, distance }) => ({ path: track.path, sha256: track.sha256,
      valence: Number(track.valence.toFixed(2)), arousal: Number(track.arousal.toFixed(2)),
      moods: track.moods, distance: Number(distance.toFixed(2)) }))
}

async function listAudio(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listAudio(full))
    else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full)
  }
  return files.sort()
}

export function apply(ctx: Context, config: BgmConfig = {}): void {
  const python = resolvePython(config.pythonExecutable)
  const weights = resolveWeights(config.weightsPath)
  const dataDir = config.dataDir ?? fileURLToPath(new URL('../python/data', import.meta.url))
  let worker: EmotionWorker | undefined
  let handshake: Promise<Handshake> | undefined

  const ensureWorker = async (): Promise<EmotionWorker> => {
    if (python === '') throw new Error('perception-bgm: no usable Python interpreter is configured')
    if (worker?.alive !== true) {
      worker = new EmotionWorker({ pythonExecutable: python, scriptPath: SCRIPT,
        ...(config.callTimeoutMs === undefined ? {} : { callTimeoutMs: config.callTimeoutMs }) })
      handshake = worker.start()
    }
    const ready = await handshake!
    if (!ready.ready) throw new Error(`perception-bgm: worker is missing dependencies: ${ready.missing.join(', ')}`)
    return worker
  }

  ctx.effect(() => () => { void worker?.dispose() }, 'perception-bgm: worker')

  ctx.tools.register(defineTool({
    name: 'bgm_match',
    description: '在本地 BGM 库里按情绪选曲。'
      + 'match：给出目标「愉悦度」与「能量」（都用 1–9 的刻度），返回最接近的候选及其实际测量值。'
      + 'index：扫描一个目录，逐首分析情绪并入库（耗时约 30 秒/首，可续跑）。'
      + 'inspect：只分析一首。'
      + '**返回的是候选排序，不是决定**——每首附带 valence/arousal 原值与情绪标签，最终选哪首由你判断。'
      + '**注意：底层骨干 m-a-p/MERT-v1-95M 是 CC-BY-NC-4.0 许可，仅限非商业用途。**',
    parameters: {
      method: { type: 'string', required: true, enum: ['match', 'index', 'inspect'],
        description: 'match=按坐标排序；index=扫描目录建库；inspect=分析单首。' },
      directory: { type: 'string', description: 'index 必填：要扫描的音乐目录（绝对路径或工作区相对路径）。' },
      audio_path: { type: 'string', description: 'inspect 必填：单个音频文件路径。' },
      index_path: { type: 'string', description: 'match/index 使用的索引文件路径；省略则用插件数据目录下的 bgm-index.json。' },
      valence: { type: 'number', description: 'match 必填：目标愉悦度，1–9（1=最消极，9=最积极）。' },
      arousal: { type: 'number', description: 'match 必填：目标能量，1–9（1=最平静，9=最激烈）。' },
      limit: { type: 'number', description: 'match 可选：返回候选数，默认 5，上限 20。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30 * 60 * 1000,
    async execute(args: {
      method: string
      directory?: string
      audio_path?: string
      index_path?: string
      valence?: number
      arousal?: number
      limit?: number
    }): Promise<Record<string, unknown>> {
      const indexPath = args.index_path ?? join(dataDir, '..', 'bgm-index.json')
      if (args.method === 'inspect') {
        if (args.audio_path === undefined) throw new Error('inspect requires audio_path')
        const active = await ensureWorker()
        return { track: await active.call('analyse', { audio_path: args.audio_path,
          weights_path: weights, model_dir: dataDir }) } as Record<string, unknown>
      }
      if (args.method === 'index') {
        if (args.directory === undefined) throw new Error('index requires directory')
        const active = await ensureWorker()
        const files = await listAudio(args.directory)
        const existing = await loadIndex(indexPath)
        const tracks: TrackEmotion[] = [...existing]
        const failures: { path: string; error: string }[] = []
        for (const file of files) {
          const info = await stat(file)
          const sha256 = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`
          const known = tracks.find(track => track.path === file)
          if (known?.sha256 === sha256) continue
          try {
            const result = await active.call('analyse', { audio_path: file, weights_path: weights,
              model_dir: dataDir, source_sha256: sha256 }) as {
              valence: number, arousal: number, moods: string[] }
            const next: TrackEmotion = { path: file, sha256, valence: result.valence,
              arousal: result.arousal, moods: result.moods }
            const at = tracks.findIndex(track => track.path === file)
            if (at >= 0) tracks[at] = next
            else tracks.push(next)
          } catch (error) {
            // One unreadable track must not end the run: it is recorded and skipped.
            failures.push({ path: file, error: error instanceof Error ? error.message : String(error) })
          }
          await saveIndex(indexPath, tracks)
        }
        await saveIndex(indexPath, tracks)
        return { indexed: tracks.length, scanned: files.length, failures, index_path: indexPath }
      }
      if (args.method === 'match') {
        if (typeof args.valence !== 'number' || typeof args.arousal !== 'number') {
          throw new Error('match requires numeric valence and arousal on the model 1–9 scale')
        }
        const tracks = await loadIndex(indexPath)
        if (tracks.length === 0) throw new Error(`no indexed tracks at ${indexPath}; run index first`)
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
        return { target: { valence: args.valence, arousal: args.arousal },
          candidates: rank(tracks, { valence: args.valence, arousal: args.arousal }, limit),
          index_path: indexPath, evaluated_tracks: tracks.length }
      }
      throw new Error(`unknown method ${args.method}`)
    },
  }))
}

async function loadIndex(path: string): Promise<TrackEmotion[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(parsed) ? parsed as TrackEmotion[] : []
  } catch { return [] }
}

async function saveIndex(path: string, tracks: TrackEmotion[]): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, JSON.stringify(tracks, null, 2), 'utf8')
}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run packages/perception/perception-bgm/tests/` 然后 `npx tsc -b packages/perception/perception-bgm`
Expected: 全部 PASS，tsc exit 0

- [ ] **Step 6: 提交**

```bash
git add packages/perception/perception-bgm
git commit -m "feat(perception-bgm): register the bgm_match tool"
```

### Task 6: 端到端验证 `bgm_match`（真实模型）

- [ ] **Step 1: 用真实环境索引 6 首，确认可续跑**

配置 `pythonExecutable` 指向 `E:\aa-manju\M2E-verify\.venv\Scripts\python.exe`，`weightsPath` 指向上游 `saved_models\J_all.ckpt`，对 `bgm/` 建索引。**中途中断一次再重跑**，确认已完成的曲目不被重算（按 sha256 跳过）。

Expected: 第二次运行明显更快，`indexed` 数量不重复增长。

- [ ] **Step 2: 已知答案的排序检查**

用全库实测里已知的极端曲子验证：
- `match(valence=3.2, arousal=2.6)` 的 top1 应是 `悲伤剧情氛围.mp3` 一类低 valence 低 arousal 的曲子。
- `match(valence=7.0, arousal=6.2)` 的 top1 应是 `振奋的流行放克旋律.mp3` 或 `groovy Hammond.mp3`。

若不满足，**报告实际结果**，不要调整阈值去凑答案。

- [ ] **Step 3: 崩溃用例回归**

对 `危险降临.mp3`（已知让上游崩溃的那首）跑 `inspect`。

Expected: `status ok`，且 `dropped_trailing_samples` 接近 2915。**这是本计划最重要的一个验收点。**

- [ ] **Step 4: 提交验证脚本**

```bash
git add packages/perception/perception-bgm/tests/
git commit -m "test(perception-bgm): add end-to-end checks against the real model"
```

---

## Phase 4 — `perception-subs`

### Task 7: 抽帧与扫描

**Files:**
- Create: `packages/perception/perception-subs/package.json`
- Create: `packages/perception/perception-subs/tsconfig.json`
- Create: `packages/perception/perception-subs/src/frames.ts`
- Create: `packages/perception/perception-subs/src/index.ts`
- Create: `packages/perception/perception-subs/tests/frames.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/perception/perception-subs/tests/frames.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildFrameArgs, buildProbeArgs } from '../src/frames.ts'

describe('buildProbeArgs', () => {
  it('asks ffprobe for machine-readable stream and format facts', () => {
    const args = buildProbeArgs('E:/video.mp4')
    expect(args[0]).toBe('-v')
    expect(args).toContain('-print_format')
    expect(args[args.length - 1]).toBe('E:/video.mp4')
  })
})

describe('buildFrameArgs', () => {
  it('extracts exactly one frame at a requested time, with no audio', () => {
    const args = buildFrameArgs({ source: 'E:/v.mp4', atSeconds: 12.5, output: 'E:/f.png' })
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('12.5')
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args).toContain('-an')
    expect(args).toContain('-y')
  })

  it('scales down so a frame stays cheap to send to a vision model', () => {
    const args = buildFrameArgs({ source: 'E:/v.mp4', atSeconds: 0, output: 'E:/f.png', maxWidth: 1280 })
    expect(args.join(' ')).toContain('scale=1280:-2')
  })

  it('omits the scale filter when no bound is requested', () => {
    const args = buildFrameArgs({ source: 'E:/v.mp4', atSeconds: 0, output: 'E:/f.png' })
    expect(args.join(' ')).not.toContain('scale=')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/perception/perception-subs/tests/frames.spec.ts`
Expected: FAIL — 无法解析 `../src/frames.ts`

- [ ] **Step 3: 写实现**

Create `packages/perception/perception-subs/src/frames.ts`:

```ts
/**
 * FFmpeg argument construction for frame extraction.
 *
 * Shapes mirror the product's existing decoder calls
 * (`muse-product/src/media-worker.ts:305,399,410`) because those are proven
 * against real provider output: one frame at an exact timestamp, no audio, and a
 * variant-frame-rate mode so the requested time is honoured rather than snapped
 * to the nearest keyframe.
 */

/**
 * Build the ffprobe invocation that reports stream and container facts.
 * @param source - Media path.
 * @returns Arguments after the executable.
 */
export function buildProbeArgs(source: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source]
}

export interface FrameArgsInput {
  source: string
  atSeconds: number
  output: string
  /** Downscale bound; a full-size frame wastes vision tokens for no added certainty. */
  maxWidth?: number
}

/**
 * Build the ffmpeg invocation that writes exactly one frame.
 * @param input - Source, timestamp, output path and optional width bound.
 * @returns Arguments after the executable.
 */
export function buildFrameArgs(input: FrameArgsInput): string[] {
  const args = ['-y', '-ss', String(input.atSeconds), '-i', input.source]
  if (input.maxWidth !== undefined) args.push('-vf', `scale=${input.maxWidth}:-2`)
  args.push('-frames:v', '1', '-an', '-fps_mode', 'vfr', input.output)
  return args
}
```

Create `packages/perception/perception-subs/src/exec.ts` — **不用 `ctx.shell`**：

```ts
/**
 * Run one executable with an exact argv.
 *
 * Deliberately NOT `ctx.shell`: that seam takes a command *string*
 * (`ShellExecRequest.command`, `packages/shell/shell/src/types.ts:38-39`), so an
 * argument array would have to be re-quoted into shell syntax and parsed back —
 * on Windows, for paths full of spaces and CJK characters, for a binary we did
 * not write. The product's own decoder takes the direct route for the same
 * reason: `spawn(executable, args, { shell: false, windowsHide: true })`
 * (`muse-product/src/media-worker.ts:233`). Passing argv directly means there is
 * no escaping step to get wrong.
 *
 * The trade-off is real and accepted: a directly spawned ffmpeg is not confined
 * by the shell executor's sandbox. Both executables are deployment-configured
 * absolute paths, never model-supplied.
 */
import { spawn } from 'node:child_process'

export interface RunResult { stdout: string; exitCode: number | null }

/**
 * @param executable - Absolute path to the executable.
 * @param args - Exact arguments; never interpreted by a shell.
 * @param options - Timeout and output bound.
 * @returns Captured stdout and the exit code.
 * @throws When the process cannot start or exceeds the bound.
 */
export async function runExecutable(executable: string, args: string[],
  options: { timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal } = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120000
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let failure: string | undefined
    const stop = (reason: string): void => { failure ??= reason; child.kill('SIGKILL') }
    const timer = setTimeout(() => { stop('TIMEOUT') }, timeoutMs)
    const abort = (): void => { stop('ABORTED') }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', () => { failure ??= 'START_FAILED' })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) stop('OUTPUT_LIMIT')
      else if (failure === undefined) chunks.push(chunk)
    })
    child.stderr.on('data', () => { /* diagnostics stay out of the parsed stream */ })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure !== undefined || code !== 0) {
        reject(new Error(`${failure ?? 'EXIT_FAILED'}: ${executable}`))
        return
      }
      resolve({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), exitCode: code })
    })
  })
}
```

Create `packages/perception/perception-subs/src/index.ts`:

```ts
/**
 * Subtitle scanning: produce frames and the times worth looking at.
 *
 * This tool deliberately does NOT decide whether a frame contains a subtitle.
 * Reading text off a frame is a judgment the caller's vision model already makes
 * well, and it distinguishes burned-in dialogue from a prop's on-screen text —
 * something OCR cannot do. What the plugin contributes is the cheap part: pick
 * sensible sampling times and hand back frame paths, so the model looks at tens of
 * frames instead of thousands.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildFrameArgs, buildProbeArgs } from './frames.ts'
import { runExecutable } from './exec.ts'

export const name = 'perception-subs'
export const inject = ['tools']

export interface SubsConfig {
  ffmpegExecutable: string
  ffprobeExecutable: string
  /** Upper bound on frames one scan may extract. */
  maxFrames?: number
  maxWidth?: number
}

const DEFAULT_MAX_FRAMES = 40
const DEFAULT_MAX_WIDTH = 1280

export function apply(ctx: Context, config: SubsConfig): void {
  const maxFrames = config.maxFrames ?? DEFAULT_MAX_FRAMES
  const maxWidth = config.maxWidth ?? DEFAULT_MAX_WIDTH

  ctx.tools.register(defineTool({
    name: 'subtitle_scan',
    description: '为检查字幕而抽帧：probe 读视频信息，frames 按时间点导出图片，scan 按时间均匀抽样并返回帧路径。'
      + '**本工具不判断画面里是不是字幕**——请把返回的帧交给视觉模型看，由它区分「画面叠加的台词字幕」与「道具上的文字」，'
      + '后者不该去掉。抽帧数有上限。',
    parameters: {
      method: { type: 'string', required: true, enum: ['probe', 'frames', 'scan'],
        description: 'probe=读时长/分辨率/帧率/有无音轨；frames=按给定时间点抽帧；scan=按时间均匀抽样。' },
      video_path: { type: 'string', required: true, description: '视频文件路径。' },
      times_seconds: { type: 'array', description: 'frames 必填：要抽帧的时间点（秒）。' },
      output_dir: { type: 'string', description: '抽帧输出目录；省略则用工作区下的 .perception/frames。' },
      max_frames: { type: 'number', description: 'scan 可选：最多抽多少帧，默认 40。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 10 * 60 * 1000,
    async execute(args: { method: string, video_path: string, times_seconds?: number[]
      output_dir?: string, max_frames?: number }, exec): Promise<Record<string, unknown>> {
      if (args.method === 'probe') {
        const raw = await runExecutable(config.ffprobeExecutable, buildProbeArgs(args.video_path),
          { signal: exec.signal })
        const parsed = JSON.parse(raw.stdout) as { streams?: Record<string, unknown>[],
          format?: Record<string, unknown> }
        const video = (parsed.streams ?? []).find(stream => stream.codec_type === 'video')
        const audio = (parsed.streams ?? []).find(stream => stream.codec_type === 'audio')
        return { duration_seconds: Number(parsed.format?.duration ?? 0),
          width: video?.width ?? null, height: video?.height ?? null,
          frame_rate: video?.r_frame_rate ?? null, has_audio: audio !== undefined }
      }
      if (args.method === 'frames' || args.method === 'scan') {
        let times = args.times_seconds ?? []
        if (args.method === 'scan') {
          const probe = JSON.parse((await runExecutable(config.ffprobeExecutable,
            buildProbeArgs(args.video_path), { signal: exec.signal })).stdout) as
            { format?: Record<string, unknown> }
          const duration = Number(probe.format?.duration ?? 0)
          const count = Math.min(Math.max(args.max_frames ?? maxFrames, 1), maxFrames)
          times = Array.from({ length: count }, (_, index) =>
            Number(((duration * (index + 0.5)) / count).toFixed(3)))
        }
        if (times.length === 0) throw new Error('no frame times were requested')
        if (times.length > maxFrames) throw new Error(`at most ${maxFrames} frames per call`)
        const directory = args.output_dir ?? join(process.cwd(), '.perception', 'frames')
        await mkdir(directory, { recursive: true })
        const frames: { at_seconds: number, path: string }[] = []
        for (const at of times) {
          const output = join(directory, `frame_${String(Math.round(at * 1000)).padStart(9, '0')}.png`)
          await runExecutable(config.ffmpegExecutable,
            buildFrameArgs({ source: args.video_path, atSeconds: at, output, maxWidth }),
            { signal: exec.signal })
          frames.push({ at_seconds: at, path: output })
        }
        return { frames, count: frames.length,
          note: '把这些帧交给视觉模型判断是否为叠加字幕；道具上的文字不应去掉。' }
      }
      throw new Error(`unknown method ${args.method}`)
    },
  }))
}
```

Create `packages/perception/perception-subs/package.json` 与 `tsconfig.json`，与 `perception-bgm` 同形，名字改为 `@deepseek-ai/dsh-perception-subs`，依赖改为 `@deepseek-ai/dsh-perception-ffmpeg` 与 `@deepseek-ai/dsh-tools`，references 加 `../perception-ffmpeg`。

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm install --prefer-offline` 然后 `npx vitest run packages/perception/perception-subs/tests/` 然后 `npx tsc -b packages/perception/perception-subs`
Expected: PASS 与 exit 0

- [ ] **Step 5: 全量回归**

Run: `npx vitest run packages/perception/` 然后 `npx tsc -b tsconfig.host.json`
Expected: 全绿。**若 `tsc -b tsconfig.host.json` 报找不到项目，检查三个包的 references 是否都登记了。**

- [ ] **Step 6: 确认没有触碰 MUSE**

Run: `git status --porcelain packages/bundle/muse-product`
Expected: 空输出

- [ ] **Step 7: 提交**

```bash
git add packages/perception tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(perception-subs): add subtitle frame scanning tool"
```

---

## 验收标准

1. `npx vitest run packages/perception/` 全绿。
2. `npx tsc -b tsconfig.host.json` exit 0。
3. **`危险降临.mp3` 能被 `bgm_match(method="inspect")` 成功分析**，`dropped_trailing_samples` 接近 2915——这是规避上游崩溃的直接证据。
4. `bgm_match(method="match")` 对已知极端的坐标返回语义正确的 top1（Task 6 Step 2）。
5. `git status --porcelain packages/bundle/muse-product` 为空。
6. `bgm_match` 的 description 里含"非商业"与"候选"两处字样——模型读到的是描述，不是源码。

## 已知未完成项（不在本轮）

1. **`perception_setup` 未实现。** 本轮靠一个已建好的 Python 3.11 环境跑通。准备流程（独立环境、依赖安装、MERT 下载与校验、断点续传、进度、失败分类）是独立一轮。
2. **模型权重未随包分发。** `J_all.ckpt`（12.4 MB）本轮从上游目录读取；分发时要登记来源与 sha256（`PROVENANCE.md` 已留位）。
3. **`mertRevision` 未真正钉住。** vendored `mert.py` 里 `from_pretrained` 仍取默认 revision；Task 3 的 `analyse` 收下 `revision` 参数但未透传给它。**分发前必须修**——`trust_remote_code=True` 会执行远端代码（spec §4.8）。
4. **字幕的镜头边界抽样未实现。** 现在 `scan` 是均匀抽样；"优先抽镜头边界"需要先有镜头切点，那是另一项（可用 ffmpeg 的 `select='gt(scene,τ)'`）。
5. **索引是全量重读文件算 sha256**，60 首约 210 MB 尚可；库大了要改成按 mtime+size 预筛。
