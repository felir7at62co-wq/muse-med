#!/usr/bin/env python3
"""
status.py — 一句话总览
========================
agent 或人想快速知道「现在什么情况」时调这个。

    python scripts/status.py
    python scripts/status.py --json     # 机器可读
"""
import os, sys, glob, json, argparse, platform

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()


def gather():
    cfg = C.load_config()
    eps = C.load_episodes()
    st = C.load_state()
    prefix = C.sanitize(cfg.get("drama_name"))
    out = C.out_dir(True)
    files = glob.glob(os.path.join(out, "*.mp4"))
    have = set()
    for p in files:
        try:
            have.add(int(os.path.basename(p).split("第")[1][:2]))
        except Exception:
            pass
    total = cfg.get("episode_count") or len(eps) or 0
    ok = sum(1 for v in st["seen"].values() if v.get("ok"))
    bad = sum(1 for v in st["seen"].values() if v.get("ok") is False)
    size = sum(os.path.getsize(p) for p in files)
    return {
        "drama_name": cfg.get("drama_name"),
        "drama_id": cfg.get("drama_id"),
        "episode_count": total,
        "wechat_cache": C.wechat_profile_root(),
        "cache_files": len(C.cache_files()),
        "harvested": len(st["seen"]),
        "downloaded": ok,
        "failed": bad,
        "finder": len(st.get("finder", {})),
        "archived": len(files),
        "archived_episodes": sorted(have),
        "missing": [e for e in range(1, total + 1) if e not in have] if total else [],
        "out_dir": out,
        "total_mb": round(size / 1024 / 1024, 1),
        "buckets": cfg["buckets"].get("target", []),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = gather()

    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 0

    ready = bool(r["wechat_cache"]) and bool(r["drama_name"])
    if not r["drama_name"]:
        print("状态: ❌ 还没初始化")
        print("  下一步: python scripts/doctor.py --install")
        print("          python scripts/discover.py <drama_id>")
    elif not r["wechat_cache"]:
        print("状态: ❌ 找不到微信缓存（装了微信 PC 版并登录、开过一次小程序）")
    else:
        prog = f"{r['archived']}/{r['episode_count'] or '?'}"
        print(f"状态: {'✅ 已完成' if r['episode_count'] and not r['missing'] else '🔄 进行中'}")
        print(f"  剧目     : {r['drama_name']}  (drama_id={r['drama_id']})")
        print(f"  进度     : 已归档 {prog} 集   {r['total_mb']} MB")
        print(f"  收割     : 直链 {r['harvested']} / 下载成功 {r['downloaded']} / 失败 {r['failed']}"
              + (f" / 视频号 {r['finder']}" if r["finder"] else ""))
        print(f"  目标桶   : {r['buckets'] or '（靠探针自动发现）'}")
        print(f"  输出     : {r['out_dir']}")
        if r["missing"]:
            print(f"  缺失     : {r['missing']}")
            print(f"  下一步   : 在微信里播这些集（每集播到画面动起来）→ python scripts/harvest.py")
        else:
            print("  下一步   : 无，已齐活")
    return 0


if __name__ == "__main__":
    sys.exit(main())
