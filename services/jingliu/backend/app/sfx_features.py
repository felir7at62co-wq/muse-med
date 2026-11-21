"""音效的**客观声学特征** —— 让 agent 在听不到声音的情况下判断"这条该用在哪"。

## 为什么需要这一层（2026-10-24 用户要求）

用户把一个精选文件夹指定为音效库，并问了关键一问：
「agent 如何判断我给的这些音效该用在哪里呢？」

真实困难：agent 读不到声音，只能看名字。而精选库里有「微光」「10月23日」
「大明王朝悬疑音效」这种名字 —— 光看文字**猜不出**它是"一下就好"还是
"铺满整段"。模型只能瞎猜，猜错的后果是音效全错位，且没有任何报错。

所以这里从音频本身算出几条**可判定**的性质，写进 manifest，由
`sfx._row` 转成一句人话交给模型。实测这 14 条的差别极大：

| 文件 | 时长 | 起音 | 前20%能量 | 结论 |
|---|---|---|---|---|
| 咚 | 1.07s | 40ms | 0.30 | 一下即止的**重击** |
| 咚咚重音 | 4.75s | 40ms | **0.79** | 重击 + 长尾 |
| 微光 | 5.41s | **1380ms** | **0.01** | 缓慢渐起的**铺底** |
| 氛围上升3 | 5.67s | 1360ms | 0.01 | 渐强铺底 |
| 沙锤1 | 3.34s | 1020ms | 0.12 | 持续**质感** |

`前20%能量 0.79` 与 `0.01` 是两类完全不同的东西：前者是"卡在动作那一下"，
后者是"铺满整段、慢慢起来"。这个区别靠文件名永远看不出来。

## 只在导入时算，不在请求时算

解码 + FFT 是几百毫秒级的事，放进 `list_sfx` 会让每次检索都变慢。
所以由 `scripts/import_sfx.py` 在导入时算好写进 manifest，运行时只读。

## 各指标怎么读

- **onset_ms**（起音时间）：从 10% 能量升到 90% 峰值用多久。
  小 = 一击即发（撞击、关门的"啪"）；大 = 渐入（氛围铺底）。
- **early_conc**（前 20% 时间里的能量占比）：能量是不是集中在开头。
  高 = 一下就结束；低 = 铺满整段。**这一条最能区分"事件音"与"铺底音"**。
- **brightness**（频谱重心，0~1）：越高越"亮/脆"（铃铛、沙锤），
  越低越"闷/沉"（低频重击、心跳）。
- **zcr**（过零率）：噪声类（沙锤、风）高，乐音/低频低。

这四条都是**客观量**，不是判断。判断（"这一镜该配哪条"）仍然由模型做。
"""
from __future__ import annotations

import subprocess

#: 解码统一到这个采样率。ASR / 特征分析都用它，没必要更高。
SR = 16000

#: 包络分析的帧长（秒）。20ms 足够分辨"一击"与"渐入"。
HOP = 0.02

#: 判定为「渐入铺底」的起音时长（毫秒）。
#:
#: 实测这 14 条分得很干净：铺底/渐入类 720~1380ms，事件类 0~380ms。
#: 600 落在两簇中间的空档里 —— 不是"调出来的"，那批数据里就没有样本落在中间。
SLOW_ONSET_MS = 600

#: 事件音里"有没有长尾"的分界（秒）。
#:
#: 起音快的里面再分两类：短的是**一下即止**（1.0~1.9s：咚、铃铛、木质敲击），
#: 长的是**重击带尾**（3.0~5.8s：撞击、重音、悬念）。2.0 落在空档里。
TAIL_SEC = 2.0


def decode(path) -> "np.ndarray":  # noqa: F821 — numpy 只在函数内导入
    """解码成 16k 单声道 float32。解不出来返回空数组（不抛，调用方跳过）。"""
    import numpy as np

    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
             "-f", "f32le", "-"], capture_output=True, timeout=120)
    except Exception:  # noqa: BLE001
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(r.stdout, dtype=np.float32)


def analyse(path) -> dict | None:
    """算一条音效的特征。解不出来返回 None（调用方跳过，不阻断导入）。"""
    import numpy as np

    a = decode(path)
    if a.size == 0:
        return None
    dur = a.size / SR
    hop = max(1, int(HOP * SR))
    n = a.size // hop
    if n < 2:
        return None
    env = np.array([np.abs(a[i * hop:(i + 1) * hop]).mean() for i in range(n)])
    mx = float(env.max())
    if mx <= 0:
        return None

    # 起音：10% → 90% 峰值
    i10 = int(np.argmax(env >= 0.1 * mx))
    i90 = int(np.argmax(env >= 0.9 * mx))
    onset_ms = max(0, i90 - i10) * int(HOP * 1000)

    # 能量集中度（前 20% 时间）
    k = max(1, int(n * 0.2))
    total = float(env.sum())
    early = float((env[:k].sum() / total) if total > 0 else 0.0)

    # 频谱重心（归一化到 0~1）
    spec = np.abs(np.fft.rfft(a * np.hanning(a.size)))
    freqs = np.fft.rfftfreq(a.size, 1 / SR)
    ssum = float(spec.sum())
    centroid = float((spec * freqs).sum() / ssum / (SR / 2)) if ssum > 0 else 0.0

    # 过零率
    zcr = float(np.mean(np.abs(np.diff(np.sign(a)))) / 2)

    return {
        "duration": round(dur, 3),
        "onset_ms": int(onset_ms),
        "early_conc": round(early, 3),
        "brightness": round(centroid, 3),
        "zcr": round(zcr, 3),
    }


def usage_of(f: dict | None) -> str | None:
    """特征 → 用途类型。**这是分类，不是判断该不该用**。

    四种：
      · `hit`     —— 一下即止（撞击、关门、木质敲击）。挂在**动作那一下**。
      · `accent`  —— 重击带长尾（重音、轰鸣、悬念）。挂在一个**节拍点**上，
                     尾音自然衰减，不要叠加第二个。
      · `bed`     —— 缓慢渐入、铺满整段（氛围、微光、上升）。铺在**一整段**下面。
      · `texture` —— 起音不慢、但也不是短促一击（持续质感）。铺在段落里，音量压低。

    返回 None = 没算过特征，调用方不要编一个。

    ## 为什么按"起音快慢"分而不是按"能量集中度"（2026-10-24 实测修正）

    第一版用 `early_conc`（前 20% 时间的能量占比）判，结果把「咚」（1.07 秒的
    单次敲击）判成了 `texture`。原因是 `early_conc` 区分不了两件事：
    **"一击拖着长尾"** 与 **"从头到尾都在响"** —— 两者前 20% 的能量占比可以一样。

    实测这 14 条的**起音时间**分得极干净：
        渐入铺底   720 / 1020 / 1360 / 1380 ms
        事件音     0 / 0 / 40 / 40 / 80 / 180 / 240 / 260 / 380 ms
    两簇之间是 380→720 的空档，没有样本落在中间。所以先用 `onset_ms` 切成
    「渐入 vs 事件」，事件里再用**总时长**切「一下即止 vs 一击带尾」。
    `early_conc` 仍然保留在返回值里给模型看（它是描述性事实），但不再当判据。
    """
    if not f:
        return None
    onset = f.get("onset_ms")
    dur = f.get("duration")
    if onset is None or dur is None:
        return None
    if onset >= SLOW_ONSET_MS:
        return "bed"
    if dur <= TAIL_SEC:
        return "hit"
    # 起音快 + 总时长长：一击带长尾（重音、轰鸣）。
    # 但持续时间长、能量又一直不衰减的，更像持续质感而不是"一击"。
    conc = f.get("early_conc")
    if conc is not None and conc < 0.25:
        return "texture"
    return "accent"


#: 用途类型 → 给模型看的一句话。**写清"挂在哪"，因为这才是它要判断的事。**
USAGE_CN: dict[str, str] = {
    "hit": "一下即止——挂在某个动作的那一下（关门/拍桌/转身），不要铺",
    "accent": "重击带长尾——挂在一个节拍点，让尾音自己衰减，不要叠加第二个",
    "bed": "缓慢渐入、铺满整段——铺在一整段画面下面，不要卡在某一秒",
    "texture": "持续质感——铺在段落里，音量要压低让人声盖过它",
}
