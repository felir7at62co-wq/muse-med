"""ASR Provider（TB-08 自动字幕）：OpenAI 兼容的 /audio/transcriptions。

渠道选择：**只走 api4me**。实测 zx1 网关没有挂 whisper——
    HTTP 503 model_not_found: 该模型在您可用的分组中均未启用
而 api4me 正常返回带时间戳的分段（verbose_json）。所以这里不做渠道链降级：
唯一可用的就一条，降级只会把"没配 key"和"渠道没这个模型"两种错误混成一个。

产出：[{start, end, text}]，时间是**音频内的相对秒**。调用方负责把它加上
该段音频在成片中的起点，换算成时间轴上的绝对位置。
"""
from __future__ import annotations

from pathlib import Path

import httpx

from ..config import get_settings
from . import http

#: Whisper 单文件上限 25MB（OpenAI 接口约定）。超了要先切段，
#: 但短剧旁白单段几十秒、几百 KB，这里只做防御性拦截。
_MAX_BYTES = 25 * 1024 * 1024
_TIMEOUT = 180.0

_AUDIO_MIME = {
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
}


class ASRSegment(dict):
    """{start, end, text}；用 dict 子类是为了直接 JSON 序列化。"""


#: 给 Whisper 的书写风格提示。**它买到的是两件事，都是实测的，不是猜的。**
#:
#: 2026-09-07 在项目 13fd3b2ba28e（五集真人剧）的镜头原声上 A/B 实测：
#:
#: | 参数 | #26 分段数 | 字形 |
#: |---|---|---|
#: | 裸调 | **1**（26s 一整条） | 繁体 |
#: | `language="zh"` | **1** | 繁体（**完全无效**） |
#: | 本 prompt | **5** | 简体 |
#:
#: ① **字形统一**。Whisper 转写中文普通话时输出繁/简是随机的：同一部片里
#:    #1 出繁体「年薪三百一十八萬」、#19 出简体，混在一部成片里非常明显。
#:    `language="zh"` 对此**毫无作用**（实测两次输出逐字相同）——语言判定
#:    与字形选择是两回事，能影响字形的只有 prompt 这个风格样本。
#: ② **顺带修好了分段**。裸调时 #26/#25/#2 都退化成"整段一条"（无 segments，
#:    一条 26 秒 55 字的字幕），加 prompt 后分别切成 5/4/6 条。
#:    所以这不只是"字好看点"，它同时消掉了一类无法阅读的字幕。
#:
#: 刻意**不**同时传 `language="zh"`：它既无效，又会破坏 transcribe 里
#: 记载的"留空让 Whisper 自动判断，别把英文台词硬转成中文谐音"那条决定。
#:
#: 提示词本身要写成**目标风格的样本**（Whisper 把 prompt 当上文续写），
#: 所以它自己必须是简体、带标点的短剧台词口吻。
SIMPLIFIED_ZH_PROMPT = "以下是简体中文短剧台词的转写。"


def pick_asr_provider():
    """选出**当前可用**的语音识别通道；都不可用返回 None。

    优先级：**火山极速版 → 百炼 Paraformer → whisper**。通道在这里一次选定，
    调用失败不换下一家（理由见下）。

    ## 为什么火山排第一（2026-11-21）

    它是 Muse 转写用的同一个语音应用，配了 `FW_DRAMA_ASR_CONFIG` 就说明服务器已经
    接通了它；字幕与转写用同一家，听写结果的风格一致。火山每句回一段，长句由
    `subtitle_jobs._split_cue` 按标点切行、时长按字数分，不像百炼那样按字级戳切
    （原因见 `asr_volc` 模块说明）。

    ## 为什么 Paraformer 排在 whisper 前面

    实测对比（2026-10-20，同一段 10.6 秒 m4a）：

    | | whisper（api4me） | Paraformer-v2 |
    |---|---|---|
    | 可用性 | key 自 2026-10-09 起为空 | 可用 |
    | 时间戳 | 句级 | 句级 **+ 字级** |
    | 单文件 | 25 MB | 2 GB / 12 小时 |
    | 幻觉 | 「请不吝点赞订阅转发」 | 无 |

    字级戳直接决定字幕能不能按语义断行（见 `asr_bailian.split_long_sentence`），
    这是 whisper 给不了的。

    ## 为什么不做"运行时自动降级"

    几家都可用时**固定走排在前面的那家**，不在调用失败时静默切到下一家：
    各家的断行与时间戳粒度不同，同一条音轨先后用两家转出来的字幕
    **边界会不一样**，而用户看到的现象是"重跑一次字幕全变了"却不知道为什么。
    通道故障应当报错让人知道，不是悄悄换一个产出不同结果的东西。
    """
    from .asr_bailian import BailianASR
    from .asr_volc import VolcFlashASR

    volc = VolcFlashASR()
    if volc.available:
        return volc
    bailian = BailianASR()
    if bailian.available:
        return bailian
    legacy = ASRProvider()
    if legacy.available:
        return legacy
    return None


class ASRProvider:
    """语音转文字。available=False 时调用方应把入口置灰而不是报错。"""

    #: 用于错误提示与 `/v2/asr/status` 展示，让用户知道**哪一条**通道在工作。
    name = "whisper"

    def __init__(self) -> None:
        s = get_settings()
        self.base = (s.api4me_base_url or "").rstrip("/")
        self.key = s.api4me_api_key
        self.model = "whisper-1"

    @property
    def available(self) -> bool:
        return bool(self.base and self.key)

    async def transcribe(self, path: str | Path,
                         language: str | None = None,
                         prompt: str | None = None) -> list[ASRSegment]:
        """转写单个音/视频文件，返回带时间戳的分段。

        language：ISO-639-1（如 "zh"）。留空让 Whisper 自动判断——
        短剧里偶有英文台词，写死 zh 反而会把它硬转成中文谐音。

        prompt：给 Whisper 的风格提示（OpenAI 接口的 `prompt` 字段）。
        它不是"要识别的内容"，而是**书写风格样本** —— 见 `SIMPLIFIED_ZH_PROMPT`。
        """
        if not self.available:
            raise RuntimeError("未配置语音识别通道（FW_API4ME_API_KEY）")
        p = Path(path)
        if not p.exists():
            raise RuntimeError(f"音频文件不存在: {p.name}")
        size = p.stat().st_size
        if size > _MAX_BYTES:
            raise RuntimeError(
                f"音频超过 25MB（{size / 1024 / 1024:.1f}MB），请先分段")
        if size == 0:
            raise RuntimeError(f"音频文件为空: {p.name}")

        mime = _AUDIO_MIME.get(p.suffix.lower(), "application/octet-stream")
        data = {"model": self.model, "response_format": "verbose_json"}
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt

        async with http.client("asr", timeout=_TIMEOUT) as client:
            with p.open("rb") as fh:
                r = await client.post(
                    f"{self.base}/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.key}"},
                    files={"file": (p.name, fh, mime)},
                    data=data,
                )
        if r.status_code != 200:
            raise RuntimeError(f"语音识别失败 {r.status_code}: {r.text[:200]}")
        if not r.content:
            raise RuntimeError("语音识别返回空响应（api4me verbose_json 路径异常）")
        try:
            body = r.json()
        except ValueError:
            # api4me 有时 verbose_json 返回空体 —— 降级重试 plain json
            body = None

        if body is None:
            # 降级：重试用 response_format=json（只有 text，无 segments）
            data2 = {"model": self.model, "response_format": "json"}
            if language:
                data2["language"] = language
            if prompt:
                data2["prompt"] = prompt
            async with http.client("asr", timeout=_TIMEOUT) as client2:
                with p.open("rb") as fh2:
                    r2 = await client2.post(
                        f"{self.base}/v1/audio/transcriptions",
                        headers={"Authorization": f"Bearer {self.key}"},
                        files={"file": (p.name, fh2, mime)},
                        data=data2,
                    )
            if r2.status_code != 200 or not r2.content:
                raise RuntimeError(
                    f"语音识别失败（降级后仍不可用） {r2.status_code}: {r2.text[:200]}")
            body = r2.json()

        segs = body.get("segments") or []
        out: list[ASRSegment] = []
        for sg in segs:
            text = (sg.get("text") or "").strip()
            if not text:
                continue
            out.append(ASRSegment(
                start=float(sg.get("start") or 0.0),
                end=float(sg.get("end") or 0.0),
                text=text,
            ))
        # 有些实现只回整段 text 不给 segments —— 退化成"一整条字幕"，
        # 总比什么都不产出强（用户还能手动切）
        if not out and (body.get("text") or "").strip():
            out.append(ASRSegment(
                start=0.0,
                end=float(body.get("duration") or 0.0),
                text=body["text"].strip(),
            ))
        return out
