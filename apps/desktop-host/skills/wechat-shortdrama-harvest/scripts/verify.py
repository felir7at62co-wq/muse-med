#!/usr/bin/env python3
"""
verify.py — 画面反查验证（独立第二意见）
==========================================
用官方分集封面反查每个视频到底是第几集，与 finalize 的判定互相印证。

实测校准：
  · 封面是**剧照**时极准 —— 正确集 0.86~0.99，次名常 <0.45（压倒性）
  · 封面是**宣传海报**时无效 —— 正确集也只有 0.19~0.40（此时不可作为证据，但也不会误导）
所以本工具定位为「能确证时极强、不能确证时不否定」，阈值分级而非一刀切。

    python scripts/verify.py                 # 反查 raw/ 所有文件
    python scripts/verify.py --topn 5
    python scripts/verify.py --dir <目录>

本模块还被 finalize.py 复用来提取画面特征（imread_u / feat / video_frames）。
"""
import os, sys, glob, json, argparse, urllib.request
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()


# ------------------------------------------------------ 中文路径安全的读写
def imread_u(path):
    """cv2.imread 处理不了中文路径，用字节流绕过"""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def imwrite_u(path, img):
    """cv2.imwrite 对中文目录路径会静默失败，用 imencode + tofile"""
    ok, buf = cv2.imencode(os.path.splitext(path)[1] or ".png", img)
    if ok:
        buf.tofile(path)
    return ok


# ------------------------------------------------------ 特征
def feat(img):
    """取画面中部 -> 灰度 32x32 -> 直方图均衡 -> 单位向量（避开底部字幕）"""
    h, w = img.shape[:2]
    crop = img[int(h * 0.05):int(h * 0.78), int(w * 0.05):int(w * 0.95)]
    g = cv2.cvtColor(cv2.resize(crop, (32, 32)), cv2.COLOR_BGR2GRAY)
    g = cv2.equalizeHist(g).astype(np.float32).ravel()
    g -= g.mean()
    n = np.linalg.norm(g)
    return g / n if n else g


def video_frames(path, times=(0.5, 1.5, 2.5, 4.0)):
    cap = cv2.VideoCapture(path)
    out = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, fr = cap.read()
        if ok:
            out.append(fr)
    cap.release()
    return out


# ------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--topn", type=int, default=3)
    ap.add_argument("--dir", default=None, help="要反查的目录（默认 <工作区>/raw）")
    args = ap.parse_args()

    eps = C.load_episodes()
    if not eps:
        print("❌ 还没有 drama.json。先运行: python scripts/discover.py <drama_id>")
        return 1

    cov_dir = C.covers_dir(True)
    M, cov = [], []
    for e in eps:
        ep = e.get("media_no")
        p = os.path.join(cov_dir, f"ep{ep:02d}.jpg")
        if not os.path.exists(p):
            # 顺手补下
            try:
                req = urllib.request.Request(e["cover_url"], headers={"User-Agent": C.UA})
                with urllib.request.urlopen(req, timeout=20) as r, open(p, "wb") as f:
                    f.write(r.read())
            except Exception:
                continue
        img = imread_u(p)
        if img is not None:
            M.append(feat(img))
            cov.append(ep)
    if len(cov) < 10:
        print(f"❌ 可用封面太少（{len(cov)} 张），无法可靠反查")
        return 1
    M = np.stack(M)
    print(f"封面特征矩阵: {M.shape}")

    d = args.dir or C.raw_dir(True)
    files = sorted(glob.glob(os.path.join(d, "*.mp4")))
    if not files:
        print(f"{d} 里没有 mp4")
        return 0

    print(f"\n反查 {len(files)} 个文件（余弦相似度，取多帧最大值）\n")
    print(f"{'文件':>30} {'时长':>7} {'首选':>6} {'相似度':>8}   前{args.topn}候选")
    print("-" * 96)
    results = {}
    for p in files:
        frames = video_frames(p)
        if not frames:
            continue
        sims = np.full(len(cov), -1.0)
        for fr in frames:
            sims = np.maximum(sims, M @ feat(fr))
        order = np.argsort(-sims)[:args.topn]
        top = [(cov[i], round(float(sims[i]), 4)) for i in order]
        results[os.path.basename(p)] = top
        dur = C.mp4_duration(p)
        print(f"{os.path.basename(p)[:30]:>30} {str(dur):>7} {top[0][0]:>6} {top[0][1]:>8.4f}   "
              + "  ".join(f"ep{e}:{s:.3f}" for e, s in top))

    out = os.path.join(C.drama_dir(True), "verify_result.json")
    json.dump(results, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n结果 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
