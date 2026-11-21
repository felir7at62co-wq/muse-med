"""把一个**文件夹**里的音频批量导入音效库（生成/追加 manifest.json）。

用法：

    # 导入一个目录（递归一层，跳过隐藏文件）
    python3 scripts/import_sfx.py "/root/filmweaver-data/sfx-library/新建文件夹"

    # 只看看会导入什么，不写盘
    python3 scripts/import_sfx.py <dir> --dry-run

    # 指定分类/标签（不给就按文件名猜）
    python3 scripts/import_sfx.py <dir> --category 悬疑 --tag 紧张 --tag 悬疑

    # 看现有音效库
    python3 scripts/import_sfx.py --list

## 为什么 id 用内容哈希，而不是像 import_bgm 那样用文件名

配乐库那边 id 是文件名派生的，重复导入同名文件要加 `_2` 后缀。音效这边
同一个"关门声"极可能来自不同批次、文件名各不相同，而**重复导入**是最常见的
操作（运维往目录里补几个文件，再跑一次脚本）。用 `md5(内容)[:12]` 之后：

  · 同一个文件重跑 → 同一个 id → 直接跳过，不会出现两条一模一样的记录；
  · 内容不同但同名 → 两个 id 都在，不会互相覆盖。

与存量 894 条的 id 形状一致（12 位十六进制），不需要迁移。

## 为什么跳过 `._xxx` 开头的文件

那是 macOS 拷到非 HFS 盘时留下的 AppleDouble 资源分叉 —— 里面是元数据、
不是音频（实测 `ffprobe` 认不出来）。把它们导进库只会让 agent 挑到一条
放不出声的"音效"。同理跳过 `.DS_Store` 与任何 ffprobe 认不出的文件。

## 为什么分类不做受控词表

与 `app/sfx.py` 模块头同一条理由：音效的 category 是**客观来源**，
钉死词表就要求运维每次放素材都先改代码。这里只按文件名里的关键词猜一个
**建议值**，猜不出就叫「未分类」，绝不因此拒绝导入。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from app.media import DATA_DIR  # noqa: E402
from app.sfx import EXTS, LIB_DIRNAME  # noqa: E402

#: 文件名关键词 → 分类。只用于**猜一个建议值**，命不中就是「未分类」。
#:
#: 顺序有意义：先命中的赢。所以把更具体的放前面（"悬疑"先于"环境"）。
_CATEGORY_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("提示音", ("提示音", "铃", "叮", "响铃", "notification", "ding")),
    ("转场", ("转场", "划过", "whoosh", "唰", "过渡", "swish", "swoosh")),
    ("悬疑", ("悬疑", "悬念", "不安", "诡异", "紧张", "惊悚", "恐怖",
              "suspense", "tension", "horror")),
    ("打斗", ("打斗", "拳", "撞击", "冲击", "重击", "impact", "punch", "hit")),
    ("机械", ("机械", "齿轮", "电机", "开关", "machine", "gear")),
    ("动物", ("猫", "狗", "鸟", "虫", "鸡", "animal", "cat", "dog", "bird")),
    ("环境音", ("环境", "氛围", "风", "雨", "水", "ambience", "ambient", "wind")),
    ("笑声", ("笑", "laugh")),
    ("震惊", ("震惊", "哇", "叹气", "啊", "gasp")),
    ("乐器", ("沙锤", "鼓", "钢琴", "吉他", "铃鼓", "drum", "piano")),
    ("拟音", ("咚", "敲", "脚步", "关门", "foley", "thud", "knock")),
]

#: 从文件名里切出标签用的分隔符（空格、下划线、连字符、括号、顿号…）
_TAG_SPLIT = re.compile(r"[\s_,，、\-—()（）\[\]【】]+")


def probe(path: Path) -> dict:
    """ffprobe 时长 + ffmpeg ebur128 响度。量不出来就留空，**不阻断导入**。

    响度（LUFS/峰值）不是装饰：`list_sfx` 把它交给模型，模型据此判断
    "这条音效会不会盖住台词"。编一个假值比留空更坏 —— 模型会照它调音量。
    """
    out: dict = {"duration": 0.0, "lufs": None, "peak_db": None}
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30)
        out["duration"] = round(float((r.stdout or "0").strip() or 0), 3)
    except Exception:  # noqa: BLE001
        return out
    if out["duration"] <= 0:
        return out
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
             "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
        err = r.stderr or ""
        # ⚠️ **必须只读末尾的 Summary 块**（2026-10-23 踩过）。
        #
        # ebur128 会按 100ms 打一行进度，每行都带 `I: … LUFS` —— 那是**累计到
        # 当前时刻**的积分响度。文件刚开头时几乎没有能量，第一行会是
        # `I: -70.0 LUFS` 这种离谱值。
        # 用 `re.search`（取第一处）就会把它当成结果：实测「咚.mp3」明明是
        # 峰值 0dBFS 的重击，却被记成 -70 LUFS —— 模型据此会把音量调到最大。
        summary = err.rsplit("Summary:", 1)[-1]
        m = re.search(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", summary)
        if m:
            out["lufs"] = round(float(m.group(1)), 1)
        m = re.search(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", summary)
        if m:
            out["peak_db"] = round(float(m.group(1)), 1)
    except Exception:  # noqa: BLE001
        pass
    return out


def guess_category(name: str) -> str:
    low = name.lower()
    for cat, keys in _CATEGORY_HINTS:
        if any(k in low for k in keys):
            return cat
    return "未分类"


def split_tags(stem: str) -> list[str]:
    """文件名 → 标签（供模型按关键词检索）。去重、去空、保留原顺序。"""
    seen: list[str] = []
    for t in _TAG_SPLIT.split(stem):
        t = t.strip()
        if t and t not in seen:
            seen.append(t)
    return seen


def file_id(path: Path) -> str:
    """内容哈希前缀（12 位）。同内容 → 同 id，重跑幂等。"""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def load_manifest(root: Path) -> list[dict]:
    mf = root / "manifest.json"
    if not mf.exists():
        return []
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
        return raw if isinstance(raw, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"⚠️ manifest 解析失败（{e}），将从空开始", file=sys.stderr)
        return []


def save_manifest(root: Path, items: list[dict]) -> None:
    """原子写：先写临时文件再改名。

    中途失败不能留下半个 manifest —— 那会让整个音效库读不出来
    （`sfx._load_manifest` 解析失败就按空库处理，agent 会以为库里什么都没有）。
    """
    mf = root / "manifest.json"
    tmp = mf.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    tmp.replace(mf)


def collect(src: Path) -> list[Path]:
    """目录里所有**看起来是音频**的文件。跳过隐藏文件与 AppleDouble 残影。"""
    out: list[Path] = []
    for p in sorted(src.iterdir()):
        if not p.is_file():
            continue
        n = p.name
        if n.startswith(".") or n.startswith("._") or n == ".DS_Store":
            continue
        if p.suffix.lower() not in EXTS:
            continue
        out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="把文件夹里的音频导入音效库")
    ap.add_argument("source", nargs="?", help="音频所在目录")
    ap.add_argument("--list", action="store_true", help="只列出已有音效")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写盘")
    ap.add_argument("--category", help="强制指定分类（不给就按文件名猜）")
    ap.add_argument("--tag", action="append", default=[], help="额外标签，可重复")
    ap.add_argument("--license", default="", help="授权说明")
    args = ap.parse_args()

    root = DATA_DIR / LIB_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    items = load_manifest(root)

    if args.list:
        if not items:
            print("音效库为空。")
            return 0
        sfx = [x for x in items if not x.get("is_music")]
        print(f"共 {len(items)} 条（其中音效 {len(sfx)}、长曲 {len(items) - len(sfx)}）：")
        for it in sfx[-20:]:
            print(f"  {str(it.get('id')):14s} {str(it.get('category')):6s} "
                  f"{float(it.get('duration') or 0):5.1f}s  {it.get('name')}")
        return 0

    if not args.source:
        ap.error("没有指定目录（或加 --list 看音效库）")
    src = Path(args.source).expanduser()
    if not src.is_dir():
        ap.error(f"不是目录：{src}")

    files = collect(src)
    if not files:
        print(f"{src} 里没有可导入的音频（支持 {', '.join(EXTS)}）")
        return 1

    lib = root / "lib"
    lib.mkdir(parents=True, exist_ok=True)
    used = {str(it.get("id")) for it in items}

    added = skipped = bad = 0
    for f in files:
        info = probe(f)
        if info["duration"] <= 0:
            print(f"⏭  跳过（ffprobe 认不出，不是有效音频）: {f.name}")
            bad += 1
            continue

        sid = file_id(f)
        if sid in used:
            print(f"⏭  跳过（库里已有同样内容 id={sid}）: {f.name}")
            skipped += 1
            continue

        dest_name = f"lib/{sid}{f.suffix.lower()}"
        dest = root / dest_name
        if not args.dry_run:
            try:
                shutil.copy2(f, dest)
            except OSError as e:
                print(f"❌ 复制失败，已跳过 {f.name}: {e}")
                bad += 1
                continue

        stem = f.stem
        cat = args.category or guess_category(stem)
        tags = split_tags(stem)
        for t in args.tag:
            if t and t not in tags:
                tags.append(t)
        if cat and cat not in tags:
            tags.insert(0, cat)

        items.append({
            "id": sid,
            "name": stem,
            "aliases": [],
            "file": dest_name,
            "category": cat,
            "tags": tags,
            "is_music": False,
            "duration": info["duration"],
            "lufs": info["lufs"],
            "peak_db": info["peak_db"],
            "size": f.stat().st_size,
            **({"license": args.license} if args.license else {}),
        })
        used.add(sid)
        added += 1
        lufs = f"{info['lufs']:+.1f} LUFS" if info["lufs"] is not None else "响度未知"
        print(f"✅ {sid:14s} {cat:6s} {info['duration']:5.2f}s {lufs:14s} {stem}")

    if args.dry_run:
        print(f"\n[dry-run] 会导入 {added} 条、跳过 {skipped} 条、跳过无效 {bad} 条；未写盘。")
        return 0

    if added:
        save_manifest(root, items)
        print(f"\nmanifest 已更新：{root / 'manifest.json'}"
              f"（音效 {sum(1 for x in items if not x.get('is_music'))} 条）")
    else:
        print("\n没有新增（全部已存在）。")
    if bad:
        print(f"⚠️ 有 {bad} 个文件没能导入，见上面逐条原因。")
    return 0 if added or skipped else 1


if __name__ == "__main__":
    sys.exit(main())
