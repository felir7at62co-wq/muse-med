"""资产导出包：把「哪些图、叫什么名字」算好，交给用户本机的脚本自己下载。

## 为什么不是服务端打 ZIP

一次导出的量级（dev 库实测）：中位 34 MB / P90 263 MB / 最大 1.1 GB，
最大的项目连场景多视角一起 **5 GB**。服务端打包意味着
「从对象存储拉回 → 落盘 → 再发给用户」，出网翻倍、占内存、还超 nginx 的
300 秒读超时。

而**地址本身是永久可解析的**（`/fw/media/...`，每次访问现签）。所以只下发一份
清单，让用户的浏览器/脚本直接对着对象存储下载——服务器一次字节都不经手。

## 与剪映导入器的关系

同一个套路（清单 + 脚本 + 自包含 `.bat`），共用 `pack_boot` 的引导段。
差别只有一处：那边下的是几十 GB 视频，这边是几百张图，所以没有断点续传之外
的复杂度。

## 命名

用户要的是「带名字」。名字只能在这里定——图在库里叫 `img_dcfc924f5c3e.png`，
那对用户毫无意义。规则见 `safe_segment` 与 `build_manifest`：

    角色/林晨/林晨.png
    角色/林晨/造型/第01-03集_干练优雅职场装.png
    场景/顾家客厅/顾家客厅.png
    场景/顾家客厅/视角/主视角·全景.png
    道具/催款单/催款单.png
    参考音色/林晨.mp3

用**文件夹**而不是长平铺名，是因为实测有两类必然重名：
213 组「同角色同造型名」重复行、以及 130 个带 `/` 的资产名
（`夜 内 顾家客厅/大门口`）。文件夹天然消化第一类，`safe_segment` 处理第二类。
"""
from __future__ import annotations

import logging
import re
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

log = logging.getLogger("fw.asset_export")

#: 能勾选的导出范围。`base` 恒选；另两项是体积大头，必须用户显式勾。
SCOPES = ("base", "views", "voice")

#: 单次导出允许的最大体积。超过就拒，并指路桌面端（桌面端不受此限）。
#:
#: 为什么设上限：清单是**一次性**下发的，脚本中途失败用户只会看到
#: 「下到一半停了」。宁可开跑前就说清楚，也不要跑 40 分钟再断。
MAX_EXPORT_BYTES = 6 * 1024 ** 3

#: 各分类在导出目录里的文件夹名。
_KIND_DIR = {"character": "角色", "location": "场景", "prop": "道具", "custom": "其他"}

#: 站位图单独一个文件夹（它不在 `assets` 表里，见 `db.BlockingImage`）。
BLOCKING_DIR = "站位图"

#: Windows 上非法的文件名字符 + 控制字符。与后端 `storage._DL_BAD` 同源思路，
#: 但这里还要挡 `/`：资产名里真有「夜 内 顾家客厅/大门口」这种写法（实测 130 个），
#: 直接当文件名会变成两级目录**或**在 Windows 上写盘失败。
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')

#: 单段（一个文件夹名 / 一个文件名主干）的长度上限。
#:
#: 260 字符的路径上限按「项目名 + 角色 + 造型 + 扩展名」四段估：
#: 60+60+60+20 ≈ 200，再留出根目录本身的长度。超过就截断，不报错——
#: 名字被截短是小事，导不出来才是大事。
_MAX_SEG = 60


def safe_segment(raw: str | None, fallback: str = "未命名") -> str:
    """把一个名字洗成可以安全落盘的**单段**路径片段。

    与前端 `lib/filename.ts` 的 `safeFileName` 同一套规则（非法字符换 `_`、
    收尾的点与空格去掉、限长），但**必须在这里再做一遍**：清单是后端出的，
    不能指望调用方先洗过。
    """
    t = _BAD.sub("_", str(raw or "")).replace("\r", "").replace("\n", "")
    t = re.sub(r"\s+", " ", t).strip()
    t = t.strip(". ")                      # Windows 会静默吞掉结尾的点和空格
    if not t:
        return fallback
    if len(t) > _MAX_SEG:
        t = t[:_MAX_SEG].rstrip(". ")
    return t or fallback


def _ext(url: str, default: str = ".png") -> str:
    """从地址里取扩展名。图是 .png/.jpg/.webp 混杂，语音是 .mp3/.wav。"""
    tail = url.split("?", 1)[0].rsplit("/", 1)[-1]
    m = re.search(r"(\.[A-Za-z0-9]{1,5})$", tail)
    return m.group(1).lower() if m else default


def _rel_of(url: str | None) -> str | None:
    """`/fw/media/generated/x.png` → `generated/x.png`（台账的键）。"""
    if not url or "/fw/media/" not in url:
        return None
    return url.split("/fw/media/", 1)[1].split("?", 1)[0]


def _pub(url: str) -> str:
    """相对地址 → 公网绝对地址（与环境前缀一致，见 `config.media_base`）。"""
    from .config import get_settings
    base = get_settings().media_base.rstrip("/")
    rel = url.split("/fw/", 1)[1] if url.startswith("/fw/") else url.lstrip("/")
    return f"{base}/{rel}"


class _Namer:
    """分配目标路径，**保证不撞名**。

    ⚠️ 大小写不敏感地比较：Windows 的 NTFS 默认不区分大小写，
    「林晨」和「林晨 」（或 `A.png` / `a.png`）各写一份会互相覆盖，
    而脚本按「已存在就跳过」的逻辑会让用户少拿到一张图且毫无提示。
    """

    def __init__(self) -> None:
        self._used: set[str] = set()

    def take(self, path: str) -> str:
        key = path.casefold()
        if key not in self._used:
            self._used.add(key)
            return path
        p = Path(path)
        stem, suffix, parent = p.stem, p.suffix, p.parent
        n = 2
        while True:
            cand = str(parent / f"{stem}_{n}{suffix}") if str(parent) not in ("", ".") \
                else f"{stem}_{n}{suffix}"
            if cand.casefold() not in self._used:
                self._used.add(cand.casefold())
                return cand
            n += 1


def _ep_range(a: int | None, b: int | None) -> str:
    """集区间 → `第01-03集` / `第05集` / 空串（仅供手动引用时无区间）。

    补零是为了文件管理器里按名排序等于剧情顺序（沿用 `filename.ts` 的 `pad2`）。
    """
    if a is None and b is None:
        return "手动引用"
    a = a if a is not None else b
    b = b if b is not None else a
    if a == b:
        return f"第{a:02d}集"
    return f"第{a:02d}-{b:02d}集"


def build_manifest(project_id: str, scopes: list[str] | None = None) -> dict:
    """算出这次要导出哪些文件。**只查库**，不读任何文件、不碰网络。

    返回::

        {"folder": "项目名-资产-20261113",
         "items": [{"url", "path", "size", "name"}],
         "missing": [{"kind", "name", "why"}],
         "total_bytes": int, "too_big": bool, "max_bytes": int}

    `path` 是**相对导出根目录**的路径，脚本据此建目录并命名——
    命名规则只在这里写一次，脚本只管照着摆。
    """
    from .db import Asset, AssetStage, BlockingImage, Project, SceneView, get_session
    from .media_cache import meta_of
    from .costumes import resolve_stage_image

    want = set(scopes or ["base"])
    bad = want - set(SCOPES)
    if bad:
        raise ValueError(f"未知的导出范围: {sorted(bad)}")

    with get_session() as s:
        proj = s.get(Project, project_id)
        if proj is None:
            raise LookupError("项目不存在")
        assets = (s.query(Asset)
                  .filter(Asset.project_id == project_id, Asset.deleted_at.is_(None))
                  .all())
        stages = (s.query(AssetStage)
                  .filter(AssetStage.project_id == project_id,
                          AssetStage.deleted_at.is_(None))
                  .all())
        views = (s.query(SceneView).filter(SceneView.project_id == project_id).all()) \
            if "views" in want else []
        blockings = [(b.name, b.image_url) for b in
                     (s.query(BlockingImage)
                      .filter(BlockingImage.project_id == project_id).all())]

        # 造型的图要过 `resolve_stage_image`（指针行 `source_stage_id` 自己不产图，
        # 要解析到源阶段那张）。直接读 `image_url` 会让那批造型导出成空。
        stage_img = {st.id: resolve_stage_image(s, st) for st in stages}
        title = proj.title or "项目"

    # ---- 先把「相对地址 → 大小」一次查齐，缺的后面统一记进 missing ----
    rels = [_rel_of(u) for u in
            [a.image_url for a in assets]
            + list(stage_img.values())
            + [v.image_url for v in views]
            + [url for _name, url in blockings]
            + ([a.voice_url for a in assets] if "voice" in want else [])]
    rels = [r for r in rels if r]
    meta = meta_of(rels)

    date = datetime.now().strftime("%Y%m%d")
    root = f"{safe_segment(title)}-资产-{date}"

    namer = _Namer()
    items: list[dict] = []
    missing: list[dict] = []

    def add(kind: str, name: str, url: str | None, path: str, why: str = "没生成图") -> None:
        rel = _rel_of(url)
        size = (meta.get(rel) or {}).get("size") if rel else None
        if not url or not rel or not size:
            # 台账里没有 size = 这个对象当前无从获取（桶里也没有）。
            # 不能塞进清单让脚本去撞 404 —— 那会让整次导出停在半路。
            missing.append({"kind": kind, "name": name, "why": why})
            return
        items.append({"url": _pub(url), "path": namer.take(path),
                      "size": int(size), "name": name})

    # ---- 角色 / 场景 / 道具的当前图 ----
    for a in sorted(assets, key=lambda x: (x.kind, x.name or "", x.id)):
        if a.kind not in _KIND_DIR:
            continue
        nm = safe_segment(a.name)
        kd = _KIND_DIR[a.kind]
        if a.image_url:
            add(a.kind, a.name, a.image_url,
                f"{kd}/{nm}/{nm}{_ext(a.image_url)}")
        elif a.kind != "character":
            # 角色可能只有造型图、没有基础图（实测常态），不算缺；
            # 场景/道具没有图就是真的没有。
            missing.append({"kind": a.kind, "name": a.name, "why": "没生成图"})

    # ---- 造型阶段（只在 base 范围里）----
    for st in sorted(stages, key=lambda x: (x.character_name or "", x.ep_from or 0,
                                            x.shot_from if x.shot_from is not None else -1,
                                            x.id)):
        cn = safe_segment(st.character_name)
        sn = safe_segment(st.stage_name, "默认造型")
        url = stage_img.get(st.id)
        add("stage", f"{st.character_name}·{st.stage_name}", url,
            f"角色/{cn}/造型/{_ep_range(st.ep_from, st.ep_to)}_{sn}"
            f"{_ext(url) if url else '.png'}",
            why="这套造型没有图（或指针行的源造型没有图）")

    # ---- 站位图：单独一个文件夹，按名字平铺 ----
    for name, url in sorted(blockings):
        add("blocking", name, url, f"{BLOCKING_DIR}/{safe_segment(name)}{_ext(url)}",
            why="图片文件取不到")

    # ---- 场景多视角（体积大头，只有显式勾了才导）----
    if "views" in want:
        loc_name = {a.id: a.name for a in assets if a.kind == "location"}
        for v in sorted(views, key=lambda x: (x.asset_id, x.sort or 0)):
            nm = safe_segment(loc_name.get(v.asset_id, "未知场景"))
            add("scene_view", f"{loc_name.get(v.asset_id, '')}·{v.label}", v.image_url,
                f"场景/{nm}/视角/{safe_segment(v.label, v.view_key)}"
                f"{_ext(v.image_url) if v.image_url else '.png'}")

    # ---- 参考音色 ----
    if "voice" in want:
        for a in sorted((x for x in assets if x.voice_url), key=lambda x: x.name or ""):
            nm = safe_segment(a.name)
            add("voice", a.name, a.voice_url,
                f"参考音色/{nm}{_ext(a.voice_url, '.mp3')}", why="音色文件取不到")

    total = sum(i["size"] for i in items)
    return {
        "folder": root,
        "items": items,
        "missing": missing,
        "total_bytes": total,
        "max_bytes": MAX_EXPORT_BYTES,
        "too_big": total > MAX_EXPORT_BYTES,
        "scopes": sorted(want),
    }


# ---------------------------------------------------------------- 打包

#: 资产导出脚本在包里的相对路径。
PACK_DIR = Path(__file__).parent / "asset_pack"
PACK_SCRIPT_REL = "scripts/export_assets.ps1"

#: 导出包保留时长。与剪映包同一条纪律：几十 KB 的中间产物，过期即删，
#: 用户随时可以零成本重出一份。
EXPORT_TTL_SEC = 30 * 60


def _manifest_json(man: dict) -> str:
    """清单落盘的样子。**剔掉服务端内部字段**，只留脚本要用的。"""
    import json
    return json.dumps({
        "folder": man["folder"],
        "items": [{"url": i["url"], "path": i["path"], "size": i["size"]}
                  for i in man["items"]],
        "missing": man["missing"],
        "total_bytes": man["total_bytes"],
    }, ensure_ascii=False, indent=1)


def _readme(man: dict) -> str:
    n, mb = len(man["items"]), man["total_bytes"] / 1048576
    lines = [
        "镜流 · 资产下载",
        "=" * 24,
        "",
        "双击「下载资产.bat」即可。脚本会把图下到你自己电脑上，并**按资产名建好文件夹**：",
        "",
        "    角色/林晨/林晨.png",
        "    角色/林晨/造型/第01-03集_干练优雅职场装.png",
        "    场景/顾家客厅/顾家客厅.png",
        "    道具/催款单/催款单.png",
        "    站位图/渡口清晨站位图.png",
        "",
        f"这次共 {n} 个文件，约 {mb:.1f} MB。",
        "下载支持续传：中断后重跑不会重下已完成的。",
        "",
        "日志写在导出目录下的「下载日志.txt」。出问题请把它发回。",
    ]
    if man["missing"]:
        lines += ["", "-" * 24, f"以下 {len(man['missing'])} 项没导出（本来就没有图）：", ""]
        for m in man["missing"][:40]:
            lines.append(f"    {m['kind']}  {m['name']}  —— {m['why']}")
        if len(man["missing"]) > 40:
            lines.append(f"    …… 还有 {len(man['missing']) - 40} 项，见清单.json")
    return "\n".join(lines) + "\n"


def emit_pack(man: dict, *, single_file: bool = True) -> dict:
    """把清单 + 脚本打成交付物，返回 `{url, name, file_size, ...}`。

    `single_file=True` 产出自包含 `.bat`（双击即用，不用解压）；
    否则产 zip（解压后双击里面的「下载资产.bat」）。两条通道**共用同一份
    `.ps1`**，不允许各写一份——那种复制迟早漂移，而漂移的表现是其中一条
    静默失效。
    """
    import base64
    import io
    import textwrap

    from .media_store import commit
    from .pack_boot import PAYLOAD_MARK, bat_boot
    from .routers.jianying import EXPORT_DIR

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # `man["folder"]` 里已经带了日期，只补时分秒。再拼一个完整时间戳会变成
    # 「…-20261113-20261113-175139」，用户拿到的文件名平白长一截。
    stem = f"{man['folder']}-{datetime.now().strftime('%H%M%S')}"

    pack = EXPORT_DIR / f"_{stem}"
    try:
        (pack / "scripts").mkdir(parents=True, exist_ok=True)
        (pack / "manifest.json").write_text(_manifest_json(man), encoding="utf-8")
        (pack / "请先读我.txt").write_text(_readme(man), encoding="utf-8")
        # ⚠️ 必须带 UTF-8 BOM：Windows PowerShell 5.1 读 .ps1 时「有 BOM 才按
        # UTF-8，没有就按系统 ANSI（中文 Windows 是 GBK）」。少了 BOM，中文字符串
        # 被读成乱码、吞掉引号、整份 ParserError —— 而 pwsh 7 / Linux 上完全
        # 测不出来。这条是 `verify_jianying_pack_encoding.py` 钉住的事故。
        src = (PACK_DIR / "export_assets.ps1").read_text(encoding="utf-8")
        (pack / PACK_SCRIPT_REL).write_text(src, encoding="utf-8-sig")

        bat = ("@echo off\r\n"
               "chcp 65001 >nul\r\n"
               "powershell -NoProfile -ExecutionPolicy Bypass "
               "-File \"%~dp0scripts\\export_assets.ps1\"\r\n"
               "pause\r\n")
        (pack / "下载资产.bat").write_text(bat, encoding="ascii")

        if single_file:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(pack.rglob("*")):
                    if f.is_file():
                        z.write(f, str(f.relative_to(pack)))
            payload = base64.b64encode(buf.getvalue()).decode("ascii")
            wrapped = "\r\n".join(textwrap.wrap(payload, 76))
            name = f"镜流资产-{stem}.bat"
            dest = EXPORT_DIR / name
            dest.write_text(bat_boot(PACK_SCRIPT_REL, tmp_prefix="sf-assets-")
                            + PAYLOAD_MARK + "\r\n" + wrapped + "\r\n",
                            encoding="ascii")
            commit(dest)
            return {"url": "/fw/media/exports/jianying/" + quote(name), "name": name,
                    "file_size": dest.stat().st_size, "single_file": True,
                    "count": len(man["items"]), "total_bytes": man["total_bytes"],
                    "missing": len(man["missing"]),
                    "expires_in_sec": EXPORT_TTL_SEC}

        zip_path = EXPORT_DIR / f"{stem}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(pack.rglob("*")):
                if f.is_file():
                    # 非 ASCII 文件名要置 UTF-8 标志位，否则资源管理器解出乱码
                    z.write(f, str(Path(man["folder"]) / f.relative_to(pack)))
        commit(zip_path)
        return {"url": "/fw/media/exports/jianying/" + quote(zip_path.name),
                "name": zip_path.name, "file_size": zip_path.stat().st_size,
                "single_file": False, "count": len(man["items"]),
                "total_bytes": man["total_bytes"], "missing": len(man["missing"]),
                "expires_in_sec": EXPORT_TTL_SEC}
    finally:
        import shutil
        if pack.exists():
            shutil.rmtree(pack, ignore_errors=True)
