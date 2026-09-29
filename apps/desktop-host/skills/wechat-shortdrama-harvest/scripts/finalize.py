#!/usr/bin/env python3
"""
finalize.py — 判集归档
========================
把 raw/ 里的裸视频判定成「第几集」，重命名归档。

双证据 + 全局最优：
  1. 官方集时长表作**硬约束**（|Δ| ≤ tol 秒）
  2. 官方分集封面做**画面余弦相似度**评分（权重高）
  3. scipy.optimize.linear_sum_assignment 求**全局最优配对**

为什么必须用画面：官方时长表有大量重复值（例：第 20、21 集都是 48 秒），
纯时长比对会把它们**对调**。实测正确集相似度 0.86~0.99、次名常 <0.45。

    python scripts/finalize.py                  # 归档
    python scripts/finalize.py --report-only    # 只出报告
    python scripts/finalize.py --no-visual      # 退回纯时长顺序比对
    python scripts/finalize.py --raw DIR        # 指定 raw 目录（默认 <工作区>/raw）
"""
import os, sys, glob, json, shutil, argparse, struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()

VIS_W = 8.0        # 画面权重（时长项上限 2.0，故画面主导）
DUR_W = 2.0
COVER_MIN = 10     # covers 少于这么多张就不启用画面判定

LAST_RESULT = None


# --------------------------------------------------- 回退：纯时长顺序比对（DP）
def align_seq(files, D, tol):
    n, m = len(files), len(D)
    NEG = -10 ** 6
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    ch = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best, bestc = dp[i - 1][j], ("skip_f", None)
            if dp[i][j - 1] > best:
                best, bestc = dp[i][j - 1], ("skip_ep", None)
            val = dp[i - 1][j - 1] + (100 if abs(files[i - 1][1] - D[j - 1]) <= tol else NEG)
            if val > best:
                best, bestc = val, ("match", j)
            dp[i][j], ch[i][j] = best, bestc
    assign, i, j = {}, n, m
    while i > 0 and j > 0:
        c = ch[i][j]
        if c is None:
            break
        if c[0] == "match":
            assign[i - 1] = j
            i, j = i - 1, j - 1
        elif c[0] == "skip_f":
            i -= 1
        else:
            j -= 1
    return assign, dp[n][m]


# --------------------------------------------------- 画面特征（可选依赖）
def load_cover_feats(covers_dir, eps):
    try:
        import numpy as np
        import verify as V
    except Exception:
        return None, None
    feats, cov = [], []
    for e in eps:
        ep = e.get("media_no")
        p = os.path.join(covers_dir, f"ep{ep:02d}.jpg")
        if not os.path.exists(p):
            continue
        img = V.imread_u(p)
        if img is None:
            continue
        feats.append(V.feat(img))
        cov.append(ep)
    if len(cov) < COVER_MIN:
        return None, None
    return np.stack(feats), cov


def sims_for_video(path, M, cov, n_eps):
    import numpy as np
    import verify as V
    out = np.zeros(n_eps, dtype=np.float32)
    frames = V.video_frames(path)
    if not frames or M is None:
        return out
    s = np.full(len(cov), -1.0, dtype=np.float32)
    for fr in frames:
        s = np.maximum(s, M @ V.feat(fr))
    for k, ep in enumerate(cov):
        out[ep - 1] = s[k]
    return out


# --------------------------------------------------- 全局最优分配
def align_visual(items, D, tol, M=None, cov=None):
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    n, m = len(items), len(D)
    BIG = 1e7
    Cm = np.zeros((n, m + n))          # 后 n 列 = "放弃该文件"的虚拟列
    Cm[:, :m] = BIG
    for i, it in enumerate(items):
        d = it.get("dur")
        if d is None:
            continue
        for j in range(m):
            delta = abs(d - D[j])
            if delta > tol:
                continue
            score = 1.0 + DUR_W * max(0.0, 1.0 - delta / tol)
            if it.get("_sims") is not None:
                score += VIS_W * float(it["_sims"][j])
            Cm[i, j] = -score
    r, c = linear_sum_assignment(Cm)
    assign = {}
    for i, j in zip(r, c):
        if j < m and Cm[i, j] < BIG / 2 and Cm[i, j] != 0.0:
            assign[i] = j + 1
    return assign


# --------------------------------------------------- main
def main():
    global LAST_RESULT
    ap = argparse.ArgumentParser()
    ap.add_argument("--tol", type=float, default=2.5, help="时长容差秒")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-visual", action="store_true")
    ap.add_argument("--raw", default=None, help="raw 目录（默认 <工作区>/raw）")
    args = ap.parse_args()
    Q = args.quiet

    eps = C.load_episodes()
    if not eps:
        print("❌ 还没有 drama.json（时长表）。先运行: python scripts/discover.py <drama_id>")
        return 1
    D = [e.get("duration") for e in eps]
    N = len(D)
    raw = args.raw or C.raw_dir(True)
    st = C.load_state()

    items = []
    for p in glob.glob(os.path.join(raw, "*.mp4")):
        fid = os.path.basename(p)[:-4]
        meta = C.mp4_meta(p)
        items.append({"fid": fid, "path": p,
                      "found": st["seen"].get(fid, {}).get("t", os.path.getmtime(p)),
                      "bucket": st["seen"].get(fid, {}).get("bucket", "?"),
                      **meta})
    items.sort(key=lambda x: x["found"])

    if not Q:
        print("=" * 84)
        print(f"剧目     : {C.load_config().get('drama_name')}")
        print(f"官方时长表: {N} 集，总 {sum(D)} 秒 = {sum(D)/60:.1f} 分钟")
        print(f"raw      : {len(items)} 个文件  ({raw})")
        print("=" * 84)
    if not items:
        print("[finalize] raw/ 空" if Q else "raw/ 里没有文件。先运行 harvest.py 收割，或 --raw 指定目录。")
        return 0

    method = "纯时长顺序比对"
    if not args.no_visual:
        M, cov = load_cover_feats(C.covers_dir(True), eps)
        if M is not None:
            for it in items:
                it["_sims"] = sims_for_video(it["path"], M, cov, N)
            method = "时长硬约束 + 画面全局最优分配"
    if method.startswith("纯时长"):
        for it in items:
            it["_sims"] = None

    if method.startswith("时长硬约束"):
        assign = align_visual(items, D, args.tol)
    else:
        assign, _ = align_seq([(i["fid"], i["dur"]) for i in items], D, args.tol)

    assigned, unknown = {}, []
    for idx, it in enumerate(items):
        ep = assign.get(idx)
        (assigned.setdefault(ep, []).append(it) if ep else unknown.append(it))

    missing = [e for e in range(1, N + 1) if e not in assigned]
    if Q:
        print(f"[finalize] 归位 {len(assigned)}/{N} | 未归位 {len(unknown)} | "
              f"缺: {missing[:14]}{'...' if len(missing) > 14 else ''}")
    else:
        print(f"\n判定方式: {method}")
        print(f"归位 {len(assigned)}/{N} 集，未归位 {len(unknown)} 个\n")
        print(f"{'集':>4} {'实测':>7} {'官方':>6} {'画面':>6} {'大小':>9}  状态")
        print("-" * 74)
        for ep in range(1, N + 1):
            if ep not in assigned:
                print(f"{ep:>4} {'—':>7} {D[ep-1]:>6} {'—':>6} {'—':>9}  ✗ 缺失")
                continue
            got = assigned[ep]
            if len(got) > 1:
                got = sorted(got, key=lambda x: -(x["_sims"][ep - 1]
                                                  if x["_sims"] is not None else 0))
            it = got[0]
            sim = it["_sims"][ep - 1] if it["_sims"] is not None else None
            dd = abs((it["dur"] or 0) - D[ep - 1])
            mark = ("⚠ 时长超差" if dd > args.tol else
                    "✓ 双重确认" if sim is not None and sim >= 0.70 else
                    "✓ 时长确认(封面为海报)" if sim is not None and sim < 0.50 else
                    "✓ 时长确认")
            extra = f"  (+{len(got)-1} 重复)" if len(got) > 1 else ""
            print(f"{ep:>4} {str(it['dur']):>7} {D[ep-1]:>6} "
                  f"{(f'{sim:.3f}' if sim is not None else '—'):>6} "
                  f"{it['size']/1024/1024:>7.2f}MB  {mark}{extra}")
        if unknown:
            print("\n未归位文件（时长不匹配任何一集）：")
            for it in unknown:
                print(f"   {it['fid']}  {it['dur']}s  {it['size']/1024/1024:.2f}MB  桶={it['bucket']}")

    # 报告
    rep = os.path.join(C.drama_dir(True), "report.md")
    with open(rep, "w", encoding="utf-8") as f:
        f.write(f"# {C.load_config().get('drama_name')} · 归档报告\n\n")
        f.write(f"- 判定方式：{method}\n")
        f.write(f"- 官方集数：{N}（总 {sum(D)} 秒 / {sum(D)/60:.1f} 分钟）\n")
        f.write(f"- 已收割文件：{len(items)}\n")
        f.write(f"- **归位成功：{len(assigned)} / {N}**\n")
        f.write(f"- 缺失 {len(missing)} 集：{missing}\n\n")
        f.write("| 集 | 实测时长 | 官方 | 画面相似度 | 大小 | 文件 |\n|--:|--:|--:|--:|--:|---|\n")
        for ep in range(1, N + 1):
            if ep not in assigned:
                f.write(f"| {ep} | — | {D[ep-1]} | — | — | **缺失** |\n")
                continue
            it = assigned[ep][0]
            sim = it["_sims"][ep - 1] if it["_sims"] is not None else None
            f.write(f"| {ep} | {it['dur']} | {D[ep-1]} | "
                    f"{(f'{sim:.3f}' if sim is not None else '—')} | "
                    f"{it['size']/1024/1024:.2f}MB | `{it['fid']}.mp4` |\n")
    if not Q:
        print(f"\n报告 -> {rep}")

    LAST_RESULT = {"assigned": len(assigned), "missing": missing,
                   "unknown": len(unknown), "total": N, "method": method}

    if args.report_only:
        return 0

    # 归档
    out = C.out_dir(True)
    prefix = C.sanitize(C.load_config().get("drama_name"))
    n_ok = 0
    for ep in range(1, N + 1):
        if ep not in assigned:
            continue
        it = sorted(assigned[ep], key=lambda x: -x["size"])[0]
        dst = os.path.join(out, f"{prefix}_第{ep:02d}集.mp4")
        C.copy_media(it["path"], dst)
        n_ok += 1
    if not Q:
        print(f"已归档 {n_ok} 集 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
