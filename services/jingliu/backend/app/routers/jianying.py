"""导出剪映草稿（镜流 ShotFlow 的交付通道）。

## 这是什么

把一集的镜头、配音、字幕排成一份**剪映草稿工程**，用户装进剪映后
时间轴上已经按顺序摆好，可以直接继续剪。

与"渲染成片"的区别：**一次转码都不做**。片段的入出点写进草稿 JSON，
剪映自己去读源文件那一段——所以没有画质损失，导出耗时只剩下载。

## 实测约束（剪映 10.9.0 / 11.5.0 两版验过，含 601 镜规模）

1. **剪映不热扫描草稿目录**：运行中导入的草稿在草稿箱里不出现。
   → 导入器在写草稿前接管剪映进程（关掉→写完→拉起来，冷启动必重扫），
     用户不用再手动"先退出剪映"。详见 `jianying_pack/scripts/_jyproc.ps1`。
2. **剪映显示的是素材名，不是轨道名**（`tracks[].name` 被忽略）。
   → 文件名按 `shot_id` 稳定（重新生成时原地覆盖，用户的工程不用重导），
     `material_name` 单独给人类可读的 `E01-S003`。两者刻意解耦。
3. **排片段必须全程整数微秒**，且下一条的起点直接取上一条的终点。
   按秒算再各自四舍五入会让相邻片段差 1 微秒地重叠，草稿库会当场拒收；
   真到了剪映里则是两条字幕抢同一帧，更难查。
4. **封面帧必须写**：某些版本缺封面会直接报"内容已损坏"，看起来像加密问题，
   其实不是。
5. `draft_content.json` 与 `draft_info.json` **两份同内容都写**：6.0 起主文件
   改了名，各版本读哪个没有权威说法，几十 KB 换掉一整轮往返。

## 为什么路径是占位符

草稿里的素材路径必须是**用户本机的绝对路径**且用正斜杠。服务端不可能知道
那是什么，所以这里写占位符，由导入器在用户机器上回填。
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access
from ..db import AudioClip, Shot, SubtitleClip, Project, get_session
from ..media import DATA_DIR
from ..shot_timing import (shot_output_sec, shot_source_window, shot_speed,
                           subtitle_output_span)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v2", tags=["jianying"])

#: 导出包的落盘位置。挂在 /fw/media 下，前端直接给下载链接。
EXPORT_DIR = DATA_DIR / "exports" / "jianying"

#: 导入器在用户机器上回填的占位符（三个名字空间分开，别混用）
MAT_TOKEN = "__SFMAT__"      # → 本机素材目录
DRAFT_TOKEN = "__SFDRAFT__"  # → 本机的这个草稿目录
ROOT_TOKEN = "__SFROOT__"    # → 本机的草稿根目录

#: 单文件导入器里的下载地址占位符。
#:
#: 和上面三个不是一回事：那三个是**草稿 JSON 里**的路径占位符，由导入器回填；
#: 这一个是**脚本自身**里的地址占位符，由服务端出脚本时填好。
#: 分开命名，免得哪天有人以为它们要一起替换。
URL_TOKEN = "__SF_PACK_URL__"

#: 单文件导入器必须与产包时写进 manifest 的 token 完全一致。
#: 两边漂移的表现是"导进去了但素材全部丢失"，且不报错——所以在这里断言。
assert (MAT_TOKEN, DRAFT_TOKEN, ROOT_TOKEN) == (
    "__SFMAT__", "__SFDRAFT__", "__SFROOT__")

#: 导入器脚本在包里的相对路径。zip 形态和单文件形态用**同一份源文件**，
#: 不允许各写一份：那种复制迟早会漂移，而漂移的表现是其中一条通道静默失效。
PACK_SCRIPT_REL = "scripts/import.ps1"
PACK_MODULE_REL = "scripts/_jyproc.ps1"

#: 剪映草稿工程的帧率。素材是 24/25/30 帧，剪映按工程帧率重采样播放；
#: 60 帧让时间轴能落在半帧位置（慢放、卡点更细）。不转码，不影响素材大小与导出耗时。
DRAFT_FPS = 60

#: 导出包保留时长。到点即删（用户裁定，2026-09-24）。
#:
#: 能这么短是因为这个 zip 是**纯粹的中间产物**：几十 KB 的草稿 JSON + 清单 +
#: 导入器脚本，里面没有任何素材（素材由导入器按清单从 /fw/media 现下）。
#: 用户下完就没用了，再要随时可以零成本重出一份。
#:
#: ⚠️ 正在被下载的包删掉**不会**中断那次下载：Linux 上只要还有打开的文件描述符，
#: 数据就活着，unlink 只是摘掉目录项。所以不必为"正在下"做特殊处理。
EXPORT_TTL_SEC = 30 * 60


def sweep_exports(ttl_sec: int = EXPORT_TTL_SEC) -> dict:
    """删掉超过 TTL 的导出包。返回 {removed, bytes}，由常驻巡检按轮调用。

    只删 `exports/jianying/` 下的 `*.zip` 与 `*.bat`，**不碰 generated/ 与
    uploads/**—— 那两个目录是不可再生的（花钱生成的图与视频、用户上传的素材），
    与这里按时清理的中间产物是两回事，判据不能混。

    ⚠️ 后缀必须把 `*.bat` 算进来：单文件导入器就是 `.bat`，漏掉它的话这类
    产物会在盘上无限堆积——而它恰恰是默认形态，漏掉的就是绝大多数。

    单次失败只记日志不抛：清理挡不住业务，但要留下痕迹。
    """
    import time

    if not EXPORT_DIR.exists():
        return {"removed": 0, "bytes": 0}
    cutoff = time.time() - ttl_sec
    removed, freed = 0, 0
    for f in list(EXPORT_DIR.glob("*.zip")) + list(EXPORT_DIR.glob("*.bat")):
        try:
            st = f.stat()
            if st.st_mtime >= cutoff:
                continue
            f.unlink()
            removed += 1
            freed += st.st_size
        except FileNotFoundError:
            continue        # 并发下已被别人删了，不是错
        except OSError:
            logger.exception("[export] 清理失败: %s", f.name)
    # 产包中途崩溃会留下半截目录（正常路径 finally 已 rmtree）。
    # 同样按 TTL 收，否则它们永远留在盘上且没人会想起来。
    for d in EXPORT_DIR.iterdir() if EXPORT_DIR.exists() else []:
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    if removed:
        logger.info("[export] 清理 %d 个过期导出包，释放 %.1f MB",
                    removed, freed / 1024 / 1024)
    return {"removed": removed, "bytes": freed}

CANVAS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080),
          "4:3": (1440, 1080), "3:4": (1080, 1440)}

#: 剪映草稿里 `texts[].content.styles[].size` 与项目字幕字号（1920 基准像素）的换算。
#:
#: 标定依据不是猜的：`/root/jy-spike` 下真实剪映草稿里，默认样式
#: （fontSize=48、bottom、marginV=60）落成 `size: 8.0` + `transform: {y: -0.72}`。
#: 剪映的 size 是**无单位相对值**，只在这套标定下才与像素对得上；
#: 换画幅（横屏）时不要重算 —— 剪映按画布比例自己缩放，这里管的是字号比例。
_SIZE_AT_48PX = 8.0
_FONT_BASE_PX = 48.0
#: 垂直位移的单位是**半个画布高**（pyJianYingDraft `ClipSettings.transform_y`）。
#: 标定点：bottom + marginV=60 → `-0.72`（上面那份真实草稿）。
#: 负值朝画面底部（pyJianYingDraft 的 docstring 自己写着"剪映导入的字幕似乎取
#: 此值为 -0.8"），所以 marginV 越大越靠近中线，位移往 0 走。
_Y_AT_60 = -0.72
_Y_HALF_CANVAS = 960.0
#: 画布半宽（9:16 的 1080 宽 → 540）。`transform_x` 的单位是**半个画布宽**，
#: 与 `_Y_HALF_CANVAS` 同构。横画幅时剪映按画布比例自己缩放，不用重算。
_HALF_CANVAS_W = 540.0


def _text_style(proj) -> dict:
    """项目字幕样式 → 剪映 TextStyle 的参数。

    读 `Project.default_profile.subtitle_style`（与「烧录 / 预览」同一份，
    见 routers/subtitle.py 的 get_project_subtitle_style）。**没设过就用默认值**，
    与桌面端 `BASE_STYLE` 一致。

    ⚠️ 2026-10-23 之前这里是硬编码 `size=8.0` / `transform_y=-0.72`，
    用户在交付页把字号改成 10、位置调过之后，导出仍然是默认样式 ——
    界面上的设置与成片对不上，而且没有任何提示。现在改成读项目设置。

    ⚠️ **不认识的键一律忽略**：样式是用户/前端写入的自由 JSON，
    多一个字段不应该让整份导出失败。
    """
    from ..db import profile_of

    st = {}
    try:
        raw = profile_of(proj).get("subtitle_style")
        if isinstance(raw, dict):
            st = raw
    except Exception:  # noqa: BLE001 — 坏档案不该让导出挂掉
        st = {}

    try:
        font_px = float(st.get("fontSize") or _FONT_BASE_PX)
    except (TypeError, ValueError):
        font_px = _FONT_BASE_PX
    # 下限 8px、上限 200px：再小看不清、再大一屏一个字
    font_px = min(200.0, max(8.0, font_px))

    color = st.get("color")
    rgb = _css_rgb(color) or (1.0, 1.0, 1.0)

    try:
        stroke_px = float(st.get("strokeWidth")
                          if st.get("strokeWidth") is not None else 4.0)
    except (TypeError, ValueError):
        stroke_px = 4.0
    # 剪映 TextBorder.width 与 size 不同量纲（旧代码写死 40 对应 strokeWidth=4），
    # 这里按 10 倍换算再夹到合法区间。
    border_w = min(120.0, max(0.0, stroke_px * 10.0))

    pos = str(st.get("position") or "bottom")
    try:
        margin = float(st.get("marginV") if st.get("marginV") is not None else 60.0)
    except (TypeError, ValueError):
        margin = 60.0
    margin = min(_Y_HALF_CANVAS, max(0.0, margin))
    # 从标定点线性外推：marginV 每多 1px，字幕离边远 1px，即位移变化 1/960。
    shift = (_Y_AT_60 + (margin - 60.0) / _Y_HALF_CANVAS)
    if pos == "top":
        ty = -shift                    # 顶部是底部的镜像
    elif pos == "center":
        ty = 0.0                       # 居中时 marginV 无意义
    else:
        ty = shift
    ty = min(0.98, max(-0.98, ty))

    return {
        "size": round(font_px * (_SIZE_AT_48PX / _FONT_BASE_PX), 3),
        "color": rgb,
        "bold": bool(st.get("bold")),
        "stroke_width": border_w,
        "transform_y": round(ty, 4),
    }


def _css_rgb(css) -> tuple[float, float, float] | None:
    """`#rgb` / `#rrggbb` / `rgb(...)` → 0..1 的三元组。认不出返回 None。

    剪映只吃 0..1 的 RGB 三元组；用户样式里存的是 CSS 颜色字符串
    （见桌面端 `toAssColour` 同一套输入）。这里只做最小解析，
    不引入颜色库 —— 认不出就回落白色，不抛。
    """
    if not isinstance(css, str):
        return None
    s = css.strip().lower()
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c + c for c in h)
        if len(h) not in (6, 8) or any(c not in "0123456789abcdef" for c in h):
            return None
        return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)
    m = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", s)
    if m:
        return tuple(min(255, int(x)) / 255 for x in m.groups())  # type: ignore[return-value]
    return None


#: 「内容由AI生成」角标（AI 生成内容标识）的默认值。
#:
#: 2026-10-23 用户要求：屏幕右下角固定一行小字。此前**整个系统里没有这个功能**
#: （全库搜不到任何水印/角标实现），所以 agent 只能回一句"仍需补加"。
#:
#: 做成**可配置**而不是写死，因为：字号/文案会因平台规范变（有的平台要求
#: "AI生成"、有的要求完整句），而写死之后每次都得改代码发版。
#: 存在 `Project.default_profile.ai_label` 里，与 subtitle_style 同款，
#: 不加列、不用 migration。
_AI_LABEL_DEFAULT = {
    "enabled": False,          # 默认关：不是所有片子都需要
    "text": "内容由AI生成",
    "fontSize": 30.0,          # 1920 基准像素（与 subtitle_style 同一坐标系）
    "color": "#FFFFFF",
    "opacity": 0.75,
    "marginX": 48.0,           # 距右边缘（1920 基准像素）
    "marginY": 64.0,           # 距下边缘
}


def _ai_label(proj) -> dict | None:
    """读项目的 AI 角标配置。没开就返回 None（= 不生成这条轨）。

    ⚠️ 与 `_text_style` 不同，这里**默认关闭**：加一条常驻文字轨会改变
    用户已经导出的草稿，那是他们没要求的变更。
    """
    from ..db import profile_of

    cfg = dict(_AI_LABEL_DEFAULT)
    try:
        raw = profile_of(proj).get("ai_label")
        if isinstance(raw, dict):
            cfg.update({k: v for k, v in raw.items() if k in cfg})
    except Exception:  # noqa: BLE001 — 坏档案不该让导出挂掉
        return None

    if not cfg.get("enabled"):
        return None

    text = str(cfg.get("text") or "").strip()
    if not text:
        return None            # 打开了但文案是空 —— 当成不要

    try:
        font_px = float(cfg.get("fontSize") or _AI_LABEL_DEFAULT["fontSize"])
    except (TypeError, ValueError):
        font_px = _AI_LABEL_DEFAULT["fontSize"]
    # 角标是"小字"，上限比字幕收得更紧：超过 60px 就不叫小字了
    font_px = min(60.0, max(12.0, font_px))

    try:
        margin_x = float(cfg.get("marginX") if cfg.get("marginX") is not None
                         else _AI_LABEL_DEFAULT["marginX"])
    except (TypeError, ValueError):
        margin_x = _AI_LABEL_DEFAULT["marginX"]
    try:
        margin_y = float(cfg.get("marginY") if cfg.get("marginY") is not None
                         else _AI_LABEL_DEFAULT["marginY"])
    except (TypeError, ValueError):
        margin_y = _AI_LABEL_DEFAULT["marginY"]
    margin_x = min(_Y_HALF_CANVAS, max(0.0, margin_x))
    margin_y = min(_Y_HALF_CANVAS, max(0.0, margin_y))

    try:
        alpha = float(cfg.get("opacity") if cfg.get("opacity") is not None else 0.75)
    except (TypeError, ValueError):
        alpha = 0.75
    alpha = min(1.0, max(0.0, alpha))

    return {
        "text": text,
        "size": round(font_px * (_SIZE_AT_48PX / _FONT_BASE_PX), 3),
        "color": _css_rgb(cfg.get("color")) or (1.0, 1.0, 1.0),
        "alpha": alpha,
        # 位移单位是**半个画布**。右下角：x 往右为正、y 往下为负
        # （与字幕同一个坐标系，见 `_Y_AT_60`），再各留一点边距。
        "transform_x": round(min(1.0, margin_shift_x(margin_x)), 4),
        "transform_y": round(max(-1.0, -margin_shift_y(margin_y)), 4),
    }


def margin_shift_x(margin_px: float) -> float:
    """右边距（1920 基准像素）→ `transform_x` 的位移量。

    画布半宽 540（9:16 的 1080 宽）；从右边缘往左退 `margin_px` 像素，
    换算成"半个画布宽"就是 `1 - margin/540`。margin=0 时落在右边缘。
    """
    return 1.0 - (margin_px / _HALF_CANVAS_W)


def margin_shift_y(margin_px: float) -> float:
    """底边距（1920 基准像素）→ `transform_y` 的位移量（负 = 朝下）。

    半高 960；margin=0 时落在下边缘（-1.0）。与 `_Y_AT_60` 的标定同一坐标系。
    """
    return 1.0 - (margin_px / _Y_HALF_CANVAS)


class ExportReq(BaseModel):
    episode: int | None = None      # 不给则整个项目一份草稿
    burn_subtitle: bool = False     # 预留：当前一律走可编辑文本轨
    #: 产出自包含的单文件 .bat 导入器，而不是 zip 包。
    #: 用户双击即导入，省掉"下载→解压→双击"里的解压那一步。
    single_file: bool = False
    #: `edit`（默认）= 剪辑版：只含**启用中**的镜头，带变速/取片窗口/配音/
    #:                字幕/音效/AI 标识，按成片顺序排列。
    #: `raw` = **原片**：全部镜头按原速、整条素材、不带任何音轨字幕标识。
    #:          剪辑改坏了、想回到最初素材时用这个（2026-10-24 用户要求）。
    mode: str = "edit"


def _us(sec: float) -> int:
    """秒 → 微秒。剪映的时间单位。"""
    return int(round(sec * 1_000_000))


def _local(url: str) -> Path | None:
    """/fw/media/generated/x.mp4 → 磁盘绝对路径；不是媒体地址则 None。

    ⚠️ 素材进桶后本地盘是缓存，这里**不检查文件是否存在**——存在性与元数据
    改由 `media_objects` 台账回答（见 `_material_meta`）。原来的 `p.exists()`
    会让被淘汰的素材在导出时静默消失：草稿照样生成、报"成功"，用户装进剪映
    才发现整条时间轴是空的。
    """
    if not url or "/fw/media/" not in url:
        return None
    return DATA_DIR / url.split("/fw/media/", 1)[1]


def _stub_material(cls, path: str, name: str, meta: dict, fallback_us: int):
    """不读本地文件，直接用台账元数据造一个素材对象。

    `pyJianYingDraft` 的 VideoMaterial / AudioMaterial 构造函数会
    `os.path.exists` + ffprobe，素材在桶里时那条路走不通。但它们本身是**普通
    对象**，字段都是公开的，绕过 __init__ 自己填即可——比把几十 GB 拉回本地
    只为读几个数字合理得多。

    时长缺失时退回调用方给的排期时长：宁可时间轴上这一段长度稍有出入，
    也不能让整次导出失败。
    """
    import uuid as _uuid

    m = object.__new__(cls)
    m.material_id = _uuid.uuid4().hex
    m.material_name = name
    m.path = path
    m.duration = int(meta.get("duration_us") or fallback_us or 1_000_000)
    if cls.__name__ == "VideoMaterial":
        m.local_material_id = ""
        m.width = int(meta.get("width") or 1080)
        m.height = int(meta.get("height") or 1920)
        m.material_type = "photo" if Path(path).suffix.lower() in {
            ".png", ".jpg", ".jpeg", ".webp"} else "video"
        from pyJianYingDraft import CropSettings
        m.crop_settings = CropSettings()
    return m



def _pub(url: str) -> str:
    """相对地址 → 公网绝对地址。

    库里存的恒是 `/fw/media/...`（与环境无关），导入器跑在用户机器上，
    必须给它能直接下载的绝对地址。`media_base` 已经按 env 把环境前缀算好了
    （dev → /fw，prod → /fwp），不能自己拿 public_base_url 拼——
    prod 拼出来会指向 dev 后端，文件不在那边，必 404。
    """
    from ..config import get_settings
    base = get_settings().media_base.rstrip("/")
    rel = url.split("/fw/", 1)[1] if url.startswith("/fw/") else url.lstrip("/")
    return f"{base}/{rel}"


def _shot_dur_us(s: Shot) -> int:
    """这一镜在**源文件**里取多长（微秒）。变速前。

    有裁剪就用裁剪时长，否则用整条时长；都没有时给个 5 秒兜底——
    返回 0 会让后面的片段全部叠在同一时刻上。

    ⚠️ 这是源窗口长度，**不是时间轴占用**。占用要再除速度（`_shot_out_us`）。
    两个数混用是"设了变速但时间轴长度不变"的根因。
    """
    return _us(shot_source_window(s)[1])


def _shot_out_us(s: Shot, file_dur: float | None = None) -> int:
    """这一镜在**成片里**占多久（微秒）= 源窗口 / 速度。

    时间轴推进、字幕锚点、音效锚点全用它；`t += 源时长` 会让一个 2 倍速
    的镜头后面留下等长的空洞。
    """
    return _us(shot_output_sec(s, file_dur))


def detached_shot_ids(auds) -> set[str]:
    """这些镜头的**视频自带音轨要置零** —— 它们的声音已经单独在音频轨上了。

    判据是**存在性**，不是某个持久化标记（沿用桌面端渲染器的口径，
    见 `desktop/src/render/normalize.ts` 的 `detachedShotIds`）：

      · `kind="shot"`      —— 用户手动「提取镜头原声」剥出来的
      · `kind="narration"` —— 解说剧按剧本切出来的旁白，
                              **画面原声本就不该出声**（那是模型自己发挥的人声）

    用存在性驱动而不是给 `Shot` 加一个 `muted` 列，是为了不出现
    "音频段删了但视频还是哑的"这种两处状态不同步：删掉音频段，声音自动回来。

    ⚠️ `status == "done"` 是必要条件：还在合成中/失败的旁白**不能**让画面静音，
    否则用户会得到"画面哑了、旁白也没出来"的一片死寂。
    """
    return {(a.source_shot_id or "") for a in (auds or [])
            if a.kind in ("shot", "narration") and a.source_shot_id
            and (a.status or "") == "done"}


def _build(session, proj: Project, shots: list[Shot],
           auds: list[AudioClip], subs: list[SubtitleClip], name: str,
           *, raw: bool = False) -> dict:
    """排出一份草稿。返回 {script, manifest, cover_src}。

    ## `raw=True`：导出**原片**

    2026-10-24 用户要求两个导出按钮：「一个导出是剪辑过的，另一个导出是纯粹的
    视频原片」。原片模式下同一份 `_build` 走不同的口径：

      · **原速**（speed=1.0）：把"我调过 1.7 倍"这个改动也去掉；
      · **整条素材**（入点 0、时长=素材全长）：把取片窗口/裁剪也去掉；
      · **不带音轨字幕标识**：`auds` / `subs` 由调用方传空，`ai_label` 这里跳过。

    为什么复用同一个函数而不是另写一份：两条路的素材登记、台账查询、
    素材缺失跳过、封面兜底、时间轴推进这些**必须一致**，抄一份必然漂移。
    差异只在"每一镜怎么播"这一处，所以做成参数而不是分支函数。
    """
    import pyJianYingDraft as draft
    from pyJianYingDraft import Timerange, TrackType

    w, h = CANVAS.get(proj.base_aspect or "9:16", (1080, 1920))
    # 工程帧率 60（2026-10-21 用户要求）。素材本身是 24/25/30 帧，剪映按工程帧率
    # 重采样播放——时间轴因此可以落在半帧位置（慢放、卡点更细）。
    # ⚠️ 这是**草稿工程**的属性，不是素材的帧率：草稿不做转码，片段仍是源文件，
    #    所以不会因帧率翻倍而变大或变慢导出。用户要的正是这一条。
    script = draft.ScriptFile(w, h, DRAFT_FPS)
    script.add_track(TrackType.video)

    manifest: list[dict] = []
    seen: set[str] = set()

    # 素材元数据一次性查出来。进桶之后本地文件可能已被淘汰，宽高/时长/大小
    # 一律以台账为准；台账里没有的（还没轮到补传）再退回读本地文件。
    from ..media_cache import meta_of, probe_meta
    _rels: list[str] = []
    for _u in ([s.video_url for s in shots] + [a.url for a in auds]):
        if _u and "/fw/media/" in _u:
            _rels.append(_u.split("/fw/media/", 1)[1])
    _meta = meta_of(_rels)

    def _material_meta(p: Path, url: str) -> dict:
        rel = url.split("/fw/media/", 1)[1] if "/fw/media/" in url else ""
        m = _meta.get(rel)
        if m and m.get("size"):
            return m
        if p.is_file():                      # 台账还没记上，但本地有原件
            m2 = probe_meta(p)
            m2["size"] = p.stat().st_size
            return m2
        return {}

    def want(url: str, fname: str) -> tuple[Path, dict] | None:
        """登记一条要下载的素材，返回 (服务端路径, 元数据)。

        路径只用于把草稿里的绝对路径替换成占位符，**不要求文件真的在本地**。
        """
        p = _local(url)
        if p is None:
            return None
        meta = _material_meta(p, url)
        if not meta.get("size"):
            # 台账没有、本地也没有 = 这条素材当前无从获取。跳过而不是让导入器
            # 拿着一个 404 地址空跑一遍。
            logger.warning("[export] 素材不可用，已跳过: %s", url)
            return None
        if fname not in seen:
            seen.add(fname)
            # `_local` 只在服务端内部用（把草稿里的服务器路径换成占位符+目标文件名），
            # 写进 manifest.json 之前会被剔掉。
            manifest.append({"url": _pub(url), "name": fname,
                             "size": meta["size"], "_local": str(p)})
        return p, meta

    # ---- 视频轨：按 order 首尾相接；入出点交给剪映，不转码 ----
    t = 0
    starts: dict[int, int] = {}          # shot.order → 时间轴起点（微秒）
    cover_src: Path | None = None
    #: 视频自带音轨**会被置零**的镜头 id。见下方 detached 集合的说明。
    muted_shot_ids = detached_shot_ids(auds)
    #: 所有素材都已被淘汰到桶里时的封面兜底来源（url, 目标路径）。
    #: 缺封面不是小事：模块头记着某些剪映版本会直接报"内容已损坏"，
    #: 看起来像加密问题，实际只是少了一张 jpg。为这一张图从桶拉回一个文件
    #: 完全划算——相比整次导出白做。
    cover_first: tuple[str, Path] | None = None
    for s in shots:
        starts[s.order] = t
        dur = _shot_dur_us(s)
        # 文件名按 shot_id 稳定：重新生成时原地覆盖，用户的剪映工程不用重导
        fname = f"{s.id}{Path(s.video_url).suffix or '.mp4'}"
        got = want(s.video_url, fname)
        if got is None:
            t += _shot_out_us(s)
            continue
        local, meta = got
        if cover_src is None and local.is_file():
            cover_src = local            # 封面只能拿本地还在的那一份抽
        elif cover_first is None:
            cover_first = (s.video_url, local)   # 一个都不在本地时的兜底来源
        mat = _stub_material(draft.VideoMaterial, str(local),
                             f"E{(s.episode or 1):02d}-S{s.order:03d}", meta, dur)
        full = mat.duration or dur
        if raw:
            # ---- 原片：原速 + 整条素材，不认任何剪辑参数 ----
            # 这是"我只要最初那条视频"的唯一正确解读：变速、取片窗口都是
            # **用户改过的**东西，原片就该没有它们。`full` 是素材真实全长
            # （台账/ffprobe 给的），比 `duration_sec` 可靠 —— 后者是生成时
            # 声明的目标时长，素材实际可能略长或略短。
            src_in = 0
            dur = int(full)
            spd = 1.0
            out_us = dur
        else:
            src_in = _us(s.clip_in_sec or 0.0)
            dur = min(dur, max(_us(0.5), full - src_in)) if src_in else min(dur, full)
            # 变速（2026-10-23）：**源窗口**用 source_timerange，时间轴占用是它除以
            # 速度。`pyJianYingDraft` 在同时收到 source_timerange 与 speed 时会自己
            # 把 target 时长算成 source/speed —— 所以下面推进的 `out_us` 必须用
            # 同一个除数，否则片段与时间轴错开（越往后错得越多）。
            spd = shot_speed(s)
            out_us = dur if spd == 1.0 else int(round(dur / spd))
        script.add_segment(draft.VideoSegment(
            mat, Timerange(t, out_us), source_timerange=Timerange(src_in, dur),
            speed=spd,
            # 原声已剥离 / 被旁白取代的镜头：把视频自带音轨置 0。
            # `volume` 是 `pyJianYingDraft.VideoSegment` 的既有参数（默认 1.0）。
            # 用「置 0」而不是「删掉音轨」：删了会让这条视频在剪映里的流结构与
            # 音频轨对不上，而置 0 是可逆的——用户随时能在剪映里拉回来。
            #
            # ⚠️ 原片模式**不置零**：`muted_shot_ids` 是"被旁白取代"的判据，
            # 而原片要的就是素材自己的声音。传进来的 auds 是空的，但这里仍
            # 显式写 1.0，免得将来有人改 auds 的构造方式时把这条规则带进来。
            volume=(1.0 if raw else (0.0 if s.id in muted_shot_ids else 1.0))))
        t += out_us

    total = t
    shot_starts = sorted(starts.items())

    # ---- 音频：按 kind 分轨。剪映轨道名不显示，但分轨本身对用户有意义 ----
    #: `sfx`（2026-10-23）：音效段，与配乐并列但**单独一轨**。
    #: 早先只有 `shot`（用户从镜头里剥出来的原声）叫「音效」，那是另一件事
    #: —— 那条会让源视频静音（见 `_muted_shot_ids`），而音效是**叠加**上去的，
    #: 两者绝不能共用一个 kind，否则加一条关门声会把那镜的同期声静掉。
    KIND_CN = {"tts": "配音", "narration": "旁白", "music": "配乐",
               "shot": "镜头原声", "sfx": "音效"}
    by_kind: dict[str, list[AudioClip]] = {}
    for a in auds:
        by_kind.setdefault(a.kind or "tts", []).append(a)

    def _place(kind: str, items: list[AudioClip]) -> list[tuple[str, list]]:
        """把一组音频段排进若干条轨 → `[(轨道名, [段...])]`。

        ## 为什么音效必须允许**并行轨**（2026-10-23 修）

        单轨的规矩是"后一条顺延到前一条结束之后"（`start = max(base, cursor)`）。
        对配音/旁白/配乐这是对的：它们本就该一条接一条。

        但音效**不是**。`apply_sfx_plan` 的文档明确写着「同一镜可以叠多条：
        一句台词中间可以有关门 + 脚步 + 环境音，它们本来就该重叠」。压在一条轨上
        之后，第二条被推到第一条结束，第三条又推到第二条结束 —— 一镜里放三个
        1 秒的音效，第三个会跑到第 3 秒去，而画面上的动作在第 1 秒。
        用户看到的是"音效全错位"，但从库里查行是完全正确的，最难查。

        所以音效走**贪心分轨**：每条轨记自己的结束时刻，找第一条放得下的轨；
        都放不下就新开一条。完全重叠的音效各占一轨，互不挤占。
        """
        if kind != "sfx":
            tname = KIND_CN.get(kind, kind)
            # 同一镜里按**镜内偏移**排，id 只是兜底。id 是随机 uuid12，只按 id 排等于随机序，
            # 而后面 `_emit_lane` 会把每段往后推到上一段结束（cursor），一串乱序就把整镜推歪。
            return [(tname, sorted(items, key=lambda x: (x.start_shot_order or 0,
                                                         x.start_offset_sec or 0.0, x.id)))]

        # 音效：先按时间排好，再贪心分轨。排好序是分轨正确的前提——
        # 乱序分轨会把先开始的后一段塞到另一条轨上，白白多开一条。
        lanes: list[list[AudioClip]] = []
        lane_end: list[int] = []
        for a in sorted(items, key=lambda x: (x.start_shot_order or 0,
                                              x.start_offset_sec or 0.0, x.id)):
            base = starts.get(a.start_shot_order or 0, 0) + _us(a.start_offset_sec or 0.0)
            dur = _us(a.clip_dur_sec or a.duration or 0) or _us(1.0)
            pick = next((i for i, end in enumerate(lane_end) if end <= base), None)
            if pick is None:
                lanes.append([])
                lane_end.append(0)
                pick = len(lanes) - 1
            lanes[pick].append(a)
            lane_end[pick] = base + dur
        # 轨道名带序号：剪映不显示轨道名，但用户在我们的界面与排查日志里要能对上
        return [(f"{KIND_CN.get(kind, kind)}{i + 1}" if len(lanes) > 1
                 else KIND_CN.get(kind, kind), lane)
                for i, lane in enumerate(lanes)]

    def _emit_lane(kind: str, tname: str, lane: list) -> None:
        """把一条轨上的音频段按顺序排进去（同轨不许重叠：后一条顺延）。"""
        cursor = 0
        for a in lane:
            base = starts.get(a.start_shot_order or 0, 0) + _us(a.start_offset_sec or 0.0)
            fname = f"{a.id}{Path(a.url).suffix or '.mp3'}"
            got = want(a.url, fname)
            if got is None:
                continue
            local, meta = got
            mat = _stub_material(draft.AudioMaterial, str(local),
                                 f"{tname}·{a.id[:6]}", meta, _us(a.duration or 0))
            # 取片窗口（2026-10-23）。`audio_clips` 早就存着 clip_in_sec /
            # clip_dur_sec（`routers/audio.py` 也收），但导出一直写死
            # `Timerange(0, dur)` —— 用户把一段 3 分钟的 BGM 剪到 10 秒、
            # 在界面里从第 40 秒开始取，导进剪映又变回了开头那 10 秒。
            # 口径与 db.AudioClip 的注释一致：播放时长 = clip_dur_sec ?? duration。
            cin_us = _us(getattr(a, "clip_in_sec", None) or 0.0)
            want_us = (_us(getattr(a, "clip_dur_sec", None) or 0.0)
                       or _us(a.duration or 0))
            # 素材总长 - 入点 才是可取的余量。老数据里 duration 可能比文件长，
            # 也可能入点比文件长（换了音源），一律夹住而不是让剪映报错。
            room = max(0, mat.duration - cin_us)
            dur = min(want_us or room, room) or mat.duration
            start = max(base, cursor)
            # 音量与淡入淡出（2026-10-20）。配乐必须能压低到台词之下，
            # 段尾必须能淡出——否则一段 BGM 结束是硬切，非常突兀。
            # NULL 保持改动前的行为（volume=1.0、无淡化），老数据零影响。
            seg = draft.AudioSegment(mat, Timerange(start, dur),
                                     source_timerange=Timerange(cin_us, dur),
                                     volume=(1.0 if a.volume is None
                                             else float(a.volume)))
            fi = _us(a.fade_in_sec or 0.0)
            fo = _us(a.fade_out_sec or 0.0)
            if not fo and kind == "sfx" and cin_us + dur < mat.duration - _us(0.02):
                # 被截短的音效（`apply_sfx_plan` 会按本镜剩余时长夹断）
                # 在源文件里是**从中间切一刀**：波形没有回到零点，剪映照原样播
                # 就是"啪"的一声爆音，用户会以为是音效素材本身有问题。
                # 只给 sfx 补一条 60ms 的收尾淡化：配乐不补，那是用户自己
                # 调过的参数，替它加淡出等于改了他的剪辑。
                fo = min(_us(0.06), dur // 4)
            if fi or fo:
                # 淡入淡出不能超过段长本身，否则剪映判非法。
                # 两个加起来超过段长时按比例缩，保留"有淡化"这件事。
                if fi + fo > dur:
                    scale = dur / (fi + fo)
                    fi, fo = int(fi * scale), int(fo * scale)
                seg.add_fade(fi, fo)
            script.add_segment(seg, track_name=tname)
            cursor = start + dur

    for kind, items in by_kind.items():
        for tname, lane in _place(kind, items):
            script.add_track(TrackType.audio, tname)
            _emit_lane(kind, tname, lane)

    # ---- 字幕：可编辑文本轨，不烧进画面 ----
    if subs:
        script.add_track(TrackType.text, "台词字幕")
        st = _text_style(proj)
        style = draft.TextStyle(size=st["size"], color=st["color"], align=1,
                                bold=st["bold"], auto_wrapping=True,
                                max_line_width=0.82)
        border = draft.TextBorder(color=(0.0, 0.0, 0.0), width=st["stroke_width"])
        clip = draft.ClipSettings(transform_y=st["transform_y"])
        cursor = 0
        #: 字幕的偏移/时长按**源秒**记（ASR 转写的是镜头文件本身），导出要换算成
        #: 成片秒。见 `shot_timing.subtitle_output_span` 的说明 —— 漏掉这一步
        #: 会让变速过的镜头里的字幕整体前移，而不会有任何报错。
        by_order_sh = {s.order: s for s in shots}
        # 同一镜里按镜内偏移排：id 是随机 uuid12，只按 id 排是随机序，配上下面的
        # `start = max(base, cursor)` 会把乱序的字幕依次往后推，实测量产工程里一镜最多推歪 40 秒。
        for c in sorted(subs, key=lambda x: (x.start_shot_order or 0,
                                             x.start_offset_sec or 0.0, x.id)):
            if not (c.text or "").strip():
                continue
            sh = by_order_sh.get(c.start_shot_order or 0)
            off_sec, cue_sec = subtitle_output_span(
                sh, c.start_offset_sec, c.duration or 2.0) if sh else (
                    float(c.start_offset_sec or 0.0), float(c.duration or 2.0))
            base = starts.get(c.start_shot_order or 0, 0) + _us(off_sec)
            start = max(base, cursor)
            dur = _us(cue_sec)
            # 一条字幕不许越过它所在镜头的结尾：越界的那部分在画面上已经是下一镜了。
            # 镜头在 `starts` 里没有（没出片的镜头）时不做这个裁剪，交给下面的片尾裁剪。
            nxt = next((t2 for o2, t2 in shot_starts if o2 > (c.start_shot_order or 0)), total)
            room = nxt - start
            if room > 0 and dur > room:
                dur = room
            if start + dur > total:            # 越过片尾的字幕剪映会判为非法
                dur = max(_us(0.3), total - start)
                if dur <= 0:
                    break
            script.add_segment(
                draft.TextSegment(c.text.strip(), Timerange(start, dur),
                                  style=style, border=border, clip_settings=clip),
                track_name="台词字幕")
            cursor = start + dur

    # ---- AI 角标：「内容由AI生成」，右下角一行小字，覆盖全片 ----
    #
    # 2026-10-23 用户要求。此前系统里**没有这个功能**（全库无实现），
    # 所以 agent 只能回一句"仍需补加"。
    #
    # 几点刻意的取舍：
    #   · **独立轨道**，不并进「台词字幕」：合成一条的话，用户在剪映里删角标
    #     会连台词一起删，而这两件事毫无关系；
    #   · 一条**覆盖全片时长**的文本段，不是每镜复制一份：剪映里改文案只需要
    #     改一处（几十镜各一条的话，改一句要点几十次）；
    #   · 默认关闭（见 `_ai_label`）：常驻文字轨是用户没要求就不该有的变更。
    ai = None if raw else _ai_label(proj)
    if ai and total > 0:
        script.add_track(TrackType.text, "AI标识")
        ai_style = draft.TextStyle(
            size=ai["size"], color=ai["color"], align=2,
            alpha=ai["alpha"], auto_wrapping=False)
        ai_clip = draft.ClipSettings(transform_x=ai["transform_x"],
                                     transform_y=ai["transform_y"])
        script.add_segment(
            draft.TextSegment(ai["text"], Timerange(0, total),
                              style=ai_style, clip_settings=ai_clip),
            track_name="AI标识")

    # 一张本地素材都没有时，为了封面单独拉回一个文件。
    if cover_src is None and cover_first is not None:
        url, dest = cover_first
        rel = url.split("/fw/media/", 1)[1] if "/fw/media/" in url else ""
        try:
            from .. import storage
            if rel and storage.enabled():
                storage.fetch(rel, dest)
                cover_src = dest
                logger.info("[export] 为封面回填素材: %s", rel)
        except Exception:      # noqa: BLE001
            logger.warning("[export] 封面素材回填失败，草稿将不带封面", exc_info=True)

    return {"script": script, "manifest": manifest, "cover_src": cover_src, "name": name}


def _write_draft(pack: Path, built: dict) -> dict:
    """把一份草稿落到包里，并把服务端绝对路径换成占位符。"""
    name = built["name"]
    d = pack / "drafts" / name
    d.mkdir(parents=True, exist_ok=True)

    content = json.loads(built["script"].dumps())
    content["name"] = name
    body = json.dumps(content, ensure_ascii=False)
    # 两个文件名都写：各版本读哪个没有权威说法
    (d / "draft_content.json").write_text(body, encoding="utf-8")
    (d / "draft_info.json").write_text(body, encoding="utf-8")

    import pyJianYingDraft as draft
    meta = json.loads((Path(draft.__file__).parent / "assets"
                       / "draft_meta_info.json").read_text(encoding="utf-8"))
    meta["draft_id"] = str(uuid.uuid4()).upper()
    meta["draft_name"] = name
    meta["draft_fold_path"] = DRAFT_TOKEN
    meta["draft_root_path"] = ROOT_TOKEN
    meta["tm_duration"] = content.get("duration", 0)

    cover = None
    if built["cover_src"] is not None:
        cover = "draft_cover.jpg"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-ss", "1", "-i", str(built["cover_src"]),
                 "-frames:v", "1", "-vf", "scale=356:-1", str(d / cover)],
                check=True, timeout=30)
            meta["draft_cover"] = f"{DRAFT_TOKEN}/{cover}"
        except Exception:   # noqa: BLE001
            # 封面拿不到不该让整次导出失败，但要如实告诉调用方：
            # 某些剪映版本缺封面会直接报"内容已损坏"。
            cover = None
    (d / "draft_meta_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 服务端的绝对路径不能留在包里，换成「占位符 + 导入器会用的那个文件名」。
    #
    # ⚠️ 不能只把 DATA_DIR 前缀换成占位符：那样草稿里留下的是
    # `__SFMAT__/generated/h3_xxx.mp4`（原始文件名 + 子目录），
    # 而导入器是按 manifest 的 `name`（= shot_id.mp4）平铺下载的——
    # 两边对不上，在剪映里就是**素材全部丢失**，而且报错前一切看起来都正常。
    pairs = sorted(((m["_local"], m["name"]) for m in built["manifest"]),
                   key=lambda kv: -len(kv[0]))     # 长路径优先，避免前缀互相吃掉
    for jf in d.glob("*.json"):
        txt = jf.read_text(encoding="utf-8")
        for local, fname in pairs:
            txt = txt.replace(local, f"{MAT_TOKEN}/{fname}")
        # 还有残留的服务端路径说明漏了某条素材，宁可留占位符也不能留真实路径
        txt = txt.replace(str(DATA_DIR), MAT_TOKEN)
        jf.write_text(txt, encoding="utf-8")

    return {"name": name, "cover": cover, "duration_us": content.get("duration", 0)}


#: 单文件导入器的批处理引导部分。**刻意全 ASCII**。
#:
#: 为什么不用中文注释：这个文件要经过 cmd 的代码页、PowerShell 的 -Command
#: 解析、以及浏览器下载三道关。引导段一旦含非 ASCII，`chcp 65001` 生效前后的
#: 解释方式就可能不一致，出现"在 A 机器好好的、在 B 机器乱码"。中文提示放在
#: 它释放出来的 ps1 里——那一侧有 BOM，编码是确定的。
#:
#: ## 载荷分隔符为什么长这样（两处都是踩过的坑，别随手改）
#:
#: 1. 分隔符里带 `-`。**`-` 不在 base64 字母表里**（只有 A-Za-z0-9+/=），
#:    所以这个标记**不可能**出现在 base64 载荷内部，IndexOf 不会找错位置。
#: 2. 引导段里拼写这个字面量时**故意拆开**：`'---SFP'+'AYLOAD---'`。
#:    整段连续写的话，`IndexOf` 命中的会是这一行里的字面量而不是文件末尾的
#:    真分隔符，substring 出来的是"— 引导段剩下的部分 + 载荷"，base64 解码
#:    当场失败。
#:
#: 为什么用 `goto :eof` 收尾：base64 载荷就贴在同一个文件里，cmd 会一行行往下
#: 读。`goto :eof` 让它到此为止，载荷那几千行永远不会被当作命令执行——
#: 这比把每行都加上无害前缀可靠得多。
_BAT_BOOT = (
    "@echo off\r\n"
    "rem ShotFlow / Jingliu - Jianying draft importer (self-contained)\r\n"
    "rem Double-click this file. Nothing to unzip.\r\n"
    "chcp 65001 >nul\r\n"
    "setlocal\r\n"
    'set "SF_SELF=%~f0"\r\n'
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \""
    "$ErrorActionPreference='Stop';"
    "$t=[IO.File]::ReadAllText($env:SF_SELF);"
    "$m='---SFP'+'AYLOAD---';"
    "$i=$t.IndexOf($m);"
    "if($i -lt 0){Write-Host 'payload not found';exit 1};"
    "$b=($t.Substring($i+$m.Length)) -replace '\\s','';"
    "$d=[Convert]::FromBase64String($b);"
    # Add-Type 只在 .NET Framework（Windows PowerShell 5.1）下需要：
    # 那里这两个类型在独立程序集里。PS 7 已内置，-AssemblyName 会找不到而抛错——
    # 所以吞掉异常，两个宿主都能跑。$ErrorActionPreference='Stop' 下不包 try
    # 的话，PS 7 上整个引导段会当场失败。
    "try{Add-Type -AssemblyName System.IO.Compression}catch{};"
    "try{Add-Type -AssemblyName System.IO.Compression.FileSystem}catch{};"
    # ::new 而不是 New-Object：New-Object 不吃 C# 式括号语法，会把
    # "IO.MemoryStream" 当类型名、"(,$d)" 当字符串参数，$z 变成字符串。
    "$z=[IO.MemoryStream]::new($d, $false);"
    # ⚠️ 这里**不能**用 [IO.Compression.ZipFile]::OpenRead($z)。
    #    它有两个重载 (String) 和 (Stream)，实测（pwsh 7）即使 $z 确实是
    #    MemoryStream，PowerShell 也会选中 String 重载，把它当**文件名**去开，
    #    报 `Could not find file '…\System.IO.MemoryStream'`。加 [IO.Stream]
    #    显式转换也没用。ZipArchive 的构造函数只有 Stream 重载，无歧义。
    "$a=[IO.Compression.ZipArchive]::new($z, [IO.Compression.ZipArchiveMode]::Read);"
    # 临时目录用 [IO.Path]::GetTempPath() 而不是 $env:TEMP：
    # 前者在 Windows 上就返回 %TEMP%，在别的平台返回 /tmp，两边都确定有值；
    # $env:TEMP 是 Windows 专有变量，在非 Windows 上为 null，
    # 会让后面的 Join-Path 直接抛参数绑定错误。
    "$o=Join-Path ([IO.Path]::GetTempPath()) ('sf-import-'+[Guid]::NewGuid().ToString('N'));"
    "[void][IO.Directory]::CreateDirectory($o);"
    # 逐个条目展开，且只用 BCL 类型（IO.File / entry.Open），
    # 不走 ZipFileExtensions 的静态方法——那一层在 PS 5.1 上还要靠程序集解析。
    "foreach($e in $a.Entries){"
    "$p=Join-Path $o $e.FullName;"
    "if($e.FullName.EndsWith('/')){[void][IO.Directory]::CreateDirectory($p);continue};"
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p));"
    "$s=$e.Open();$f=[IO.File]::Create($p);$s.CopyTo($f);$f.Dispose();$s.Dispose()};"
    "$a.Dispose();$z.Dispose();"
    # 正斜杠：PowerShell 的单引号不做转义，写双反斜杠会原样传成 'scripts\\import.ps1'
    ". (Join-Path $o 'scripts/import.ps1')\"\r\n"
    "endlocal\r\n"
    "pause\r\n"
    "goto :eof\r\n"
    "---SFPAYLOAD---\r\n"
)


def _emit_single_file(pack: Path, pack_name: str, built: dict,
                      mats: list[dict], shot_count: int, info: dict) -> dict:
    """把整个包内联成一个自包含的 .bat，用户双击即导入。

    ## 为什么要这一步

    zip 形态下用户要做三件事：下载→解压→双击。**解压那一件完全没有必要**——
    它只是因为"浏览器不能直接给一个能跑的程序，除非你下载的就是它"。
    既然服务端本来就拥有全部内容，那就把内容内联进一个文件里，
    让下载的那个文件**本身就是**导入器。

    ## 内联的做法

    把包原样打成一个 zip，base64 后贴在 .bat 的载荷区；.bat 的引导段用
    PowerShell 读**自己**、切出载荷、解到一个临时目录，再点源执行里面那份
    `scripts/import.ps1`。

    关键在于**执行的是同一份 import.ps1**，不是另写一份。zip 形态和单文件形态
    共用同一个导入器，两个通道的行为不可能漂移——这正是这类"再加一条交付
    通道"的改动最容易出事的地方。

    ## 已知代价

    · 载荷是 base64，体积比 zip 大约三分之一（几十 KB 的包，无所谓）。
    · 浏览器会对下载的 .bat 提示"不常下载"，SmartScreen 可能拦一次。
      我们没有代码签名，这是必须付的；它拦的是"运行"不是"下载"，
      用户可以选"保留"。
    · 素材仍然**不在**这个文件里（几十 GB 装不下），依旧由导入器按 manifest
      从 /fw/media 断点续传下载。所以单文件省掉的是解压，不是下载。
    """
    import base64
    import io
    import textwrap
    from urllib.parse import quote

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(pack.rglob("*")):
            if f.is_file():
                z.write(f, str(f.relative_to(pack)))      # 相对路径，解出来就是包结构
    payload = base64.b64encode(buf.getvalue()).decode("ascii")
    # 按 76 列折行：几千字符挤在一行会让某些编辑器/杀软扫描器很难受，
    # 反正引导段会先把空白剥掉再解码。
    wrapped = "\r\n".join(textwrap.wrap(payload, 76))

    bat_name = f"镜流导入-{pack_name}.bat"
    bat_path = EXPORT_DIR / bat_name
    bat_path.write_text(_BAT_BOOT + wrapped + "\r\n", encoding="ascii")

    total_bytes = sum(m["size"] for m in mats)
    return {
        # 文件名含中文，URL 必须转义，否则浏览器拿到的是断裂的地址
        "url": "/fw/media/exports/jianying/" + quote(bat_name),
        "name": bat_name,
        # 前端按单一字段 `file_size` 渲染，不关心这一版是 zip 还是 bat
        "file_size": bat_path.stat().st_size,
        "single_file": True,
        "shots": shot_count,
        "materials": len(mats),
        "materials_bytes": total_bytes,
        "duration_sec": round(info["duration_us"] / 1_000_000, 1),
        "cover": bool(info["cover"]),
        "draft_name": info["name"],
        "expires_in_sec": EXPORT_TTL_SEC,
    }


@router.post("/projects/{project_id}/jianying/export")
@access.requires(access.ROLE_VIEWER)
def export_draft(project_id: str, req: ExportReq) -> dict:
    """产出一个剪映草稿包，返回下载地址。

    包里只有草稿 JSON + 清单（几十 KB）；素材由导入器按清单从
    `/fw/media/...` 自己下载（带断点续传），不塞进 zip——
    601 镜的项目素材几十 GB，打进 zip 既慢又没法续传。

    `single_file=True` 时**不产 zip**，改为返回一个自包含的 .bat：
    用户下载后双击即完成导入，省掉"解压"这一步。两种情况下的
    返回值字段不同（见各自的 return）。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(404, "project not found")

        mode = (req.mode or "edit").strip().lower()
        if mode not in ("edit", "raw"):
            raise HTTPException(400, "mode 只能是 edit / raw")
        raw = mode == "raw"

        # 「解说剧·角色开口」的剪辑版由对齐结果排时间轴（旁白段静音换 TTS、台词段原声），
        # 不走下面按镜头/音频段排的逻辑。原片（raw）两边口径一样，照常往下走。
        from ..nd import is_nd
        if not raw and is_nd(proj):
            from ..nd.export import export as _nd_export
            return _nd_export(project_id, req.episode, bool(req.single_file))

        # ---- 选镜头：剪辑版只取启用中的；原片取**全部** ----
        #
        # 原片必须包含 `disabled=1` 的镜头（2026-10-24）。那些正是用户剪掉的部分
        # ——`cut_shot_range` / 停用空镜都会把镜头标成停用。只给启用中的，
        # 用户拿到的仍然是"剪过的版本"，只是没有变速和音轨而已，
        # 那恰恰不是他要的「最初的原片」。
        q = session.query(Shot).filter(
            Shot.project_id == project_id,
            Shot.video_url.isnot(None), Shot.video_url != "")
        if not raw:
            q = q.filter((Shot.disabled == 0) | (Shot.disabled.is_(None)))
        if req.episode is not None:
            q = q.filter(Shot.episode == req.episode)
        shots = q.order_by(Shot.order).all()
        if not shots:
            raise HTTPException(
                400, "这一集还没有任何出片的镜头，没有可导出的内容"
                if not raw else "这一集还没有任何出片的镜头，没有原片可导出")

        # ---- 原片按**源文件**去重 ----
        #
        # 分割出来的几段共用同一个 `video_url`（切点只记在 clip_in/clip_dur 上，
        # 不复制文件）。不去重的话，一个切过三刀的镜头在原片里会连出三条
        # 一模一样的完整视频 —— 对"我要原片"的用户来说那是纯噪声，
        # 而且会让他以为生成了三份。按 url 首次出现的顺序保留一条。
        deduped = 0
        if raw:
            _seen: set[str] = set()
            uniq = []
            for s in shots:
                u = s.video_url or ""
                if u in _seen:
                    deduped += 1
                    continue
                _seen.add(u)
                uniq.append(s)
            shots = uniq

        orders = {s.order for s in shots}
        # 原片不挂任何音轨/字幕：它就是要"素材本来的样子"。
        auds = [] if raw else [
            a for a in session.query(AudioClip)
            .filter(AudioClip.project_id == project_id,
                    AudioClip.url.isnot(None), AudioClip.url != "").all()
            if (a.start_shot_order or 0) in orders]
        subs = [] if raw else [
            c for c in session.query(SubtitleClip)
            .filter(SubtitleClip.project_id == project_id).all()
            if (c.start_shot_order or 0) in orders]

        ep_tag = f"第{req.episode}集" if req.episode is not None else "全片"
        # 草稿名带上「原片」，否则用户在剪映的工程列表里分不清两个同名工程
        name = f"{proj.title or project_id}-{ep_tag}" + ("-原片" if raw else "")
        built = _build(session, proj, shots, auds, subs, name, raw=raw)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    pack_name = f"{project_id}-{req.episode if req.episode is not None else 'all'}-{stamp}"
    pack = EXPORT_DIR / pack_name
    # 顺手清一次过期包：巡检 5 分钟才跑一轮，而"点导出"正是最该保证
    # 目录干净的时刻——尤其是连续导好几集时。
    sweep_exports()
    if pack.exists():
        shutil.rmtree(pack)
    pack.mkdir(parents=True)

    try:
        info = _write_draft(pack, built)

        # 导入器随包一起发：用户拿到的应该是"下载 → 双击 → 打开剪映"，
        # 而不是一堆 JSON 加一句"自己想办法装进去"。
        src = Path(__file__).parent / "jianying_pack"
        for item in src.iterdir():
            dst = pack / item.name
            if item.is_dir():
                shutil.copytree(item, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dst)
        mats = [{k: v for k, v in m.items() if not k.startswith("_")}
                for m in built["manifest"]]
        (pack / "manifest.json").write_text(
            json.dumps({"materials": mats, "drafts": [info],
                        "mat_token": MAT_TOKEN, "draft_token": DRAFT_TOKEN,
                        "root_token": ROOT_TOKEN},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")

        if req.single_file:
            # 传长度而不是 shots 本身：会话早已关闭，脱管的 ORM 对象读到
            # 未加载的属性会抛 DetachedInstanceError。
            return _emit_single_file(pack, pack_name, built, mats,
                                     len(shots), info)

        zip_path = EXPORT_DIR / f"{pack_name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(pack.rglob("*")):
                if f.is_file():
                    # 非 ASCII 文件名要置 UTF-8 标志位，否则资源管理器解出乱码
                    z.write(f, str(Path(pack_name) / f.relative_to(pack)))
    finally:
        # 单文件分支在产完包之后也要落盘（它把包内内容内联进 .bat），
        # 所以清理统一放 finally，别让异常路径留下半截目录。
        if pack.exists():
            shutil.rmtree(pack, ignore_errors=True)

    total_bytes = sum(m["size"] for m in mats)
    return {
        "url": f"/fw/media/exports/jianying/{zip_path.name}",
        "name": zip_path.name,
        "zip_size": zip_path.stat().st_size,
        "shots": len(shots),
        "materials": len(mats),
        "materials_bytes": total_bytes,
        "duration_sec": round(info["duration_us"] / 1_000_000, 1),
        "cover": bool(info["cover"]),
        "draft_name": info["name"],
        # 链接是短命的，必须告诉前端——否则用户过一小时再点只会拿到一个
        # 没头没尾的 404，而真相是"包已按期清掉，重新导一份即可"。
        "expires_in_sec": EXPORT_TTL_SEC,
    }

# ---------------------------------------------------------------------------
# 按集导出镜头文件（2026-10-21）
#
# ⚠️ 这里**刻意没有**服务端拼接 / 转码。2026-10-21 用户裁定：
#    "不要拼接形式了：让用户拼接只会把服务器性能打爆。只给用户一堆按集的镜头导出"
#    实测依据见 `app/episode_clips.py` 模块头（一集 187 秒 CPU、单进程开 9 线程）。
#    要成片的用户用剪映草稿那条通道（不转码，剪映自己读入出点）。
# ---------------------------------------------------------------------------
@router.get("/projects/{project_id}/episode-clips")
def list_episode_clips(project_id: str, episode: int | None = None) -> dict:
    """这一集有哪些镜头文件、各自叫什么名字、下哪个地址。

    只查库，不读文件、不起 ffmpeg。真正的字节由 `/media` 直发（本地命中）
    或 307 到对象存储（不在本地缓存），**不经过本服务**，所以点多少次、
    多少人同时点，都不占 CPU 和带宽。

    下载名是「项目名-第N集-S003.mp4」，但**只有桶的响应头能保住它**：
    跨域 307 之后浏览器会丢掉 `<a download>`，所以前端必须把名字放进
    `?dl=`（见 `main._MediaFiles`）。
    """
    with get_session() as s:
        if not access.can_access_project(s, project_id):
            raise HTTPException(404, "项目不存在或无权访问")

    from ..episode_clips import clips_of
    return clips_of(project_id, episode)
