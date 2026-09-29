#!/usr/bin/env python3
"""
salvage.py — 缓存分片重建（URL 丢了也能救回来）
=================================================
微信 Chromium 缓存把视频切成 **1MB 定长块**：
  · 只有第 0 块以 `ftyp` 开头，续传块是裸数据（无头无 magic）
  · 这些短剧 mp4 是 **moov 前置**（ftyp→moov→free→mdat）
    → 所以只读第 0 块就能得到完整时长 → 可反查集号
  · 同一次播放的分片写入时间相邻（mtime 差 0~3 秒）

重建算法：
  1. 扫出所有以 ftyp 开头的块（= 视频起点）
  2. 用时长 + 官方封面画面相似度定集号
  3. 从 box 结构读出完整文件大小 T（mdat 末端）
  4. 把 mtime 邻近的非起点块按序接上，截断到 T
  5. cv2 解码验证帧数

    python scripts/salvage.py                 # 扫描 + 尝试重建缺失集
    python scripts/salvage.py --list          # 只列出缓存里的视频块及集号
    python scripts/salvage.py --window 10     # 分片配对的 mtime 窗口（秒）
    python scripts/salvage.py --no-archive    # 只重建不归档
"""
import os, sys, glob, json, time, shutil, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()


def cache_dirs():
    root = C.wechat_profile_root()
    if not root:
        return []
    return [cd for cd in glob.glob(os.path.join(root, "*", "Cache", "Cache_Data"))
            if os.path.isdir(cd)]


def scan_blocks(min_size=8):
    """扫出所有 f_* 缓存块。

    ⚠ min_size 默认必须很小：**尾块可能只有几百 KB**（实测 289KB / 282KB）。
    曾用 400_000 做下限，结果尾块被过滤掉、拼出的文件少了几百 KB 却“验证通过”。
    """
    """返回 {path: {name, size, mtime, start(bool)}} 以及按目录分组"""
    blocks = []
    for cd in cache_dirs():
        for fp in glob.glob(os.path.join(cd, "f_*")):
            try:
                st = os.stat(fp)
            except OSError:
                continue
            if st.st_size < min_size:
                continue
            try:
                head = C.read_shared(fp)[:16]
            except OSError:
                continue
            blocks.append({"path": fp, "dir": cd, "name": os.path.basename(fp),
                           "size": st.st_size, "mtime": st.st_mtime,
                           "start": head[4:8] == b"ftyp"})
    return blocks


def identify(path, M, cov, D, arch):
    """返回 (时长, 画面top, 集号, 相似度)"""
    import numpy as np
    import verify as V
    dur = C.mp4_duration(path)
    top = []
    if M is not None:
        frames = V.video_frames(path)
        if frames:
            sims = np.full(len(cov), -1.0)
            for fr in frames:
                sims = np.maximum(sims, M @ V.feat(fr))
            top = [(cov[i], round(float(sims[i]), 3)) for i in np.argsort(-sims)[:3]]
    ep = top[0][0] if top else None
    sim = top[0][1] if top else None
    return dur, top, ep, sim


def rebuild(S, others, T, window, outdir):
    """按 mtime 顺序接续传块。
    返回 (路径, 已用块名, 拼出字节数, 是否达到声明大小 T)"""
    cands = [b for b in others
             if not b["start"] and b["dir"] == S["dir"]
             and abs(b["mtime"] - S["mtime"]) <= window]
    cands.sort(key=lambda x: (x["mtime"], x["name"]))
    blob = C.read_shared(S["path"])
    used = []
    for c in cands:
        if len(blob) >= T:
            break
        blob += C.read_shared(c["path"])
        used.append(c["name"])
    reaches = len(blob) >= T
    if reaches:
        blob = blob[:T]
    name = f"rb_{S['name']}.mp4"
    p = os.path.join(outdir, name)
    open(p, "wb").write(blob)
    return p, used, len(blob), reaches


def completeness(path, expect_dur, declared_T):
    """完整性判定。

    为什么不用「moov 存在 + 解码>0 帧」：这些 mp4 是 **moov 前置** 的，
    截断的 mdat 依然能解出大部分帧（实测截断版 1198 帧 / 完整 1373 帧），
    旧判据会**静默放行残缺文件**。

    正确判据：解出的帧数应接近 时长×fps（实测 ep11: 57.22s×24fps = 1373 帧，完全吻合）。
    返回 (是否完整, 诊断字典)
    """
    import cv2
    meta = C.mp4_meta(path)
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    nf = 0
    while True:
        ok, _ = cap.read()
        if not ok:
            break
        nf += 1
    cap.release()
    dur = meta["dur"] or 0
    expect_frames = dur * fps if (dur and fps) else 0
    ratio = (nf / expect_frames) if expect_frames else 0
    info = {"dur": dur, "fps": round(fps, 2), "frames": nf,
            "expect_frames": round(expect_frames), "ratio": round(ratio, 3),
            "size": meta["size"], "declared": declared_T,
            "size_ratio": round(meta["size"] / declared_T, 3) if declared_T else 0,
            "has_moov": meta["has_moov"]}
    ok = bool(meta["has_moov"] and nf > 0 and ratio >= 0.97
              and (not expect_dur or abs(dur - expect_dur) < 1.5))
    return ok, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出缓存里的视频块")
    ap.add_argument("--window", type=float, default=8.0, help="分片配对 mtime 窗口（秒）")
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--min-size", type=int, default=8,
                    help="块大小下限（默认 8，必须小 —— 尾块可能只有几百 KB）")
    args = ap.parse_args()

    eps = C.load_episodes()
    if not eps:
        print("❌ 还没有 drama.json。先运行: python scripts/discover.py <drama_id>")
        return 1
    D = [e.get("duration") for e in eps]

    # 已归档集
    prefix = C.sanitize(C.load_config().get("drama_name"))
    arch = {}
    for p in glob.glob(os.path.join(C.out_dir(True), f"{prefix}_第*集.mp4")):
        try:
            ep = int(os.path.basename(p).split("第")[1][:2])
            arch[ep] = C.mp4_duration(p)
        except Exception:
            pass
    missing = [e for e in range(1, len(D) + 1) if e not in arch]
    print(f"已归档 {len(arch)}/{len(D)}，缺 {missing}")

    blocks = scan_blocks(args.min_size)
    starts = sorted([b for b in blocks if b["start"]], key=lambda x: -x["mtime"])
    print(f"缓存块 {len(blocks)} 个（其中视频起点 {len(starts)} 个）\n")

    # 画面特征
    M = cov = None
    import numpy as np
    import verify as V
    covd = C.covers_dir(True)
    feats, cps = [], []
    for e in eps:
        p = os.path.join(covd, f"ep{e['media_no']:02d}.jpg")
        if os.path.exists(p):
            img = V.imread_u(p)
            if img is not None:
                feats.append(V.feat(img))
                cps.append(e["media_no"])
    if len(cps) >= 10:
        import numpy as _np
        M, cov = _np.stack(feats), cps

    outdir = os.path.join(C.drama_dir(True), "salvage")
    os.makedirs(outdir, exist_ok=True)

    rows = []
    for S in starts:
        d0 = C.read_shared(S["path"])
        T = C.mp4_total_from_boxes(d0) or S["size"]
        # 先用第 0 块本身定集号（moov 前置，够用）
        tmp = os.path.join(outdir, f"head_{S['name']}.mp4")
        open(tmp, "wb").write(d0)
        dur, top, ep, sim = identify(tmp, M, cov, D, arch)
        complete = T <= S["size"] + 50_000
        rows.append({"S": S, "T": T, "dur": dur, "top": top, "ep": ep, "sim": sim,
                     "complete": complete,
                     "mtime": time.strftime("%H:%M:%S", time.localtime(S["mtime"]))})

    print(f"{'起点块':>10} {'时间':>9} {'时长':>7} {'声明':>7} {'本块':>7} {'画面':>14}  判定")
    print("-" * 88)
    for r in sorted(rows, key=lambda x: x["mtime"]):
        verdict = ""
        if r["ep"] and r["sim"] and r["sim"] >= 0.70:
            verdict = (f"= 第{r['ep']}集(已有)" if r["ep"] in arch
                       else f"★★★ 第{r['ep']}集【缺失·可重建】")
        cand = [k + 1 for k, v in enumerate(D) if r["dur"] and abs(v - r["dur"]) <= 2.5]
        print(f"{r['S']['name']:>10} {r['mtime']:>9} {str(r['dur']):>7} "
              f"{r['T']/1024/1024:>6.2f}M {r['S']['size']/1024/1024:>6.2f}M "
              f"{str(r['top'][:2]):>14}  {verdict or ('时长候选' + str(cand[:6]))}")

    if args.list:
        return 0

    todo = [r for r in rows if r["ep"] and r["sim"] and r["sim"] >= 0.70
            and r["ep"] not in arch]
    print(f"\n可重建的缺失集: {[r['ep'] for r in todo]}")
    if not todo:
        print("没有可重建的缺失集。")
        return 0

    saved = {}
    for r in todo:
        p, used, got, reaches = rebuild(r["S"], blocks, r["T"], args.window, outdir)
        ok, info = completeness(p, r["dur"], r["T"])
        flag = "✅" if ok else "⚠ 不完整·不入库"
        print(f"  ★ 第{r['ep']}集 <- {r['S']['name']} + {used}")
        print(f"     {info['size']/1024/1024:.2f}MB / 声明 {r['T']/1024/1024:.2f}MB "
              f"(达T={reaches})   时长{info['dur']}s  fps{info['fps']}   "
              f"帧数 {info['frames']}/{info['expect_frames']} ({info['ratio']:.1%})  {flag}")
        if not ok:
            print("     ↳ 分片不全（缓存里只留了这些）。让用户重播这一集，或接受残缺。")
            continue
        saved[r["ep"]] = p
        if not args.no_archive:
            dst = os.path.join(C.out_dir(True), f"{prefix}_第{r['ep']:02d}集.mp4")
            C.copy_media(p, dst)
            print(f"     已归档 -> {dst}")

    if saved:
        print(f"\n✅ 重建并归档: {sorted(saved.keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
