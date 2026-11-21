"""阿里云百炼 Paraformer 非实时语音识别（2026-10-20）。

## 为什么换到这里

`providers/asr.py` 的 whisper 通路自 2026-10-09 api4me 全线 403 后就一直是
**没有 key 的死状态**（`ASRProvider.available` 恒为 False），于是
`run_auto_subtitles` 在 dev 与 prod **一次都没成功过**。用户看到的
「没有可识别的旁白音频，请先合成 AI 配音」其实与配音毫无关系。

选 Paraformer 而不是继续找 whisper 中转站，四条实测理由：

| | whisper（旧） | Paraformer-v2 |
|---|---|---|
| 时间戳 | 句级 | **句级 + 字级** |
| 单文件 | 25 MB | 2 GB / 12 小时 |
| 幻觉 | 「请不吝点赞订阅转发」是权重级行为 | 非自回归，**无此类幻觉** |
| 价格 | ~0.36 元/时 | **0.00008 元/秒 ≈ 0.288 元/时** |

## 实测（2026-10-20，真实 10.6 秒 m4a）

```
提交 200 → 2.2s SUCCEEDED
sentences: [{begin_time:0, end_time:6061, text:"她穿着干净的素色旗袍…"},
            {begin_time:6061, end_time:10660, text:"我走进去，声音放轻…"}]
words(首句): 28 个，每个带 begin_time/end_time
```

**字级戳是二次切分的依据**：一句话 55 字、6 秒，直接铺满 6 秒没人读得完；
按字级戳在标点处切成两条才符合字幕阅读节奏。

## 接口形态：异步任务式，不是同步返回

```
POST /services/audio/asr/transcription   (X-DashScope-Async: enable)
  → {"output": {"task_id": "..."}}
GET  /tasks/{task_id}
  → {"output": {"task_status": "SUCCEEDED", "results": [{transcription_url}]}}
GET  <transcription_url>                 → {"transcripts": [{sentences: [...]}]}
```

⚠️ `transcription_url` 是**另一台对象存储的临时地址**，有效期很短。所以本模块
拿到之后必须**当场取回内容**，不能把 URL 存进库里指望以后再下载。

## 音频怎么给

Paraformer 只收**公网可访问的 URL**（不收 multipart 上传）。本项目已有 TOS，
`storage.public_url(rel, ttl=48*3600)` 可用，而 Paraformer 要求 URL 在 48 小时内
有效——正好对上。TOS 未启用时退回本机公网地址（`public_base_url` + `/media/...`）。

⚠️ **这会把音频暴露成公网可读的临时链接**（带签名、48 小时后失效）。
这是该接口的固有要求，不是我们的选择。签名 URL 泄露的风险由 TTL 兜底；
若要更严，只能改用 SDK 直传（当前 DashScope 的 multipart 接口不支持录音文件识别）。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx

from ..config import get_settings
from . import http
from ..executors import run_long_blocking
from .asr import ASRSegment

logger = logging.getLogger("fw.asr.bailian")

#: 轮询参数。实测 10 秒音频 2.2 秒出结果；一集 2 分钟的旁白按经验几十秒。
#: 上限给到 10 分钟——再长就说明上游卡住了，继续等只是在占着 runner。
_POLL_INTERVAL = 1.5
_POLL_TIMEOUT = 600.0

#: 字幕单行上限（字）。超过就在字级戳上找最近的标点切开。
#: 数值来源：`jianying.py` 的字幕样式 `max_line_width=0.82` 在 1080 宽画布上
#: 约容纳 18~22 个汉字；取 20 再把标点算进去，留一点余量。
MAX_LINE_CHARS = 20

#: 句末停顿时长（毫秒）。超过它就认为是一句自然结束，可以断开。
_SENTENCE_GAP_MS = 200


class BailianASR:
    """与 `ASRProvider` **同接口**：`available` + `transcribe()`。

    调用方 (`subtitle_jobs.run_auto_subtitles`) 一行都不用改，
    换 provider 只是换实现。
    """

    #: 用于错误提示与 `/v2/asr/status` 展示，让用户知道**哪一条**通道在工作。
    name = "bailian-paraformer"

    def __init__(self) -> None:
        s = get_settings()
        self.base = (getattr(s, "bailian_base_url", "") or "").rstrip("/")
        self.key = getattr(s, "bailian_api_key", "") or ""
        self.model = getattr(s, "bailian_asr_model", "") or "paraformer-v2"

    @property
    def available(self) -> bool:
        return bool(self.base and self.key)

    # ---------------------------------------------------------------- 主入口

    async def transcribe(self, path: str | Path,
                         language: str | None = "zh",
                         prompt: str | None = None) -> list[ASRSegment]:
        """转写一个本地音/视频文件，返回**按字幕行切好**的分段。

        与 whisper 那版的差别要说清：whisper 直接返回它的 segments，
        本实现返回的是**我们自己按字级戳重新断行的结果**。
        原因是 Paraformer 的一句话常常 40~60 字（6~10 秒），直接当字幕没人读得完。
        """
        if not self.available:
            raise RuntimeError("未配置阿里云百炼语音识别通道（FW_BAILIAN_API_KEY）")
        p = Path(path)
        if not p.exists():
            raise RuntimeError(f"音频文件不存在: {p.name}")

        url = await self._public_url(p)
        raw = await self._submit_and_wait(url, language)
        return self._to_segments(raw)

    # ---------------------------------------------------------------- 公网 URL

    async def _public_url(self, p: Path) -> str:
        """把本地文件变成一个 48 小时内有效的公网地址。

        优先级：TOS 签名 URL（素材本来就在桶里或能推上去）→ 本机公网地址。
        """
        from .. import media, storage

        # 路径要能在 media 的相对命名空间里表达。DATA_DIR 之外的临时文件
        # 先挪进去——Paraformer 只认 URL，没有第二条路。
        try:
            rel = p.resolve().relative_to(media.DATA_DIR.resolve()).as_posix()
        except (ValueError, OSError):
            rel = ""

        if rel and storage.enabled():
            # 本地有这个文件就先推上去（upload/ 之外的文件可能从没进过桶）。
            try:
                # 推桶是网络调用（httpx.put，timeout=600s），进长阻塞池：
                # 和鉴权 verify_session 共用默认 20 槽会让全站排队。见 app/executors.py。
                await run_long_blocking(storage.put_file, p, rel)
            except Exception as e:  # noqa: BLE001 — 推桶失败不致命，下面还有本机地址
                logger.warning("[bailian-asr] 推桶失败(%s)，改用本机地址: %r", rel, e)
            else:
                url = storage.public_url(rel, ttl=48 * 3600)
                if url:
                    return url

        if not rel:
            raise RuntimeError(
                f"音频不在素材目录下，无法提供公网地址: {p}")

        from ..config import get_settings as _gs
        base = (_gs().public_base_url or "").rstrip("/")
        if not base:
            raise RuntimeError(
                "音频无法公网访问：既没有 TOS 也没有配置 FW_PUBLIC_BASE_URL。"
                "Paraformer 录音文件识别只接受公网 URL。")
        return f"{base}/media/{rel}"

    # ---------------------------------------------------------------- 提交与轮询

    async def _submit_and_wait(self, file_url: str, language: str | None) -> dict:
        hdr = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        }
        params: dict = {
            # 字级戳是字幕断行的依据，必须开。实测默认就返回 words，
            # 显式写上是为了防止上游改默认值。
            "sentence_timestamp_enabled": True,
        }
        if language:
            params["language_hints"] = [language]

        body = {"model": self.model,
                "input": {"file_urls": [file_url]},
                "parameters": params}

        async with http.client("asr-bailian", timeout=120.0) as c:
            r = await c.post(f"{self.base}/services/audio/asr/transcription",
                             headers=hdr, json=body)
            if r.status_code != 200:
                raise RuntimeError(f"Paraformer 提交失败 HTTP {r.status_code}: "
                                   f"{r.text[:300]}")
            out = (r.json().get("output") or {})
            task_id = out.get("task_id")
        if not task_id:
            raise RuntimeError(f"Paraformer 未返回 task_id: {out}")

        result = await self._poll(task_id)
        tr_url = self._transcription_url_of(result)
        if not tr_url:
            raise RuntimeError(f"Paraformer 返回里没有 transcription_url: {result}")
        async with http.client("asr-bailian", timeout=120.0) as c:
            rt = await c.get(tr_url)
            if rt.status_code != 200:
                raise RuntimeError(
                    f"取转写结果失败 HTTP {rt.status_code}（URL 可能已过期）")
            return rt.json()

    async def _poll(self, task_id: str) -> dict:
        hdr = {"Authorization": f"Bearer {self.key}"}
        waited = 0.0
        async with http.client("asr-bailian-poll", timeout=60.0) as c:
            while waited < _POLL_TIMEOUT:
                await asyncio.sleep(_POLL_INTERVAL)
                waited += _POLL_INTERVAL
                r = await c.get(f"{self.base}/tasks/{task_id}", headers=hdr)
                if r.status_code != 200:
                    # 单次 5xx 不值得放弃整个任务；只有持续失败才会撞到超时上限。
                    logger.warning("[bailian-asr] 轮询 HTTP %s: %s",
                                   r.status_code, r.text[:200])
                    continue
                d = r.json()
                out = d.get("output") or {}
                st = out.get("task_status")
                if st == "SUCCEEDED":
                    return out
                if st in ("FAILED", "CANCELED", "UNKNOWN"):
                    raise RuntimeError(
                        f"Paraformer 任务 {st}: {d.get('message') or out}")
        raise RuntimeError(
            f"Paraformer 轮询超时（{int(_POLL_TIMEOUT)}s 未返回），任务 {task_id}")

    @staticmethod
    def _transcription_url_of(out: dict) -> str | None:
        for item in (out.get("results") or []):
            if not isinstance(item, dict):
                continue
            if item.get("subtask_status") not in (None, "SUCCEEDED"):
                continue
            u = item.get("transcription_url")
            if u:
                return u
        return None

    # ---------------------------------------------------------------- 结果整形

    @staticmethod
    def _to_segments(tj: dict) -> list[ASRSegment]:
        """`transcripts[].sentences[]` → 按字幕行切好的 `[{start, end, text}]`（秒）。"""
        out: list[ASRSegment] = []
        for tr in (tj.get("transcripts") or []):
            for s in (tr.get("sentences") or []):
                text = (s.get("text") or "").strip()
                if not text:
                    continue
                b = int(s.get("begin_time") or 0)
                e = int(s.get("end_time") or 0)
                if e <= b:
                    # 零长段在时间轴上非法（剪映会判越界），直接丢。
                    continue
                words = s.get("words") or []
                for piece in split_long_sentence(text, words, b, e):
                    out.append(ASRSegment(start=piece["start"],
                                          end=piece["end"],
                                          text=piece["text"]))
        # 相邻重叠会让剪映文本轨报"越界"。上游偶尔给出首尾相接但差 1ms 的
        # 段，这里统一收口：后一句的起点不早于前一句的终点。
        prev_end = 0.0
        for seg in out:
            if seg["start"] < prev_end:
                seg["start"] = prev_end
            if seg["end"] <= seg["start"]:
                seg["end"] = seg["start"] + 0.05
            prev_end = seg["end"]
        return out


# ---------------------------------------------------------------------------
# 断行
# ---------------------------------------------------------------------------

#: 优先在这些字符后断开。
_BREAK_AFTER = set("。！？…；，、：,.!?;:")
#: 绝不在这些字符**之前**断开（否则会出现「，」开头的一行）。
_NO_BREAK_BEFORE = set("。！？…；，、：,.!?;:）)」』”’")


def split_long_sentence(text: str, words: list[dict],
                        begin_ms: int, end_ms: int) -> list[dict]:
    """把一句过长的转写切成若干字幕行（单位：秒）。

    ## 为什么必须按字级戳切，而不是按字数均分

    按字数均分会得到一个「看起来合理、读起来错位」的结果：中文的语速在句中
    变化很大（「他——站起来了。」前半 3 个字可能占 60% 时间）。用均分时
    字幕会提前/滞后出现在画面上，观众察觉不到"错了"，只会觉得"字幕对不上"。

    ## 规则

    1. 不超过 `MAX_LINE_CHARS` 就不切（绝大多数句子走这条路）；
    2. 需要切时，在**字级戳**上找「标点后 + 停顿 > 200ms」的位置；
    3. 找不到标点就按字数在最近的停顿处分；
    4. 每一段的时间取该段首字到末字的戳，不平摊。
    """
    t = text.strip()
    if len(t) <= MAX_LINE_CHARS or not words:
        return [{"start": begin_ms / 1000.0, "end": end_ms / 1000.0, "text": t}]

    # words 与 text 的字符序列**不一定逐字对齐**：Paraformer 把标点放在
    # 独立的 `punctuation` 字段里，`text` 只有字。所以比对时必须把
    # punctuation 拼回去，否则 `joined` 恒比 `t` 短几个标点、永远判"对不齐"，
    # 断行**静默失效**（实测：31 字的长句一段都不切，一屏挤满）。
    #
    # 反过来说，对不齐时仍然宁可整句不切 —— 切错的代价（时间轴与文本错位）
    # 比不切大得多。
    toks: list[tuple[str, int, int]] = []
    for w in words:
        wt = (w.get("text") or "")
        punc = (w.get("punctuation") or "")
        if not wt and not punc:
            continue
        b = int(w.get("begin_time") or 0)
        e = int(w.get("end_time") or 0)
        # 标点跟在它所属的那个字后面，时间用同一个字的
        toks.append((wt + punc, b, e))
    joined = "".join(x[0] for x in toks)
    if joined.replace(" ", "") != t.replace(" ", ""):
        # 对不齐：宁可整句不切。至少文本与时间是自洽的。
        return [{"start": begin_ms / 1000.0, "end": end_ms / 1000.0, "text": t}]

    pieces: list[dict] = []
    cur: list[tuple[str, int, int]] = []
    cur_len = 0

    def flush() -> None:
        nonlocal cur, cur_len
        if not cur:
            return
        txt = "".join(x[0] for x in cur).strip()
        if txt:
            pieces.append({"start": cur[0][1] / 1000.0,
                           "end": cur[-1][2] / 1000.0,
                           "text": txt})
        cur = []
        cur_len = 0

    def _best_break() -> int:
        """在当前缓冲里找**最好的断点位置**（返回下标，0 表示找不到）。

        ## 为什么不能"到上限时看当前这一字是不是标点"

        初版是那样写的，实测**一句都切不开**：长句的标点常常早在第 10 个字
        （「她穿着干净的素色旗袍，即使病着…」共 31 字），而检查从第 20 个字
        才开始 —— 那个逗号根本没被看见，于是整句原样铺一屏。

        正确做法是**每加一个字就回看整个缓冲**，选最后一个合适的断点：
          ① 优先标点（后接标点 = 语义完整）；
          ② 其次长停顿（≥200ms，句间自然换气）；
          ③ 且切断后本行不能太短（少于 8 字就该继续攒，否则一屏全是碎句）。
        """
        best = 0
        min_len = max(6, MAX_LINE_CHARS // 2)
        for j in range(len(cur) - 1, min_len - 1, -1):
            ch = cur[j][0]
            nxt = cur[j + 1][1] if j + 1 < len(cur) else cur[j][2] + 10000
            gap = nxt - cur[j][2]
            if ch and ch[-1] in _BREAK_AFTER:
                return j + 1
            if gap >= _SENTENCE_GAP_MS and (not ch or ch[-1] not in _NO_BREAK_BEFORE):
                best = j + 1
                break
        return best

    for i, (wt, b, e) in enumerate(toks):
        cur.append((wt, b, e))
        cur_len += len(wt)
        if cur_len < MAX_LINE_CHARS:
            continue
        cut = _best_break()
        if cut and cut < len(cur):
            tail = cur[cut:]
            keep = cur[:cut]
            txt = "".join(x[0] for x in keep).strip()
            if txt:
                pieces.append({"start": keep[0][1] / 1000.0,
                               "end": keep[-1][2] / 1000.0, "text": txt})
            cur = tail
            cur_len = sum(len(x[0]) for x in tail)
        elif cut == len(cur):
            flush()
    flush()

    # 单段仍然超长（没有标点、一长串）：按最大字数硬切，保证每行可读。
    final: list[dict] = []
    for piece in pieces:
        txt = piece["text"]
        if len(txt) <= MAX_LINE_CHARS * 2:
            final.append(piece)
            continue
        n = (len(txt) + MAX_LINE_CHARS - 1) // MAX_LINE_CHARS
        step = len(txt) / n
        span = piece["end"] - piece["start"]
        for k in range(n):
            a, z = int(k * step), int((k + 1) * step)
            final.append({
                "start": piece["start"] + span * (a / len(txt)),
                "end": piece["start"] + span * (z / len(txt)),
                "text": txt[a:z],
            })
    return final
