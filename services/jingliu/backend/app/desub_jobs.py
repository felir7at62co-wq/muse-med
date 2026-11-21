"""去字幕（擦除视频模型烧进画面的原生字幕）的两条 job。

## 这个功能在修什么

seedance 这类音画一体的视频模型**偶尔会擅自把台词烧进成片画面**。全库抽样
实测约 **5.5%** 的成片中招。它与织影自己的 `subtitle_clips` 软字幕轨**没有
任何关系** —— 软字幕是导出时才烧的，关掉即可；这里要擦的是**已经长在像素里**
的字，除了重新生成整镜之前没有任何手段。

## 通道：火山 MediaKit 字幕擦除（精细版），整条送、整条回

**不切段、不拼接。** 这是本模块最重要的一条约束，理由是一整次事故：

旧通道（已删除）按时间区间把镜头切成几段分别送去擦，再用 `concat` 拼回。
`concat` 按**帧**接，而音轨是 `-map 0:a -c copy` 从原片整条穿过的 —— 一旦
上游少还几帧（实测会，且会改输出帧率 24→27），接缝之后的画面就相对音频
**永久前移**，且同一镜反复擦会**累积**。当时的等长断言比的是
`format=duration`（容器时长 = 最长的那条流），被音轨撑住，569 条记录里
494 条 drift 恒为 0，等于没检查。见 `docs/AUDIT-2026-11-12-去字幕音画不对应.md`。

火山整条送、整条回，产物帧率帧数与原片一致（实测 24→24、265→265），
没有接缝，那个失效模式从根上不存在。

## 两条 job 的分工

| job | 花的钱 | 干什么 |
|---|---|---|
| `desub_scan` | VLM token（便宜） | 找出**哪几镜、哪几秒、哪个框**有烧录字幕，写进 `transform_meta.desub` |
| `desub_apply` | 火山按**视频时长**计费（贵） | 把用户确认过的块送去擦，落新 `ShotVersion` |

分成两条而不是一条，是因为中间**必须有人看一眼**：擦除不可逆且产物是有损
重编码，而「这块字是台词还是剧情」这个判断再准也有出错的可能。scan 只写标记
不动素材，apply 才动手 —— 与 `asset_qc` 的「判定本身会出错，自动删等于让一个
不可靠的判断销毁用户资产」同一条原则。

## 时间单位（最容易错的一处）

前端的 `desub.t0/t1` 是**镜头输出秒**（与 mosaic 关键帧 tSec 同基准：已经过
speed 换算、且以取片窗口的起点为 0）。而火山要的是**被提交视频内**的秒数。

我们提交的是**整条源文件**（不切段），所以火山侧的秒数是**源文件秒**：

    源秒 = 输出秒 × speed + clip_in_sec

换算只在本文件的 `_out_to_src` / `_src_to_out` 两处，别在别处手算。

## 为什么提交整条源文件而不是只提交取片窗口

分割出来的镜头共用同一个源文件（生产上有 10 组这样共用）。只提交窗口内那一段
就得再拼回去 —— 那正是上面那个事故的来源。整条提交的代价是分割镜头会按整个
文件计费（多数镜头窗口 = 整个文件，不受影响），换来的是**没有任何拼接环节**。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid

from .db import Shot, get_session

# ⚠️ 与 subtitle_jobs.py 同一条纪律：**不在模块顶层** `from .jobs import ...`。
# 模块图必须单向（jobs 在文件末尾 → 本模块），反向只能发生在**调用时**，
# 否则谁先被 import 谁就炸。下面两个 runner 里用函数内 import 取那几个符号。

log = logging.getLogger(__name__)

#: 检测采样步进（秒）。
#:
#: 2026-11-13 从「粗筛 3–8 帧 + 命中后逐秒细扫」改成**全程固定步进**。
#: 旧方案的两级采样是为省钱设计的，但它的前提是「粗筛能先发现有没有字幕」——
#: 而粗筛本身就可能整段错过（字幕只占镜头一小段时，采样点全落在字幕之外），
#: 于是细扫根本不会被触发。用户反馈「明明有字幕却没标出来」就来自这里。
#:
#: 0.5s 是「不漏」与「不贵」的折中：拆镜给的镜头最长 30s，0.5s 步进下任何
#: 持续 ≥0.5s 的字幕都至少压中一个采样点；而 `_SHEET_N` 张拼图让每 9 帧只花
#: 一次视觉调用（实测 11 秒素材 22 个时刻只用 3 次调用，漏检 0）。
_SAMPLE_STEP_SEC = 0.5
#: 拼图：一次视觉调用看几帧（3×3）。
_SHEET_COLS, _SHEET_ROWS = 3, 3
_SHEET_N = _SHEET_COLS * _SHEET_ROWS
#: 拼图单格宽高。烧录字幕字号很大，240 宽足够辨认，再大只是浪费 token。
_TILE_W = 240
#: 框外扩多少（占画幅比例）。宁可多擦一点：过度覆盖的代价是那一小块被重绘，
#: 而漏掉半个字要整镜重来一次、再付一次钱。
_PAD_RATIO = 0.02
#: 时间边界外扩（秒）。采样是离散的，字幕真实起止必然落在两个采样点之间。
_PAD_SEC = 0.5
#: 同一镜里，两个框的**纵向**重叠比例超过这个值就算同一条字幕带（合并成一个框）；
#: 低于它（如顶部标题 + 底部字幕）分开成两块，避免把中间整片画面也框进去。
_SAME_BAND_IOU = 0.5
#: 一条字幕带至少要被几个采样点命中才保留。
#:
#: 2026-11-13 端到端实测：「离婚」素材检出 2 块，其中一块 y≈0.84、只在
#: 8.28s **一个**采样点命中 —— 那里只有人物衣袖，没有任何文字，是模型偶发
#: 的一次坐标抖动（同一张拼图重跑 2 次都不复现）。真字幕在时间上连续
#: （同一条连续命中 10 个点），偶发误报是孤点。误报的代价是火山把那块无关
#: 画面重绘一遍，所以宁可丢掉孤点。
#: 代价：持续不足约 1 秒（两个采样点）的字幕会漏 —— 那种字幕极少，且检测结果
#: 要用户核对，漏了可以「补标」手工框。
_MIN_HITS_PER_BAND = 2
#: 单镜最多保留几块。超出的丢掉并记日志 —— 一块一个时间分段，块太多说明
#: 检测在抖，硬塞进请求只会让上游拒或不按预期擦。
_MAX_REGIONS = 12
#: 新旧素材**视频流**时长容差（秒）。
#:
#: ⚠️ 必须比 video 流，**不能**比 `format=duration`：容器时长取最长的那条流，
#: 而音轨长度恒等于原片，画面被吃掉一整秒容器时长也不动 —— 旧实现就是这么
#: 让 569 条记录里的 494 条 drift 恒为 0、断言形同虚设的。
_DUR_TOLERANCE_SEC = 0.1
#: 帧数容差。火山实测逐帧守恒（265→265）；允许 1 帧的容器取整余量。
_FRAME_TOLERANCE = 1

#: 画面文字审查的 system prompt（拼图版）。
#:
#: ⚠️ **这段是实测出来的，改词前必须重跑验证。** 旧版单帧提示词在两套真实素材上
#: 共 129 次分类、误擦 0 漏擦 0，功劳集中在两条判据上，这里**原样保留**：
#:   ① 「手机屏消息会被画成悬浮气泡」—— seedance 真的会把手机上的消息渲染成
#:      悬浮在画面里的 UI 气泡而**不画手机**。只看「是否悬浮/是否像叠加层」
#:      的判据从根上不成立，必须问「它说的是不是台词」。
#:   ② 「拿不准一律 keep」—— 漏擦只是没修干净（用户再标一次即可），
#:      错擦是不可逆的破坏。两类错误的代价根本不对称。
#:
#: 2026-11-13 的改动只有输出形态：一次看 9 格、逐格给结果，判据一个字没改。
_SYS = (
    "你是视频后期的画面文字审查员。视频模型有时会擅自把台词烧进画面，需要用遮罩抹掉；"
    "但画面里也有属于剧情的文字，抹掉会永久毁掉这条片子。你来决定每块文字怎么处置。\n"
    "图是 3 列 3 行的拼图，编号 1-9：从左到右、从上到下，每格是同一镜头的不同时刻。\n"
    "对**每一格**分别判断：\n"
    "- erase：视频模型擅自烧上去的台词字幕/标题卡。它不承载剧情信息，"
    "内容通常与剧本里的某句台词逐字相同。\n"
    "- keep：剧情信息。屏幕上的消息/系统提示、招牌、报纸、文件上的字都算。\n"
    "**重要**：视频模型经常把「手机屏幕上的消息」直接画成悬浮在画面里的聊天气泡或"
    "通知条，不画手机。这种东西看起来像叠加层，但它承载剧情，必须 keep。"
    "所以**不要只看它是否悬浮**，要看它说的是不是台词。\n"
    "拿不准时一律 keep —— 漏擦只是没修干净，错擦是不可逆的破坏。\n"
    '只输出 JSON：{"tiles":[{"n":格号,"action":"erase|keep","box":[x0,y0,x1,y1],'
    '"text":"看到的文字","why":"依据"}]}\n'
    "box 用**该格内**的相对比例坐标（0..1），没有文字时给 null。每一格都要有一条。"
)


# ----------------------------------------------------------------- 纯函数

def _clamp_speed(v) -> float:
    """speed 钳制。**唯一的实现**在 `shot_timing.clamp_speed`。"""
    from .shot_timing import clamp_speed
    return clamp_speed(v)


def _out_to_src(out_sec: float, speed: float, clip_in: float) -> float:
    """镜头输出秒 → 源文件秒。**本模块唯一的正向换算点。**"""
    return max(0.0, out_sec) * speed + clip_in


def _src_to_out(src_sec: float, speed: float, clip_in: float) -> float:
    """源文件秒 → 镜头输出秒。**本模块唯一的反向换算点。**"""
    return max(0.0, (src_sec - clip_in) / speed)


def _sample_points(lo: float, hi: float) -> list[float]:
    """[lo, hi) 内的采样时刻（源秒），取每格中点。

    取中点而不是从 lo 起步：首帧常是上一镜的转场残影或黑场，末帧同理。
    """
    span = hi - lo
    if span <= 0:
        return []
    n = max(1, int(round(span / _SAMPLE_STEP_SEC)))
    return [lo + span * (i + 0.5) / n for i in range(n)]


def _parse_sheet(raw: str) -> dict[int, dict]:
    """解析拼图回复 → {格号(0-based): {action, box, text}}。

    **解析不出来就当没有文字**（返回空），与「拿不准一律 keep」同方向：
    一次读不懂的回复不该导致擦除。

    逐个 `{` 起点用 `raw_decode` 试解析，取第一个带 `tiles` 的合法对象 ——
    模型在 JSON 前后写解释、或回两版 JSON（实测常见）时，贪婪正则会截出非法串。
    """
    dec = json.JSONDecoder()
    obj = None
    i = raw.find("{")
    while i != -1:
        try:
            cand, _ = dec.raw_decode(raw, i)
        except ValueError:
            cand = None
        if isinstance(cand, dict) and "tiles" in cand:
            obj = cand
            break
        i = raw.find("{", i + 1)
    if obj is None:
        return {}
    out: dict[int, dict] = {}
    for t in (obj.get("tiles") or []):
        if not isinstance(t, dict):
            continue
        try:
            n = int(t.get("n")) - 1
        except (TypeError, ValueError):
            continue
        if not (0 <= n < _SHEET_N):
            continue
        box = t.get("box")
        rbox = None
        if isinstance(box, (list, tuple)) and len(box) == 4:
            try:
                x0, y0, x1, y1 = (max(0.0, min(1.0, float(v))) for v in box)
            except (TypeError, ValueError):
                x0 = y0 = x1 = y1 = 0.0
            if x1 - x0 > 1e-3 and y1 - y0 > 1e-3:
                rbox = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        out[n] = {"action": str(t.get("action") or "").lower(),
                  "box": rbox,
                  "text": str(t.get("text") or "").strip()}
    return out


def _cluster_boxes(hits: list[tuple[float, tuple, str]]) -> list[dict]:
    """把逐帧命中的框按**纵向位置**归成若干条字幕带。

    `hits` = [(源秒, (x0,y0,x1,y1) 比例, 文字)]，已按时间升序。

    为什么按纵向归：一镜里常见的组合是「顶部标题卡 + 底部台词字幕」。把它们
    并成一个框，等于让火山把中间整片画面都重绘一遍；分开成两块，每块只盖住
    真正有字的那一条。横向位置变化（台词长短不同、居中/靠左）**不拆分** ——
    那正是同一个字幕带，拆开只会多出没必要的分段。

    返回 [{t0, t1, x, y, w, h, text}]，时间为源秒，框已外扩。
    """
    bands: list[dict] = []
    for at, (x0, y0, x1, y1), text in hits:
        target = None
        for b in bands:
            # 纵向重叠比例（相对较短的那条），避免「细字幕被粗框吞掉」判不过
            ov = min(b["y1"], y1) - max(b["y0"], y0)
            span = min(b["y1"] - b["y0"], y1 - y0) or 1e-6
            if ov / span >= _SAME_BAND_IOU:
                target = b
                break
        if target is None:
            bands.append({"t0": at, "t1": at, "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                          "texts": [text] if text else [], "hits": 1})
        else:
            target["t0"] = min(target["t0"], at)
            target["t1"] = max(target["t1"], at)
            target["x0"] = min(target["x0"], x0)
            target["y0"] = min(target["y0"], y0)
            target["x1"] = max(target["x1"], x1)
            target["y1"] = max(target["y1"], y1)
            target["hits"] += 1
            if text:
                target["texts"].append(text)
    # 孤点带丢掉（见 `_MIN_HITS_PER_BAND`）
    return [b for b in bands if b["hits"] >= _MIN_HITS_PER_BAND]


def _bands_to_regions(bands: list[dict], lo: float, hi: float,
                      speed: float, clip_in: float) -> list[dict]:
    """字幕带 → 可落库的 `desub` 块（时间为**镜头输出秒**）。"""
    out: list[dict] = []
    for b in bands[: _MAX_REGIONS]:
        x0 = max(0.0, b["x0"] - _PAD_RATIO)
        y0 = max(0.0, b["y0"] - _PAD_RATIO)
        x1 = min(1.0, b["x1"] + _PAD_RATIO)
        y1 = min(1.0, b["y1"] + _PAD_RATIO)
        t0 = max(lo, b["t0"] - _PAD_SEC)
        t1 = min(hi, b["t1"] + _PAD_SEC)
        if t1 - t0 < 0.2 or x1 <= x0 or y1 <= y0:
            continue
        text = "；".join(dict.fromkeys(t for t in b["texts"] if t))[:120] or None
        out.append({
            "id": uuid.uuid4().hex[:8], "src": "auto", "text": text,
            "t0": round(_src_to_out(t0, speed, clip_in), 2),
            "t1": round(_src_to_out(t1, speed, clip_in), 2),
            "x": round(x0, 4), "y": round(y0, 4),
            "w": round(x1 - x0, 4), "h": round(y1 - y0, 4),
        })
    return out


def _load_meta(shot) -> dict:
    try:
        return json.loads(shot.transform_meta) if shot.transform_meta else {}
    except (ValueError, TypeError):
        return {}


def _shot_window(shot, meta: dict) -> tuple[float, float, float, float]:
    """返回 (clip_in 源秒, clip_dur 源秒, speed, duration_sec)。"""
    clip_in = float(shot.clip_in_sec or 0.0)
    clip_dur = float(shot.clip_dur_sec or 0.0) or float(shot.duration_sec or 0.0)
    return clip_in, clip_dur, _clamp_speed(meta.get("speed")), float(shot.duration_sec or 0.0)


def _write_desub(shot_id: str, mutate) -> list[dict] | None:
    """在**一个事务内**读-改-写 `transform_meta.desub`，返回新的 desub 列表。

    为什么不走 `patch_shot_timeline`：那是一条带乐观锁的 HTTP 路由，job 里
    没有 `base_transform_rev` 可带。这里用「事务内重读」换同一个保证 ——
    **只合并 `desub` 这一个键**，其余键取的是写入时刻从库里读到的值，
    所以用户在扫描期间调的裁剪/变速/马赛克不会被这条写入按旧快照盖回去。
    """
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            return None
        meta = _load_meta(shot)
        new = mutate(list(meta.get("desub") or []))
        if new:
            meta["desub"] = new
        else:
            meta.pop("desub", None)
        shot.transform_meta = json.dumps(meta, ensure_ascii=False) if meta else None
        session.commit()
        return new


# ------------------------------------------------------------- 媒体小工具

from .media import _probe_wh  # noqa: E402,F401  （转出，供既有调用方与测试使用）


def _frame_wh(src_w: int, src_h: int) -> tuple[int, int]:
    """抽帧后的宽高。与 `_grab_frames` 的 `scale` 表达式必须同步。"""
    if src_w <= _TILE_W:
        return src_w, src_h
    h = int(src_h * _TILE_W / src_w + 0.5)
    return _TILE_W, max(2, (h + 1) // 2 * 2)


async def _grab_sheet(path, src_w: int, src_h: int, times: list[float]) -> str | None:
    """把若干时刻的帧拼成一张 3×3 图，返回 data URI；失败返回 None。

    用 ffmpeg 的 `xstack` 一次拼完，不落中间帧：一次子进程、一次编码，
    比逐帧抽 + Python 拼图快一个数量级（9 帧约 0.6 秒）。

    不足 9 格时补黑格 —— 模型被要求「每一格都要给结果」，
    黑格它会给 keep，`_parse_sheet` 也天然丢弃没有框的格子。
    """
    import os
    import tempfile

    from .media import _run

    tw, th = _frame_wh(src_w, src_h)
    inputs: list[str] = []
    filt: list[str] = []
    for t in times:
        inputs += ["-ss", f"{max(0.0, t):.3f}", "-i", str(path)]
        filt.append(f"[{len(filt)}:v]scale={tw}:{th},trim=end_frame=1[f{len(filt)}]")
    while len(filt) < _SHEET_N:
        i = len(filt)
        inputs += ["-f", "lavfi", "-i", f"color=black:s={tw}x{th}:d=0.1"]
        filt.append(f"[{i}:v]trim=end_frame=1[f{i}]")
    layout = "|".join(f"{(k % _SHEET_COLS) * tw}_{(k // _SHEET_COLS) * th}"
                      for k in range(_SHEET_N))
    fc = ";".join(filt) + ";" + "".join(f"[f{k}]" for k in range(_SHEET_N)) \
        + f"xstack=inputs={_SHEET_N}:layout={layout}[o]"

    fd, tmp = tempfile.mkstemp(suffix=".jpg", prefix="fw_desub_sheet_")
    os.close(fd)
    try:
        code, _ = await _run(["ffmpeg", "-y", "-v", "error", *inputs,
                              "-filter_complex", fc, "-map", "[o]",
                              "-frames:v", "1", "-q:v", "3", tmp], timeout=180.0)
        if code != 0 or os.path.getsize(tmp) == 0:
            return None
        with open(tmp, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
    except OSError:
        return None
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ------------------------------------------------------------ scan：识别

async def _scan_one(shot_row: dict, sem, sid_job: str = "") -> tuple[str, list[dict], str | None]:
    """扫一个镜头，返回 (shot_id, 新增的 auto 区间, 错误)。"""
    from .media import _probe_duration, ensure_local_async
    from .providers.llm import LLMProvider

    sid = shot_row["id"]
    path = await ensure_local_async(shot_row["video_url"] or "")
    if path is None or not path.is_file():
        return sid, [], "素材文件不存在"

    src_w, src_h = await _probe_wh(path)
    if not src_w or not src_h:
        return sid, [], "无法读取视频尺寸"

    file_dur = await _probe_duration(path)
    clip_in, clip_dur, speed, _ = shot_row["win"]
    lo = clip_in
    hi = clip_in + clip_dur if clip_dur > 0 else file_dur
    hi = min(hi, file_dur) if file_dur > 0 else hi
    if hi - lo < 0.2:
        return sid, [], None

    llm = LLMProvider()
    # ⚠️ 局部导入不能省：本模块不许在顶层 `from .jobs import`（见文件头），
    # 而 `run_desub_scan` 里那句局部导入**管不到这个函数**。
    from .jobs import is_cancelled

    points = _sample_points(lo, hi)
    hits: list[tuple[float, tuple, str]] = []

    async def one_sheet(chunk: list[float]) -> list[tuple[float, tuple, str]]:
        async with sem:
            # 拿到槽位后再查一次取消：gather 一次性派发全部协程，
            # 入口检查在第一轮事件循环就全过了，然后堵在这把信号量上排队。
            # 不在这里补，"取消"就只是改状态位，抽帧+识别照跑照烧钱。
            if is_cancelled(sid_job):
                return []
            uri = await _grab_sheet(path, src_w, src_h, chunk)
            if not uri:
                return []
            raw = await llm.complete_vision(
                _SYS, "逐格判断，每一格都要给结果。", uri, temperature=0.0)
        tiles = _parse_sheet(raw)
        out = []
        for k, at in enumerate(chunk):
            t = tiles.get(k)
            if not t or t["action"] != "erase" or t["box"] is None:
                continue
            out.append((at, t["box"], t["text"]))
        return out

    chunks = [points[i:i + _SHEET_N] for i in range(0, len(points), _SHEET_N)]
    sheets = await asyncio.gather(*(one_sheet(c) for c in chunks),
                                  return_exceptions=True)
    oks = [s for s in sheets if not isinstance(s, Exception)]
    if not oks:
        err = next((s for s in sheets if isinstance(s, Exception)), None)
        return sid, [], f"识别失败：{str(err)[:120]}"
    for s in oks:
        hits += s
    if not hits:
        return sid, [], None
    hits.sort(key=lambda h: h[0])

    bands = _cluster_boxes(hits)
    if len(bands) > _MAX_REGIONS:
        log.warning("[desub] #%s 识别出 %d 条字幕带，截断到 %d",
                    shot_row["order"], len(bands), _MAX_REGIONS)
    return sid, _bands_to_regions(bands, lo, hi, speed, clip_in), None


def _in_scope(s: Shot, p: dict) -> bool:
    """这一镜在不在本次去字幕的范围里 —— scan 与 apply **共用这一处**。

    | payload | 含义 |
    |---|---|
    | `shot_ids`（非空） | 点名：只处理这几个 |
    | `episode` | 只处理这一集 |
    | 都没有 | 全片 |

    按集为什么不让前端展开成 shot_ids：非空 shot_ids 会被当成**定向提交**、
    跳过去重（TB-04）。在同一集上连点两次就是两批任务擦同一批镜头，
    去字幕按时长计费 → 直接翻倍。
    """
    if s.disabled:
        return False
    only = p.get("shot_ids") or []
    if only and s.id not in only:
        return False
    ep = p.get("episode")
    if ep is not None and str(ep).strip() != "" and s.episode != int(ep):
        return False
    return True


def desub_plan(session, project_id: str, kind: str, p: dict) -> list[dict]:
    """这次去字幕**实际会动哪几镜** —— scan / apply / 路由去重三处共用这一处。

    路由要在**提交前**判断"这些镜头是不是正被别的任务占着"，而 payload 里的
    `episode` / 缺省（全片）都说不清具体是哪几镜，只有展开成真实候选集才能比出交集。
    """
    want_ids = {str(x) for x in (p.get("region_ids") or []) if x}
    out: list[dict] = []
    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id, Shot.video_url.isnot(None))
            .order_by(Shot.order).all())
    for s in rows:
        if not _in_scope(s, p):
            continue
        meta = _load_meta(s)
        if kind == "desub_apply":
            # 已擦过的（appliedVersion 有值）不再提交：那笔钱已经付过了。
            todo = [r for r in (meta.get("desub") or []) if not r.get("appliedVersion")]
            if want_ids:
                todo = [r for r in todo if r.get("id") in want_ids]
            if not todo:
                continue
            out.append({"id": s.id, "order": s.order, "video_url": s.video_url,
                        "win": _shot_window(s, meta), "regions": todo})
        else:
            out.append({"id": s.id, "order": s.order, "video_url": s.video_url,
                        "win": _shot_window(s, meta)})
    return out


def desub_empty_message(kind: str, p: dict) -> str:
    """候选集为空时对用户说的那句话 —— 路由与 runner 用**同一句**。"""
    if kind == "desub_apply":
        return ("勾选的区间已经擦过，或不属于本次范围" if p.get("region_ids")
                else "没有待处理的去字幕标记。请先识别字幕，或在预览里手工框选。")
    return "没有可识别的镜头视频。请先生成镜头视频后再识别字幕。"


async def run_desub_scan(jid: str) -> None:
    """识别全片的烧录字幕，把结果写进各镜的 `transform_meta.desub`。

    payload = {"project_id": "...", "shot_ids": [...]?, "episode": int?}

    只写标记、**不动任何素材、不花火山的钱**（只花视觉模型的 token）。
    """
    from .config import get_settings
    from .jobs import _update, get_job, is_cancelled, set_job_phase

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    _update(jid, status="running", progress=1)

    with get_session() as session:
        rows = desub_plan(session, project_id, "desub_scan", p)

    if not rows:
        _update(jid, status="failed", error=desub_empty_message("desub_scan", p))
        return

    total = len(rows)
    set_job_phase(jid, {"key": "desub_scan", "label": "正在识别画面文字",
                        "done": 0, "total": total})

    # 并发沿用**已有**的 settings.default_concurrency（与自动字幕、分析类任务
    # 同一口径）。不新增开关，也不下调任何并发数。
    # ⚠️ 若这里成为瓶颈（429/限流），正确解法是加 API KEY / 提配额，不是降并发。
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    done = 0
    found = 0
    shots_hit = 0
    errors: list[str] = []
    lock = asyncio.Lock()

    async def one(row: dict) -> None:
        nonlocal done, found, shots_hit
        try:
            sid, regions, err = await _scan_one(row, sem, jid)
            if err:
                async with lock:
                    errors.append(f"#{row['order']} {err}")
            elif regions:
                def mutate(old: list[dict]) -> list[dict]:
                    # 保留手工标的与**已擦过的**（appliedVersion 有值），
                    # 只替换上一轮自动识别且还没执行的 —— 重扫不该把用户
                    # 自己框的那些冲掉，也不该让已经花过钱的记录复活。
                    keep = [r for r in old
                            if r.get("src") != "auto" or r.get("appliedVersion")]
                    return keep + regions
                _write_desub(sid, mutate)
                async with lock:
                    found += len(regions)
                    shots_hit += 1
        except Exception as e:                       # noqa: BLE001
            log.warning("[desub] 扫描失败 %s: %s", row["id"], e)
            async with lock:
                errors.append(f"#{row['order']} {str(e)[:100]}")
        finally:
            async with lock:
                done += 1
                set_job_phase(jid, {"key": "desub_scan", "label": "正在识别画面文字",
                                    "done": done, "total": total})
                _update(jid, progress=max(1, min(98, int(done / total * 100))))

    await asyncio.gather(*(one(r) for r in rows))
    set_job_phase(jid, None)

    result = json.dumps({"scanned": total, "shots_hit": shots_hit,
                         "regions": found, "failed": len(errors)},
                        ensure_ascii=False)
    # 全军覆没要报失败：一个绿色的"已完成"配一条空清单，用户既不知道失败了，
    # 也不知道该重试（与 run_auto_subtitles 同一条口径）。
    if errors and len(errors) == total:
        _update(jid, status="failed", progress=100, result=result,
                error=f"识别失败：{'；'.join(errors[:3])}")
        return
    _update(jid, status="done", progress=100, result=result,
            error=(f"{len(errors)}/{total} 镜识别失败：{'；'.join(errors[:3])}"
                   if errors else None))


# ----------------------------------------------------------- apply：执行

async def _apply_one(row: dict) -> dict:
    """处理一个镜头：整条送火山擦，落新版本。返回 {"ok":bool, "note":str, ...}。"""
    from datetime import datetime, timezone

    from .db import ShotVersion
    from .media import (_probe_duration, _probe_wh, ensure_local_async,
                        make_thumb, probe_video_frames)
    from .providers.mediakit_erase import MediaKitEraseProvider

    sid = row["id"]
    src = await ensure_local_async(row["video_url"] or "")
    if src is None or not src.is_file():
        return {"ok": False, "note": "素材文件不存在"}

    file_dur = await _probe_duration(src)
    src_w, src_h = await _probe_wh(src)
    if not src_w or not src_h or file_dur <= 0:
        return {"ok": False, "note": "无法读取源视频信息"}

    clip_in, clip_dur, speed, _dur = row["win"]

    # 输出秒 → 源秒（我们提交的是整条源文件，见文件头）
    regs = []
    for r in sorted(row["regions"], key=lambda x: float(x.get("t0") or 0.0)):
        a = max(0.0, min(file_dur, _out_to_src(float(r.get("t0") or 0.0), speed, clip_in)))
        b = max(0.0, min(file_dur, _out_to_src(float(r.get("t1") or 0.0), speed, clip_in)))
        if b - a < 0.05:
            continue
        regs.append({"t0": a, "t1": b,
                     "x": float(r.get("x") or 0.0), "y": float(r.get("y") or 0.0),
                     "w": float(r.get("w") or 0.0), "h": float(r.get("h") or 0.0)})
    if not regs:
        return {"ok": False, "note": "区间换算后为空"}

    provider = MediaKitEraseProvider()
    if not provider.available:
        return {"ok": False, "note": "未配置火山 MediaKit 通道（FW_MEDIAKIT_API_KEY）"}

    r = await provider.erase(row["video_url"], regs, dur=file_dur)
    if not r.get("ok"):
        return {"ok": False, "note": r.get("error") or "擦除失败"}

    new_url = r["video_url"]
    new_path = await ensure_local_async(new_url)
    if new_path is None:
        return {"ok": False, "note": "擦除产物落盘失败"}

    # ---- 产物校验：比**视频流**，不是容器时长 ----
    # 容器时长 = 最长的那条流。音轨长度恒等于原片，画面被吃掉一整秒容器时长
    # 也不动 —— 旧实现就是这么让断言形同虚设的（569 条里 494 条 drift=0）。
    old_v, old_f = await probe_video_frames(src)
    new_v, new_f = await probe_video_frames(new_path)
    if old_v <= 0 or new_v <= 0:
        return {"ok": False, "note": "读不出视频流时长，无法校验"}
    if abs(new_v - old_v) > _DUR_TOLERANCE_SEC:
        return {"ok": False,
                "note": f"产物视频时长与原片不符（{old_v:.2f}s → {new_v:.2f}s），"
                        "已丢弃这次的产物"}
    if old_f > 0 and new_f > 0 and abs(new_f - old_f) > _FRAME_TOLERANCE:
        return {"ok": False,
                "note": f"产物帧数与原件不符（{old_f} → {new_f}），已丢弃这次的产物"}

    thumb = await make_thumb(new_url, at_sec=max(0.0, clip_in) + 0.5)

    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return {"ok": False, "note": "镜头已不存在"}
        last = (session.query(ShotVersion).filter(ShotVersion.shot_id == sid)
                .order_by(ShotVersion.version_no.desc()).first())
        if last is None:
            # 当前成片**没有任何版本记录** —— 全库约 1%（手工上传的素材、
            # 早于版本机制的历史数据）。不先把原片存成一版，面板与二次确认里
            # 「原片保留、随时可在版本区切回」对那 1% 就是空话：擦完原片只剩
            # 一个 url，界面上点不到。擦除又是不可逆的，等发现就晚了。
            session.add(ShotVersion(
                id=uuid.uuid4().hex[:16], shot_id=sid, version_no=1,
                video_url=row["video_url"], thumb_url=shot.thumb_url,
                model_id="original", prompt=None,
                meta=json.dumps({"note": "去字幕前的原片（补录）"},
                                ensure_ascii=False),
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ))
            vno = 2
        else:
            vno = last.version_no + 1
        session.add(ShotVersion(
            id=uuid.uuid4().hex[:16], shot_id=sid, version_no=vno,
            video_url=new_url, thumb_url=thumb, model_id="desub", prompt=None,
            meta=json.dumps({"regions": [{"t": [round(x["t0"], 2), round(x["t1"], 2)],
                                          "box": [x["x"], x["y"], x["w"], x["h"]]}
                                         for x in regs],
                             "region_ids": sorted({str(rr.get("id")) for rr in row["regions"]
                                                   if rr.get("id")}),
                             "apply_mode": r.get("mode"),
                             "src_video_url": row["video_url"],
                             "src_video_sec": round(old_v, 3),
                             "task_id": r.get("task_id"),
                             "elapsed_sec": r.get("elapsed")},
                            ensure_ascii=False),
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ))
        shot.video_url = new_url
        shot.thumb_url = thumb or shot.thumb_url
        # 换了 video_url 就必须把 adopted_version 指过来，理由同 jobs.py:1479
        # 「生成即默认采用」：版本区判断「当前」用的就是这个字段。
        shot.adopted_version = vno
        # 给已处理的块写回 appliedVersion：前端据此画灰、不再计费、不再重复提交。
        meta = _load_meta(shot)
        applied = {str(rr.get("id")) for rr in row["regions"] if rr.get("id")}
        meta["desub"] = [({**rr, "appliedVersion": vno}
                          if str(rr.get("id")) in applied else rr)
                         for rr in (meta.get("desub") or [])]
        shot.transform_meta = json.dumps(meta, ensure_ascii=False)
        session.commit()

    # 用量（P0 统计）：按被处理素材时长记账
    from . import usage as _usage
    _usage.record("desub", model_id="mediakit-erase-pro", channel="mediakit",
                  media_seconds=round(file_dur, 2), cost_fen=0,
                  meta={"shot_id": sid, "version": vno, "mode": r.get("mode")})

    return {"ok": True, "version": vno, "billed_sec": round(file_dur, 2),
            "note": f"{r.get('mode')} · {r.get('elapsed')}s"}


async def run_desub_apply(jid: str) -> None:
    """把确认过的去字幕块真正执行掉：整条送火山擦，落新版本。

    payload = {"project_id": "...", "shot_ids": [...]?, "episode": int?, "region_ids": [...]?}

    ⚠️ 这条 job **会花钱**（火山按处理的视频时长计费），且产物是有损重编码。
    原片保留在 `ShotVersion` 里可随时切回，但"擦掉的字回不来"是事实 ——
    所以前端必须先让用户逐条核对、再弹一次确认。

    ## 为什么改并行

    火山精细版很慢（11 秒片实测 345 秒）。旧实现对第三方串行，是为了"出错时
    立刻停下来、别把整批都刷出去"；但火山是**提交即派发、失败可查**的异步任务，
    串行只会让 30 镜的一集从几十分钟拖到几小时。
    并发沿用 `settings.default_concurrency`，不新增也不下调任何并发常量。
    """
    from .config import get_settings
    from .jobs import _update, get_job, is_cancelled, set_job_phase

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    _update(jid, status="running", progress=1)

    with get_session() as session:
        rows = desub_plan(session, project_id, "desub_apply", p)

    if not rows:
        _update(jid, status="failed", error=desub_empty_message("desub_apply", p))
        return

    total = len(rows)
    set_job_phase(jid, {"key": "desub_apply", "label": "正在去除画面字幕",
                        "done": 0, "total": total})

    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    okn = 0
    billed = 0.0
    notes: list[str] = []
    cancelled_early = False
    done = 0
    lock = asyncio.Lock()

    async def one(row: dict) -> None:
        nonlocal okn, billed, done, cancelled_early
        try:
            async with sem:
                # 拿到槽位后再查一次取消：gather 一次性派发全部协程，
                # 入口检查第一轮全过，之后全堵在这把信号量上。
                if is_cancelled(jid):
                    return
                r = await _apply_one(row)
            async with lock:
                if r.get("ok"):
                    okn += 1
                    billed += float(r.get("billed_sec") or 0.0)
                else:
                    notes.append(f"#{row['order']} {r.get('note')}")
        except Exception as e:                       # noqa: BLE001
            log.warning("[desub] 执行失败 %s: %s", row["id"], e)
            async with lock:
                notes.append(f"#{row['order']} {str(e)[:100]}")
        finally:
            async with lock:
                done += 1
                set_job_phase(jid, {"key": "desub_apply", "label": "正在去除画面字幕",
                                    "done": done, "total": total})
                _update(jid, progress=max(1, min(98, int(done / total * 100))))

    if is_cancelled(jid):
        cancelled_early = True
    else:
        await asyncio.gather(*(one(r) for r in rows))
        cancelled_early = is_cancelled(jid)

    set_job_phase(jid, None)
    result = json.dumps({"total": total, "done": okn,
                         "failed": total - okn, "billed_sec": round(billed, 1)},
                        ensure_ascii=False)
    if cancelled_early:
        # 裸 return，不写 status：_update 对已取消的任务会保留 cancelled，
        # 这里再写 done/failed 会让用户看到"我明明取消了，它却显示已完成"。
        _update(jid, progress=100, result=result,
                error=f"已取消：完成 {okn}/{total} 镜，其余未提交")
        return
    if okn == 0:
        _update(jid, status="failed", progress=100, result=result,
                error=f"去字幕失败：{'；'.join(notes[:3])}")
        return
    _update(jid, status="done", progress=100, result=result,
            error=("；".join(notes[:3]) + "，其余已完成") if notes else None)
