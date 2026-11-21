"""把音频文件导入配乐库（生成/追加 manifest.json）。

用法：

    # 导入并全部标成 suspense、强度 3
    python3 scripts/import_bgm.py ~/music/*.mp3 --mood suspense --intensity 3

    # 逐个指定（推荐：desc 写好，模型挑曲质量直接取决于它）
    python3 scripts/import_bgm.py a.mp3 --mood triumph --intensity 4 \
        --name "逆袭燃点" --desc "弦乐上行、鼓点密集，适合打脸反击"

    # 看现有曲库
    python3 scripts/import_bgm.py --list

## 为什么 desc 必须写

agent 的选曲是「按 mood 过滤出几首 → 让模型读 desc 挑一首」。
desc 写得含糊（"好听的音乐"），模型就只能瞎挑；写得具体
（"低音持续、无旋律起伏，适合对峙与试探"），它才挑得准。
这比引入 embedding 检索省事得多，而且决策可解释。

## 目录

文件会被复制到 `filmweaver-data/bgm-library/`，manifest 记相对文件名。
**不移动原文件**（用户可能还要用），复制失败则中止，不留半条记录。

⚠️ 只允许导入**已获授权**的音频。manifest 里有 license 字段，
填不上就留空——前端会显示"授权状态未知"。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from app.bgm import EXTS, LIB_DIRNAME, MOODS  # noqa: E402
from app.media import DATA_DIR  # noqa: E402


def probe_duration(p: Path) -> float:
    """ffprobe 时长（秒）。量不出来返回 0 —— 不阻断导入。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(p)],
            capture_output=True, text=True, timeout=30)
        return round(float((out.stdout or "0").strip() or 0), 2)
    except Exception:  # noqa: BLE001
        return 0.0


def load(root: Path) -> list[dict]:
    mf = root / "manifest.json"
    if not mf.exists():
        return []
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
        return raw if isinstance(raw, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"⚠️ manifest 解析失败（{e}），将从空开始", file=sys.stderr)
        return []


def main() -> int:
    ap = argparse.ArgumentParser(description="导入配乐到曲库")
    ap.add_argument("files", nargs="*", help="音频文件（支持通配）")
    ap.add_argument("--list", action="store_true", help="只列出已有曲目")
    ap.add_argument("--mood", choices=sorted(MOODS), help="情绪主标签")
    ap.add_argument("--intensity", type=int, default=3, choices=range(1, 6),
                    metavar="1-5", help="强度 1~5")
    ap.add_argument("--name", help="曲目名（缺省用文件名）")
    ap.add_argument("--desc", default="", help="音乐描述（模型挑曲的依据，写具体）")
    ap.add_argument("--bpm", type=int, help="BPM（选填）")
    ap.add_argument("--vocals", action="store_true", help="有人声")
    ap.add_argument("--license", default="", help="授权说明")
    args = ap.parse_args()

    root = DATA_DIR / LIB_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    items = load(root)

    if args.list:
        if not items:
            print("曲库为空。")
            return 0
        print(f"共 {len(items)} 首：")
        for it in items:
            print(f"  {it.get('id', '?'):24s} {it.get('mood', '?'):10s} "
                  f"强度{it.get('intensity', '?')}  {it.get('name', '')}")
        return 0

    if not args.files:
        ap.error("没有指定文件（或加 --list 看曲库）")

    if not args.mood:
        ap.error("必须指定 --mood（取值：" + "/".join(sorted(MOODS)) + "）")

    used_ids = {it.get("id") for it in items}
    added = 0
    for f in args.files:
        src = Path(f).expanduser()
        if not src.is_file():
            print(f"⏭  跳过（不是文件）: {src}")
            continue
        if src.suffix.lower() not in EXTS:
            print(f"⏭  跳过（不支持的格式 {src.suffix}）: {src.name}")
            continue

        stem = src.stem
        # id 唯一化：同名文件加序号，不覆盖已有记录
        base_id = "".join(ch if ch.isalnum() or ch in "-_" else "_"
                          for ch in stem).strip("_") or "bgm"
        bid, n = base_id, 2
        while bid in used_ids:
            bid = f"{base_id}_{n}"
            n += 1
        used_ids.add(bid)

        dest_name = f"{bid}{src.suffix.lower()}"
        dest = root / dest_name
        try:
            shutil.copy2(src, dest)
        except OSError as e:
            print(f"❌ 复制失败，已跳过 {src.name}: {e}")
            continue

        dur = probe_duration(dest)
        item = {
            "id": bid,
            "name": args.name if (args.name and len(args.files) == 1) else stem,
            "file": dest_name,
            "duration": dur,
            "mood": args.mood,
            "intensity": args.intensity,
            "bpm": args.bpm,
            "instruments": [],
            "vocals": bool(args.vocals),
            "loopable": True,
            "desc": args.desc,
            "license": args.license,
        }
        items.append(item)
        added += 1
        print(f"✅ {bid:24s} {dur:6.1f}s  {item['name']}")

    if added:
        mf = root / "manifest.json"
        # 先写临时文件再改名：中途失败不会留下半个 manifest（那会让整个曲库读不出来）
        tmp = mf.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        tmp.replace(mf)
        print(f"\nmanifest 已更新：{mf}（共 {len(items)} 首）")
        print("提示：desc 写得越具体，agent 挑曲越准。")
    else:
        print("\n没有导入任何文件。")
    return 0 if added else 1


if __name__ == "__main__":
    sys.exit(main())
