# 字幕扫描与 BGM 匹配插件设计

- 日期：2026-09-18
- 状态：待评审
- 范围：`packages/perception/*`（新增两个包）。**本轮不改动 `packages/bundle/muse-product`。**

## 1. 范围与取舍

最早的"眼耳四插件"方案（ASR、说话人、声学、口型、OCR、抽帧、BGM）已废弃。经确认，只做两件事：

| 需求 | 归属 | 结论 |
|---|---|---|
| 抽帧看画面 | **ffmpeg** | 是 ffmpeg 就够，产品里已有现成命令 |
| 音频分配 | **ffmpeg** | 是 ffmpeg 就够，产品里已有现成滤镜图 |
| 字幕识别 | **插件** | 抽帧 → 交给视觉模型判断（**不用 OCR**） |
| BGM 匹配 | **插件** | 核心：剧本描述 ↔ 音乐库 |

**砍掉**：ASR 转写、说话人聚类/音色、声学特征、口型同步、跨模态归属检查、独立 OCR。

**砍掉 OCR 的理由（使用者判断，我认同）**：抽帧检查时的要求与编排做好，把帧交给视觉模型就能看到并判断——**视觉模型本来就能读图上的字**。OCR 唯一的增量价值是"先排除没字的帧"以省钱；但代价是引入一个文本检测依赖（Python rapidocr 或 ONNX 模型）与一套坐标几何，不值得。

## 2. ffmpeg：两个能力的共同前置

抽帧与音频分配都不需要插件逻辑，**产品里已有可直接照搬的实现**：

| 能力 | 现成实现 |
|---|---|
| 抽帧（按帧号） | `media-worker.ts:399`：`-vf select=eq(n\,<i>) -fps_mode vfr -frames:v 1 -an` |
| 抽帧（按时长） | `media-worker.ts:305`：`-map 0:v:0 -an -vf …` |
| 精确区域裁剪 | `media-worker.ts:410`：`select=…,format=rgb24,crop=w:h:x:y` |
| 音轨混合（音量/淡入淡出/延迟） | `timeline-render.ts:68-76`：`atrim`+`asetpts`+`aresample`+`aformat`+`volume`+`afade`+`adelay`+`amix` |
| 音频转 16k 单声道（BGM 分析前置） | 新增一行：`-vn -ac 1 -ar 16000 -f wav` |
| 探测 | ffprobe |

**本机 PATH 里 ffmpeg 与 ffprobe 都不存在**（已核实）。所以需要一个解析顺序：**配置 → PATH → 按平台下载静态构建并校验 sha256**。它不是插件（没有工具面），是两个包共同的前置模块。

下载可执行文件是安全敏感动作：必须固定来源、校验 sha256、并向使用者明确报告下载了什么、放在哪里。

## 3. 字幕：抽帧 + 视觉模型，不用 OCR

### 3.1 分工

```
ffmpeg 抽帧  →  交给视觉模型判断每一帧有没有字幕  →  输出时间区间清单
```

视觉模型侧沿用 MUSE 已经验证过的分类法（`video-frame-review.ts:78`）：

```
scene_text | subtitle | watermark | not_text | uncertain
```

- `scene_text`：道具上的字（招牌、信件、手机屏幕）
- `subtitle`：画面叠加的台词字幕
- `uncertain`：**合法且必要**的结论。低分辨率、快速运动、字被遮挡时无法区分，必须如实返回，不许猜。

### 3.2 关键在于编排，不在识别

既然交给视觉模型，质量就取决于**抽帧策略与提问方式**：

1. **抽帧密度可配，且有上限**。全片每秒一帧对一集长视频就是上千次调用，必须有上限与预算控制。
2. **优先在"可能有问题"的区间抽帧**：镜头切换点、有大量文字的场景、以及已知有台词的区间。这依赖镜头脚本的镜头边界，而那是调用方能提供的。
3. **一次调用传多帧**，让模型在同一上下文里比较，避免"单帧看到字就判定是字幕"。
4. **提问要问"这是什么字"而不是"有没有字幕"**。后者会诱导模型把所有文字都报成字幕；前者才能区分道具字与叠加字幕。

### 3.3 工具面

| 工具 | 方法 | 用途 |
|---|---|---|
| `subtitle_scan` | `probe` | 视频基本信息（时长、分辨率、帧率、有无音轨） |
| | `frames` | 抽帧导出图片（路径清单，交给调用方或视觉模型） |
| | `scan` | 按策略抽帧 → 返回**疑似含字幕的时间区间 + 每处证据帧** |

`scan` 的产物是**区间清单与证据**，不是"擦除指令"。要不要对区间发起去字幕（`/aigc/storyboard/subtitleEraser`，**收费**）是调用方的决定，也是剧变插件的职责。

**这里有个刻意的分工**：插件不调用视觉模型，只产出帧与区间。理由是视觉模型的调用属于"判断"，而判断的编排、成本与提示词由调用方（agent 或 MUSE）掌握更合适。若将来要插件内置调用，那是一次独立扩展。

## 4. BGM：Music2Emo 出情感，文本嵌入做匹配

### 4.1 缺的那一环，以及怎么补

使用者的需求是"**按照镜头脚本和抽帧的画面，对应时间线去选中 BGM**"。但 **Music2Emo 输出的是数值与标签，不能直接和文字描述比**：

```
Music2Emo 给：valence=3.2  arousal=6.1  moods=[tense, dark]
剧本给的是：  "压抑但带一点希望的克制感"
```

**这两者之间没有可比性**——标签是离散的，算不出相似度。

补法：**用情感结果生成一段结构化描述，再用多语言文本嵌入做匹配。**

```
音乐  →  Music2Emo  →  valence/arousal + 56 类 mood 标签
                          ↓ 拼成文字
                    "悲伤，平静，低唤醒，慢速，紧张感偏低"
                          ↓ 多语言文本嵌入（一次性，入库）
                    ┌─────────────────────────┐
剧本镜头 → emotion_state 等文字 → 嵌入 →  余弦相似度排序
                    └─────────────────────────┘
                          ↓
                    候选 + 分数 + 命中理由
```

三个好处：

1. **绕开 CLAP 的中文弱点。** 之前担心音频-文本模型对中文描述不敏感；这条路上**匹配发生在纯文本空间**，用中文原生支持的嵌入模型即可。
2. **可解释**：每条候选能说"因为这首偏忧郁、低唤醒，而你要的是压抑"，而不是一个黑盒分数。
3. **Music2Emo 用在它擅长的地方**（音乐→情感），文本嵌入用在它擅长的地方（文字→文字）。

> **但"profile 用哪种语言写"我一开始猜错了。** 我原先认为英文 profile 也能用，理由是嵌入空间是多语言的。§4.7 的实测否掉了它：英文 profile 在最关键的用例上排错，换成中文 profile 才修好。**profile 必须是中文的**，并附显式的程度词。

### 4.2 Music2Emo 的实际构成（已核实，2026-09-18 实测）

| 项 | 事实 | 出处 |
|---|---|---|
| 骨干 | `m-a-p/MERT-v1-95M`，从 HuggingFace 拉取 | `music2emo.py:194` |
| **骨干许可** | **`cc-by-nc-4.0`（非商用）** | HuggingFace model card API 实测 |
| **骨干体积** | `pytorch_model.bin` **377 MB**（仓库总计 1.6 GB，含一个 1.3 GB 的 fairseq 版，transformers 不会下载） | 同上 |
| 骨干加载 | `AutoModel.from_pretrained(..., trust_remote_code=True)` | `utils/mert.py:15` |
| 特征 | MERT 第 5、6 层嵌入拼接 = 768×2 = 1536 维 | `config/base_config.yaml:17-20`、`music2emo.py:494` |
| 训练头 | `FeedforwardModelMTAttnCK`，输入 1536，输出 56 类 + 2 回归 | `music2emo.py:197-201` |
| **情感权重** | `saved_models/J_all.ckpt` **12.4 MB**，仓库自带（另有 D/E/P 各版） | 实测 |
| **和弦识别** | **第二个模型**：`inference/data/btc_model_large_voca.pt` **11.7 MB**，仓库自带 | `music2emo.py:288` |
| 和弦映射 | `inference/data/chord*.json` 等，仓库自带 | 实测 |
| 采样率 | 16 kHz | `config/base_config.yaml:7` |
| 运行依赖 | **torch 2.3.1 + torchaudio + transformers 4.44 + pytorch_lightning 2.4 + librosa 0.10.2 + music21 9.3** | `requirements.txt` |
| 许可 | **MIT**（AMAAI Lab, 2025） | `LICENSE` |
| 论文报告 | MTG-Jamendo PR-AUC 0.1543 / ROC-AUC 0.7810，优于 MERT-330M 与 MediaEval 2021 最优 | `README.md:129-151` |

**实测的环境代价**（本机 Python 3.11.16 + CPU 版 torch，实测磁盘占用）：

| 部分 | 体积 |
|---|---|
| 虚拟环境合计 | **2,750 MB** |
| └ `torch`（CPU 版） | 984 MB |
| └ **`gradio`**（只因 `music2emo.py:31` 的模块级导入） | **207 MB** |
| └ `scipy` 113 / `music21` 91 / `transformers` 85 / `llvmlite` 78 | — |
| HuggingFace 缓存（MERT） | **360 MB** |
| **合计** | **约 3.1 GB** |

三条由此得出的结论：

- 首次准备要下 **约 3.1 GB**（其中 torch 984 MB、MERT 360 MB）。这是"插件负责拉模型"的真实量级，不是几百 MB。
- **`gradio` 一个人占 207 MB**，而它只是因为上游把 demo 界面和推理类写在同一文件里。插件若只取 `predict` 相关代码，能直接省掉这 207 MB 与约 30 个包——**值得做**，见 §7 阶段 2。
- 首次拉取只需 **MERT 一个 360 MB 的权重**；Music2Emo 的情感头与和弦模型都随仓库自带。
- 本机网络实测：`huggingface.co` 可达（约 5.4 s 首字节），**`hf-mirror.com` 不可达**——所以镜像源不能只配一个。
- CPU 版 torch 约 200 MB *下载*（解包后 984 MB 含 CUDA 无关的完整算子库），CUDA 版下载约 2.5 GB。**只用 CPU 时必须显式指定 CPU index**，否则白等十倍。

**因此这个插件必须有 Python。** torch + MERT 无法用 Node ONNX 替代——尤其 `utils/chords.py` 的和弦/调性提取依赖 music21 这类符号音乐库，没有等价 JS 实现。

> 这推翻了本设计早先版本的一条卖点（"完全不需要 Python"）。那条卖点随路线 A 一起废弃。

### 4.3 音乐来源

两条：

1. **工作区目录**：默认扫 `bgm/`（可配置）。实况已核实：**60 个 mp3，合计 209.9 MB，平均 3.5 MB，最大 10.6 MB**。
2. **剧变音频资产**：MUSE 的资产 schema 已有 `kind: 'bgm' | 'sfx' | 'outro_audio'`（`asset-schema.ts:37`）。插件**只读取**本地文件路径，不负责从远端下载（那是剧变插件的职责）。

### 4.4 两层评分，第一层接近零成本

`bgm/` 里的文件名本身就是描述：

```
悲伤剧情氛围.mp3   悬疑剧情紧张氛围.mp3   紧张打斗 战争 史诗 绝处逢生.mp3
温柔钢琴舒缓叙事.mp3  喜剧幽默搞笑古风.mp3   大气震撼史诗宣传.mp3
```

所以：

1. **文件名关键词层**：零成本、可解释、可离线。
2. **情感描述层**：Music2Emo → 描述文字 → 嵌入 → 与剧本描述比对。

**每条候选必须标明命中来源**，因为文件名是人工起的，可能名不副实（英文名的那些尤其可疑：`awake`、`over tum`、`vroken`）。没有来源标注，使用者无法判断该不该信。

### 4.5 工具面（只给候选）

| 工具 | 方法 | 用途 |
|---|---|---|
| `bgm_match` | `index` | 扫描音乐库 → Music2Emo 情感 → 描述 → 嵌入 → 落索引（增量，按 sha256） |
| | `match` | 输入描述（+ 可选时间区间、top-k）→ 返回候选排序与分数 |
| | `inspect` | 读某首音乐的情感结果（valence/arousal、mood 标签、特征摘要） |

**只返回候选排序，不返回"选中结果"**（已确认）。理由与 §3 一致：插件给观测，判断留给 agent 或人。

产物形如：

```json
{ "query": "压抑但带一点希望的克制感",
  "candidates": [
    { "path": "bgm/暗流涌动.mp3", "sha256": "sha256:…", "score": 0.71,
      "matched_by": ["emotion_text", "filename_keyword"],
      "emotion": { "valence": 3.1, "arousal": 4.4, "moods": ["dark", "calm"] },
      "filename_tokens": ["暗流", "涌动"] }
  ] }
```

**索引必须绑定内容哈希**：文件会被替换或改名，索引项记录 `sha256`，变了即失效重算，否则会推荐一个已经不存在的声音。

### 4.6 实测结果（2026-09-18，本机 CPU，Python 3.11.16）

用 `bgm/` 里四首真实音乐跑通全链路，原始产物在 `E:\aa-manju\M2E-verify\verify-report.json`。

**性能（CPU，无 GPU）**

| 项 | 实测 |
|---|---|
| `import music2emo` | 9.4 s（含 gradio 等模块级导入） |
| 构造 `Music2emo`（含 MERT 下载 360 MB） | 15.7 s |
| 单首推理 | 21.1 / 33.5 / 38.1 / 65.2 s |
| **折算吞吐** | **约 15–21 s CPU 时间 / 每分钟音频** |
| 落到 `bgm/` 全库 | 60 个文件、209.9 MB；**首次索引预计 45–65 分钟 CPU 时间** |

索引是**一次性、可缓存的**成本，可以接受，但**必须后台可续、有进度**，不能同步阻塞一次工具调用。

**情感输出与文件名的对照**——这是本次实测最有价值的一段：

| 文件 | valence | arousal | 模型给的主要 tag | 是否对得上 |
|---|---|---|---|---|
| `悲伤剧情氛围.mp3` | **3.99** | **2.27** | melancholic, sad, calm, relaxing, soft | ✅ 完全对上，且是全组最低 valence + 最低 arousal |
| `紧张打斗 战争 史诗 绝处逢生.mp3` | 4.63 | **5.19** | epic, dramatic, powerful, action, trailer | ✅ 对上，全组最高 arousal |
| `温柔钢琴舒缓叙事.mp3` | 5.48 | 3.27 | calm, relaxing, soft, dream, romantic | ✅ 对上，最高 valence |
| `vroken.mp3` | 4.89 | 4.38 | corporate, motivational, groovy, uplifting | ⚠️ 名字无信息，输出也无明确指向 |

**三个由实测得出、并改变设计的结论**：

1. **valence/arousal 是强信号，mood 标签是弱信号。** 模型把 `悲伤剧情氛围` 判成"低 valence + 低 arousal"、把 `紧张打斗` 判成"全组最高 arousal"，这个二维排序**又准又可解释**。但 mood 标签在阈值 0.5 下一次吐出 14–19 个，语义互相矛盾（同一首里既有 `sad` 又有 `happy`），且大量是 `commercial` / `advertising` / `background` / `documentary` 这类 **MTG-Jamendo 语料的功能性标签，对短剧选曲没有意义**。
   → **匹配主力应是 valence/arousal 两个数；mood 标签只作辅助文字，且应过滤掉功能性标签。**

2. **情感描述的文字必须是中文——这一条先猜错、后被实测修正。** 我原先判断"标签是英文的也无妨，多语言模型能把英文和中文放进同一空间"。§4.7 的实测证明在这个任务上不可靠：英文 profile 把最关键的中文查询排错，换中文 profile 才修好。**结论：用固定的标签→中文映射表（可审）生成中文 profile，并写出显式的程度词。**

3. **`vroken` 那一行是"文件名层不可信"的实证。** 英文名的那首，名字不给信息，模型给的又是一组泛化标签。这正是 §4.4 要求 `matched_by` 标明命中来源的现实理由。

**一个安全发现**：加载时 transformers 主动打印

> `A new version of the following files was downloaded from ...: modeling_MERT.py. Make sure to double-check they do not contain any added malicious code. To avoid downloading new versions of the code file, you can pin a revision.`

这说明 `trust_remote_code=True` 是**真的在执行从 HuggingFace 下载的 Python 代码**，且默认跟随最新版。插件必须**钉住 revision**，否则每次加载都可能执行不同的远端代码。

### 4.7 匹配层的实测：一个被更大样本推翻的结论

> **本节的第一版结论是错的，已在 §4.9 用全库 60 首推翻。** 保留在此是为了记住它错在哪：4 首样本、3 条查询得出的"中文 profile 最好"在 57 首、15 条查询上**成了最差的一种**。教训写在 §4.9.3。

§4.6 只证明了情感预测准。**匹配那一步单独做了实验**，因为它可能整条不成立。

做法：拿 §4.6 的真实输出（不是编的样本），对三个中文剧本式查询排序，比较四种 profile 写法。产物：`E:\aa-manju\M2E-verify\match-variants-report.json`。

| 变体 | profile 写法 | 命中 |
|---|---|---|
| A（基线） | 全部 mood 标签，**英文** | 2/3 |
| B | 过滤到情绪词，**英文** | 2/3（与 A 逐位相同） |
| C | 过滤到情绪词，**中文**，并写出"愉悦度低/能量低" | 3/3 |
| D | 纯 valence/arousal 数值（不用文本） | 3/3，差值极大 |

**基线在最关键的用例上失败**：

```
query: 悲伤、压抑，想哭的一场告别
  A/B:  0.516  温柔钢琴舒缓叙事.mp3   ← 错的
        0.502  悲伤剧情氛围.mp3        差值仅 0.014
```

**换成中文 profile（变体 C）后同一个用例**：

```
  C:    0.599  悲伤剧情氛围.mp3      ✅
        0.525  温柔钢琴舒缓叙事.mp3   差值 0.074（是原差距的 5 倍）
```

**一个必须如实记录的细节**：变体 A 与 B 逐位相同，因为 `EMOTION_WORDS` 过滤集里包含了这几首的全部标签，**过滤对它们什么都没滤掉**。所以真正的修复因素是**中文表述 + 显式的"愉悦度/能量"程度词**，不是过滤。过滤是否有效，本次实验**没有测到**，不能据此宣称。

**当时的结论（已被 §4.9 推翻）**：情绪 profile 必须用中文写。

> 这一节的失败与修复都来自实测，不是设计推演。但它只用了 4 首样本，样本量不足以支撑一个"必须"级别的结论——这正是 §4.9 要纠正的。

### 4.8 全库 60 首实测：发现并定位了上游的一个真 bug

§4.6/§4.7 只用了 4 首样本。这一轮把 **`bgm/` 全库 60 首**跑完（33.1 分钟 CPU），结果如下。原始数据：`E:\aa-manju\M2E-verify\library-emotions.ndjson`。

**通过率：57/60（95%），3 首崩溃。**

| 项 | 实测 |
|---|---|
| 成功 | 57 |
| 崩溃 | 3（`危险降临.mp3`、`悬疑推理迷离.mp3`、`悲壮交响哀曲.mp3`） |
| 崩溃异常 | `IndexError: too many indices for tensor of dimension 2` |
| valence 分布 | 3.53 – 7.18（中位 5.07） |
| arousal 分布 | 2.07 – 7.08（中位 4.31） |
| 总推理耗时 | 33.1 分钟（60 首） |

**模型分辨力是够的**，排序与文件名语义一致：最低 valence 是 `mark's theme 英雄本色`(3.53)、`挑衅 provoca`(3.59)、`庄重细腻情绪`(3.63)；最高是 `振奋的流行放克`(7.18)、`groovy Hammond`(6.95)；最低 arousal 是 `深刻地城思考安静钢琴曲`(2.07)、`悲伤剧情氛围`(2.27)；最高是 `紧迫感进场`(7.08)。

#### 4.8.1 根因（已定位，不是猜测）

这不是时长问题，也不是文件损坏。插桩输出（`probe_trace.py`）：

```
--- extractor call #3 ---
  segment: shape=(706,)              ← 只剩 706 个样本 = 29 毫秒
  hidden_states: each=(1, 1, 768)    ← 只有 1 帧
  stack=(13, 1, 1, 768)
  squeeze=(13, 768)   ndim=2         ← 帧轴被压掉
  [1:, :, :] FAIL -> IndexError
```

链条是：

1. `is_split = True`、`segment_duration = 30`（`music2emo.py:78-80`），`split_audio` 按 **30 秒**切段（24 kHz → 720,000 样本/段）。
2. 这三个文件时长 **60.12 秒** = 1,442,915 样本 → 切成 `[720000, 720000, 2915]`。
3. 那 **2915 个样本（0.12 秒）的尾巴**单独过一次模型，只产出**一帧**。
4. `utils/mert.py:27` 的 `torch.stack(hidden).squeeze()[1:, :, :]` 在 `(13, 1, 1, 768)` 上 `squeeze()` 得到 `(13, 768)`——**帧轴与 batch 轴同时被压掉**，三段索引越界。

**边界实测**：失败的三个 remainder 全是 **2915** 样本；所有成功者的最小 remainder 是 **7392** 样本。预测"remainder 过小即崩溃"在 **60/60** 上成立。

#### 4.8.2 对设计的四个直接后果

1. **插件不能用 `Music2emo.predict()`。** 它在 5% 的输入上崩溃，且异常信息无法诊断。插件必须自己走这条链，复用的是其中的**计算**，不是那个入口函数。这也顺带完成 §7 阶段 2 要做的 gradio 剥离。
2. **丢弃过短的尾部残段。** 0.12 秒的残渣对 3 分钟音乐的情绪判断毫无影响，丢掉它对结果无损，却消除了整类崩溃。保守阈值取 **0.5 秒**（实测安全下界 0.31 秒）。
3. **仍要有兜底。** 即使这样也必然存在未知失败。每个文件必须独立捕获异常并如实报 `insufficient_evidence`，附上文件与耗时；**绝不整体中止**。索引必须可续跑（本次实测就是按行追加 NDJSON，中断后能续）。
4. **管线远不止 MERT 特征。** 计划初版把管线写成"resample → split → 抽 MERT 特征 → 情感头"，实施时发现这是错的。见 §4.10。

#### 4.8.3 三个失败文件的额外观察

它们**字节数完全相同（1,440,755）但哈希不同**，时长都是 60.12 秒——即它们来自同一来源或同一批量处理，**长度被精确裁到 60.12 秒**。这解释了为什么恰好都触发同一边界：这是"批量裁剪到固定时长"这种常见做法会系统性制造的缺陷。**任何以整分钟裁剪的素材库都会踩到它。**

### 4.10 实施时才发现的第二处：情感头的输入不止 MERT 特征

`FeedforwardModelMTAttnCK.forward` 需要四个输入（`vendored/model_linear_mt_attn_ck.py:68-76`）：

```python
model_input_dic = {
    "x_mert": ...,           # 1536 维（第 5、6 层拼接后按段平均）
    "x_chord_root": ...,     # 和弦根音索引，补零到 100
    "x_chord_attr": ...,     # 和弦属性索引，补零到 100
    "x_key": ...,            # 调式索引（major=0 / minor=1）
}
```

而 `x_chord_root` / `x_chord_attr` / `x_key` 的来路是一条长链（`music2emo.py:284-505`）：

1. **BTC 模型识别和弦**（`btc_model_large_voca.pt`）：`audio_file_to_features` → 按 `timestep` 分块 → `self_attn_layers` + `output_layer` → 起止检测 → 写 `.lab`（`%.3f %.3f <chord>` 格式）
2. **`.lab` → MIDI**：`mir_eval.io.load_labeled_intervals` + `mir_eval.chord.encode` / `rotate_bitmap_to_root` 逐音高检查 → `pretty_midi` 写 MIDI
3. **调性**：`music21.converter.parse(...).analyze('key')`，失败则 `"None"`
4. **按调移调**：`normalize_chord()`，用 `minor_major_dic2` / `shift_major_dic` / `shift_minor_dic` / `flat_to_sharp_mapping` 四张表
5. **编码**：`chordRootDic`（`chord_root.json`）、`chordAttrDic`（`chord_attr.json`）、`chord_to_idx`（`chord.json`）
6. **补零到 100**，超长截断到 100

另有两处初版漏掉的细节：

- 分类分支过 **`sigmoid`**（`probs = torch.sigmoid(classification_output)`），回归分支**不过**。
- 标签表是 **`tag_list[127:]`** 再剥掉 `mood/theme---` 前缀，**不是**整个 56 类表。

**为什么必须忠实复刻而不是简化**：`input_proj` 的输入维度是 `input_size + d_model_transformer + 1`（1536 + 8 + 1）。把和弦项喂零向量，模型仍能跑，但那已不是原模型的行为——§4.6/§4.9 里所有用于证明"分辨力够"和"数值法 15/15"的数字都会失去校准，**用户给出的目标坐标也会跟着失效**。

**因此验收标准是数值对拍**：同一个文件，本插件与上游 `Music2emo.predict()` 的 `valence` / `arousal` 必须一致（容差 1e-4），mood 标签集合必须相同。三个已知崩溃文件除外——对它们，上游本身就是失败的基线。

### 4.9 全库 60 首 × 15 条查询：结论被推翻，以及正确的做法

§4.7 用 4 首样本、3 条查询得出"中文 profile 是必需的"。这一轮把**全库**跑完，再用**15 条查询**（含 7 条直白、7 条改写、1 条混合情绪）重测同一套变体。产物：`match-wide-report.json`、`match-numeric-report.json`。

#### 4.9.1 五个变体的完整对照（57 首、15 条查询，同一套查询）

| 变体 | 命中 | clear | indirect | mixed |
|---|---|---|---|---|
| **纯 valence/arousal 数值** | **15/15** | 7/7 | 7/7 | 1/1 |
| 英文 profile | 14/15 | 6/7 | 7/7 | 1/1 |
| 仅文件名（**完全不用情感模型**） | 13/15 | 7/7 | 6/7 | 0/1 |
| 中文 profile + 文件名 各半 | 13/15 | 7/7 | 6/7 | 0/1 |
| 中文 profile（**§4.7 的结论**） | **11/15** | 7/7 | 4/7 | 0/1 |

**§4.7 的结论被推翻**：在真实分布上，中文 profile 是最差的一种，比"完全不用情感模型、只用文件名"还差。

#### 4.9.2 正确的做法：两个数是主角，文本是辅助

**valence/arousal 拿到 15/15，且这个变体不需要任何嵌入模型**——省掉一个 24M 参数的模型、一次下载、一层依赖。

原因也在数据里：**所有文本变体的相似度都挤在 0.33–0.62 这个窄带里**——这正是"这个空间里没有真正接近的东西"的表现。窄带意味着排序靠噪声，换一种措辞就可能翻盘。而两个数的差值是按 1–9 标尺上的真实距离算的，天然可分。

因此设计改为：

1. **主排序用 valence/arousal 距离**：调用方给出目标（愉悦度、能量），或由 agent 从剧本判断后给出。
2. **文本匹配降级为辅助**：只在调用方只给一句描述、没有坐标时，用来把 60 首粗筛成一小撮候选。
3. **候选必须带 valence/arousal 原值**，让调用方能看清"为什么是这首"，也能自己改目标重排。

#### 4.9.3 一条方法论教训（必须记住）

同一套代码，4 首样本说"中文最好（3/3）"，57 首样本说"中文最差（11/15）"。

**4 首 × 3 条查询不足以支撑任何"必须/不能"级别的结论。** §4.7 当时写的是"跨语言对齐不可靠——已实测并修正设计"，措辞过强；它其实只是三条查询上的一个观察。这不是模型的问题，是**样本量不足以做结论却下了结论**。

规则：**在 60 首以下的样本上，只报告观察，不下结论。** 涉及"用哪种方法"的取舍，必须在全库上验证。

#### 4.9.4 仍然诚实的边界

**这一轮同样不能证明"数值法更好"是普遍真理**，因为：

- 15 条查询的目标坐标（valence/arousal）是**我按语义写的**，不是客观真值。所以这个实验真正验证的是"给定坐标时，数值排序能找回对的曲子"，而**"从描述得到坐标"这一步是我手工完成的**——那一步恰恰是插件需要自动化而本次没有解决的。
- "对/错"的判定用的是我自己写的 mood 家族表，也是一种主观标注。
- 15 条查询仍然不多。11/15 与 14/15 的差在统计上不显著；但 11/15 与 15/15 的差、以及文本分数挤在 0.33–0.62 的窄带，是两个更硬的信号。

**所以插件不该假装能自动把散文变成坐标。** 正确形态是：**把坐标交给调用方**（人或 agent 判断"这场戏需要多压抑、多大能量"），插件负责在库里按坐标找最近的，并把候选的原始数值摊开。文本匹配只作为粗筛的便利入口。

## 5. 许可与署名（必做项，不是可选项）

三个来源，义务不同：

| 来源 | 状态 | 义务 |
|---|---|---|
| **Music2Emo** | **MIT**（AMAAI Lab, 2025） | 保留许可副本与署名 |
| **MERT-v1-95M** | **`cc-by-nc-4.0`——非商用**（实测于 HuggingFace model card API） | **禁止商业使用**。插件必须在使用界面与文档中显式告知；不能默认可商用 |
| **Auralis** | 上游**无 LICENSE 文件** | MUSE 的 `auralis_core/PROVENANCE.md` 措辞是"user-owned... this note does not assign an invented third-party license"。**路线 B 不需要 Auralis**，因此本设计不依赖它 |

### 5.1 Music2Emo 的代码要 vendor 进插件包

**不能依赖外部目录。** 插件若从 `E:\aa-manju\开源可fork项目\Music2Emotion-main` 读代码，就把插件绑死在某个人的磁盘布局上——换台机器即失效。

做法：**把必需的 Python 源码复制进插件包**，并配一份 `PROVENANCE.md` 记录来源、版本与 sha256。MUSE 已经用过这个模式（`packages/bundle/muse-product/python/auralis_core/` + 同名来源说明），照它做。

需要 vendor 的部分（§4.8 已决定**不含** `predict()` 与 gradio）：

```
packages/perception/perception-bgm/python/
  PROVENANCE.md          来源、上游版本、每个文件的 sha256、MIT 许可副本
  emo_pipeline.py        自写的管线入口（resample → split → 抽特征 → 情感头）
  vendored/
    mert.py              上游 utils/mert.py（去掉 squeeze 陷阱的那一行由管线层规避）
    btc_model.py         上游 utils/btc_model.py
    chords.py            上游 utils/chords.py
    constants.py         上游 utils/constants.py
    hparams.py           上游 utils/hparams.py
    preprocess.py        上游 utils/preprocess.py
    transformer_modules.py
    custom_early_stopping.py / logger.py / pytorch_utils.py / tf_logger.py
    mir_eval_modules.py
    model/               linear_mt_attn_ck.py 等情感头定义
  data/                  随仓库自带的权重与映射
    btc_model_large_voca.pt    11.7 MB
    chord*.json
    run_config.yaml
    tag_list.npy
```

情感头权重（`saved_models/J_all.ckpt`，12.4 MB）由**准备阶段从上游下载或随包分发**——它是 MIT 覆盖的产物，但按 §5 仍需登记来源与 sha256。

**vendored 代码的打分口径**：只做**机械搬运 + 去掉 gradio/`predict` 入口**，不改算法逻辑。任何算法改动都必须落在自写的 `emo_pipeline.py` 里，这样上游的算法保持原样、可逐文件校验 sha256。

**MERT 的非商用许可是本设计最大的约束**，且它不是工程问题：

- Music2Emo 的代码与情感头是 MIT，可以随便用；
- 但它**必须**跑在 MERT 骨干上，而骨干是 CC-BY-NC-4.0；
- 所以**整个插件不能用于商业目的**——不能用它给商业短剧选 BGM。

绕开的唯一办法是**换骨干**（例如寻找许可宽松的音乐理解模型），那是一次重新选型，不是调参。**这件事必须在实施前由使用者决定，见 §9。**

MIT 要求随分发保留版权声明与许可文本，所以插件必须内置一份第三方来源登记（`third-party` 清单），记录每个模型与代码来源的 URL、许可、sha256。

> 附带一提：MUSE 的 README 引用了 `MUSE_THIRD_PARTY_SOURCES.md`，但该文件在检出里**不存在**（已核实）。所以这份登记要从零建立。

## 6. 程序包与引导

```
packages/perception/perception-subs/   @deepseek-ai/dsh-perception-subs   字幕扫描
packages/perception/perception-bgm/    @deepseek-ai/dsh-perception-bgm    BGM 匹配
```

ffmpeg 引导与 Python 运行时管理都是两个包的共同前置，实现为共享的内部模块（出现第三个消费者时再提升为包）。

**"装好即用"要准备什么**（本机现状已核实）：

| 项 | 现状 |
|---|---|
| ffmpeg / ffprobe | ❌ 不在 PATH，需引导获取 |
| Python | ✅ 3.14.5 存在，但 **Music2Emo 依赖钉在 torch 2.3.1 / transformers 4.44 等 2024 年版本**；实测 **3.11.16 可用**并已跑通全库 |
| MERT-v1-95M | ❌ 需从 HuggingFace 下载，**实测 360 MB**（`pytorch_model.bin` 377 MB） |
| Music2Emo 权重 | ✅ 仓库自带：情感头 12.4 MB + 和弦模型 11.7 MB |
| **多语言文本嵌入模型** | ⚠️ **按 §4.9 结论已不再需要**（数值法 15/15 且不用嵌入模型）。只在"粗筛"入口保留时可选 |

**因此插件必须自带一个独立 Python 环境**（3.11 实测可用），而不是要求使用者降级系统 Python。

**准备方式**（已确认）：显式准备优于隐式自动。依赖与模型的失败模式很多（网络、镜像、wheel 兼容、磁盘、sha256 不符），隐式触发会把"网络断了"伪装成"插件坏了"。

## 7. 实施顺序

**阶段 0：已完成（本次实测）**
许可、体积、加载耗时、单首推理、全库 60 首通过率与崩溃根因，均已实测并写入 §4.6、§4.8、§4.9。**不需要再做。**

**阶段 1：ffmpeg 引导**
配置 → PATH → 下载 + 校验。两个包共同前置。

**阶段 2：`perception-bgm` 的 `inspect`**
只做单首音乐的情感分析，用来验证 Python 环境、MERT 加载与 worker 协议。**不碰索引，不碰匹配。**
这一阶段必须同时完成两件由实测决定的事：

1. **不用 `Music2emo.predict()`**，自己走那条链（`resample → split → 逐段抽特征 → 取第 5、6 层拼接 → 均值 → 情感头`）。上游入口在 5% 的输入上崩溃且异常无法诊断（§4.8.1）。
2. **丢弃短于 0.5 秒的尾部残段**，并**剥离 gradio 依赖**（省 207 MB + 约 30 个包）。这两件事一次做完，因为都发生在同一处。

**阶段 3：`perception-bgm` 的 `index` + `match`**
`index`：扫描 → 逐首情感 → 落索引（带 sha256，可续跑，单首失败不中止）。
`match`：**按 valence/arousal 距离排序为主**，返回候选与原始数值；文本匹配只作为"只给了一句描述"时的粗筛入口（§4.9.2）。

**阶段 4：`perception-subs`**
`probe` / `frames`（照搬 `media-worker.ts`）+ `scan` 的抽帧策略与区间输出。

**阶段 5：接剧变项目（可选）**
让 `match` 能读 MUSE `assets/` 里 `kind: bgm` 的登记。

**阶段 3：`perception-bgm` 的 `index` + `match`**
扫描 → 情感 → 描述 → 嵌入 → 索引；两层评分 → 排序输出。

**阶段 4：`perception-subs`**
`probe` / `frames`（照搬 `media-worker.ts`）+ `scan` 的抽帧策略与区间输出。

**阶段 5：接剧变项目（可选）**
让 `match` 能读 MUSE `assets/` 里 `kind: bgm` 的登记。

## 8. 风险

1. **MERT 是 `cc-by-nc-4.0`（非商用）——已核实，不是猜测。** 这是本设计最大的约束，且无法用工程手段绕开。见 §5。
2. **首次成本实测约 3.1 GB**（venv 2,750 MB + MERT 360 MB），其中 torch 984 MB、gradio 207 MB。这是"插件负责拉模型"的真实量级。
3. **Python 版本错配**：Music2Emo 开发于 3.10，本机系统解释器是 3.14.5。实测 **3.11.16 可用**（本次验证即用它跑通），但插件仍需自带独立环境，而不是要求使用者降级系统 Python。
4. **匹配层的可靠性——已实测，结论有边界。** 全库 57 首 × 15 条查询上，纯 valence/arousal 数值 15/15，各文本变体 11–14/15（§4.9）。但**"从描述得到坐标"这一步是本次手工完成的**，插件尚未解决；且"对错"用的是我自己的家族标注。所以插件的定位是"按坐标找曲子 + 摊开数值"，不假装能自动读懂散文。
5. **上游有确定性崩溃——已定位并已设计规避。** 音频长度不是 30 秒整数倍、且尾部残段极短时，`Music2emo.predict()` 必然 IndexError（全库 5%）。规避：不用该入口，并丢弃短于 0.5 秒的残段（§4.8）。**但同类边界可能还有别的，所以每个文件仍须独立捕获、如实报 `insufficient_evidence`、绝不整体中止。**
6. **`scan` 的调用成本**：交给视觉模型意味着按帧计费。抽帧密度必须有上限，且优先抽镜头边界。
7. **文件名层会误导**：`vroken` 那首已实证；且全库测试里"仅文件名"拿到 13/15，说明文件名信号不弱但也不可靠。必须靠 `matched_by` 让使用者看出线索来源。
8. **和弦提取是隐藏的复杂面**：`utils/chords.py` + music21 + mir_eval 是符号音乐分析。若它在某些素材上失败，必须如实报 `insufficient_evidence`，而不是降级成"只有 MERT 的结论"却不说。
9. **`trust_remote_code=True` 执行远端代码**：实测加载时会下载 `modeling_MERT.py` 并执行。**必须钉住 revision**。
10. **索引耗时实测 33.1 分钟 / 60 首**（比估算的 45–65 分钟快）。一次性成本，但必须后台可续、有进度。
11. **样本量教训**：4 首样本曾给出错误结论（§4.9.3）。**60 首以下只报告观察，不下结论。**

## 9. 已确认的决定

1. **MERT 非商用许可：接受，并明示限制。** 插件在使用界面与文档中必须显式声明"仅限非商业用途"，不能默认可商用。第三方登记（§5）如实记录 `cc-by-nc-4.0`。
2. **剥离 gradio：做。** 只保留 `predict` 相关路径，省下 207 MB 与约 30 个包。与上游分叉约 50 行，需记录分叉点与上游版本以便日后同步。
3. **准备方式：显式。** 一个 `perception_setup`，进度可见、可续传、可重试、失败可分类——适用于 3.1 GB 这个量级。
4. **BGM 输出：只给候选排序**，不返回"选中结果"。
5. **音乐来源：工作区目录 + 剧变音频资产**（只读本地文件）。
6. **匹配主力：valence/arousal 数值距离**，而不是文本相似度。文本匹配降级为"只给了一句描述"时的粗筛入口（§4.9 实测：数值 15/15，最好的文本变体 14/15，而我上一轮主张的中文 profile 只有 11/15）。
7. **字幕：不用 OCR**，抽帧交给视觉模型，插件只产出帧与疑似区间（§3）。
8. **不用 `Music2emo.predict()`**，自走管线并丢弃短于 0.5 秒的尾部残段；同时剥离 gradio（§4.8、§7 阶段 2）。

**因此不再需要多语言文本嵌入模型**（原列为"开放项"）。这省掉一个模型、一次下载与一层依赖。若日后要把"粗筛"做得更好，再单独评估。
