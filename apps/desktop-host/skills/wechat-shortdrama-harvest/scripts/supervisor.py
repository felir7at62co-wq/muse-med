#!/usr/bin/env python3
"""
supervisor.py — 后台总控（全自动流水线）
==========================================
把「收割 → 下载 → 归档 → 校验」串成常驻进程。你在微信里播，其余全自动。

它做五件事：
  1. 常驻轮询缓存，收割直链并立即下载
  2. 定期自动归档：新集一到就判集、命名、落盘
  3. 卡顿告警：长时间没新集就提醒（广告卡住/暂停/播错集）
  4. 集数齐了自动跑画面反查 + 生成 DONE.md，然后退出
  5. 掉线自愈：单次异常不会让守护进程退出

    python scripts/supervisor.py
    python scripts/supervisor.py --max-minutes 150
    python scripts/supervisor.py --stall-minutes 20

配套 `run-forever.bat` 可在崩溃后自动重启（它认退出码 3 = 已有实例，据此停止循环）。
"""
import os, sys, time, glob, json, argparse, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import harvest as H
import finalize as F

C.force_utf8()

TOTAL_DEFAULT = 0


def log_path():
    return os.path.join(C.drama_dir(True), "supervisor.log")


def done_path():
    return os.path.join(C.drama_dir(True), "DONE.md")


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(log_path(), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def counts(total_expected=0):
    st = C.load_state()
    ok = sum(1 for v in st["seen"].values() if v.get("ok"))
    prefix = C.sanitize(C.load_config().get("drama_name"))
    arch = len(glob.glob(os.path.join(C.out_dir(True), f"{prefix}_第*集.mp4")))
    return len(st["seen"]), ok, arch


def write_done(arch, total):
    st = C.load_state()
    by = {}
    for v in st["seen"].values():
        b = v.get("bucket", "?")
        by[b] = by.get(b, 0) + 1
    prefix = C.sanitize(C.load_config().get("drama_name"))
    files = glob.glob(os.path.join(C.out_dir(True), "*.mp4"))
    size = sum(os.path.getsize(p) for p in files)
    name = C.load_config().get("drama_name")
    L = [f"# {name} · 采集完成报告", "",
         f"- 完成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
         f"- 输出目录：`{C.out_dir()}`",
         f"- 官方集数：{total}",
         f"- **已归档：{arch}/{total}**",
         f"- 文件数：{len(files)}   总体积：{size/1024/1024:.1f} MB",
         f"- 按桶统计：{by}", ""]
    if total and arch < total:
        miss = [i for i in range(1, total + 1)
                if not os.path.exists(os.path.join(C.out_dir(True), f"{prefix}_第{i:02d}集.mp4"))]
        L += [f"- **缺失：{miss}**", "",
              "把缺失集在微信里重播（每集播到画面动起来、播过缓存边界），再跑 supervisor.py。"]
    else:
        L += ["- 全部到齐 ✅", "", "明细见 `report.md`，画面反查见 `verify_result.json`。"]
    open(done_path(), "w", encoding="utf-8").write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=None)
    ap.add_argument("--archive-every", type=float, default=90.0)
    ap.add_argument("--stall-minutes", type=float, default=12.0)
    ap.add_argument("--max-minutes", type=float, default=0, help="0=不限")
    args = ap.parse_args()

    cfg_all = C.load_config()
    b = cfg_all["buckets"]
    if not b.get("baseline_t"):
        b["baseline_t"] = C.max_url_t(b.get("target"))
        cfg_all["buckets"] = b
        C.save_config(cfg_all)
    H.BASELINE_T = b["baseline_t"]
    H.load_durations()

    total = cfg_all.get("episode_count") or 0
    iv = args.interval or cfg_all.get("poll_interval", 3.0)

    # 单实例锁。拿不到 -> 退出码 3，让外层 run-forever.bat 停止循环（避免疯狂空转）
    lock = H.acquire_lock(os.path.join(C.WORK_ROOT, "supervisor.lock"))
    if lock is None:
        print("已有 supervisor 实例在运行，本实例退出。")
        return 3

    log("=" * 68)
    log(f"后台总控 已启动   [{C.load_config().get('drama_name')}]")
    log(f"  · 目标        : {total or '?'} 集")
    log(f"  · 目标桶      : {b['target'] or '（空，靠探针自动发现）'}")
    log(f"  · 时间基线    : {H.BASELINE_T:#x}")
    log(f"  · 自动归档    : 每 {args.archive_every:.0f} 秒")
    log(f"  · 输出目录    : {C.out_dir()}")
    log("  · 你需要做的  : 在微信 PC 版里打开该剧，依次播到每一集的画面动起来")
    log("=" * 68)

    last_new = time.time()
    last_arch = 0.0
    last_count = counts()[2]
    t0 = time.time()
    log(f"起步：已归档 {last_count}/{total or '?'} 集")

    while True:
        try:
            n = H.scan_once(quiet=False, cfg=b)
            if n:
                log(f"收割到 {n} 条新直链")
                last_new = time.time()
                last_arch = 0.0

            if time.time() - last_arch > args.archive_every:
                last_arch = time.time()
                try:
                    sys.argv = ["finalize.py", "--quiet"]
                    F.main()
                except SystemExit:
                    pass
                except Exception:
                    log("归档异常（已忽略）:\n" + traceback.format_exc(limit=3))

                _, okn, arch = counts()
                if arch != last_count:
                    log(f"★ 归档推进：{arch}/{total or '?'} 集  (+{arch - last_count})")
                    last_count = arch
                    last_new = time.time()

                if total and arch >= total:
                    log(f"全部 {total} 集已归档！开始画面反查校验 …")
                    try:
                        import verify as V
                        sys.argv = ["verify.py"]
                        V.main()
                    except SystemExit:
                        pass
                    except Exception:
                        log("校验异常（不影响文件）:\n" + traceback.format_exc(limit=3))
                    write_done(arch, total)
                    log(f"完成报告 -> {done_path()}")
                    log("后台总控 正常退出。")
                    return 0

            idle = (time.time() - last_new) / 60.0
            if idle > args.stall_minutes:
                log(f"⚠ 已 {idle:.1f} 分钟没有新集（当前 {last_count}/{total or '?'}）。"
                    f"请确认：还在播放？播放器是否停在广告/暂停？播的是缺的那一集吗？")
                last_new = time.time()

            if args.max_minutes and (time.time() - t0) / 60.0 > args.max_minutes:
                log(f"达到运行上限 {args.max_minutes} 分钟，收尾（已归档 {last_count}）。")
                write_done(last_count, total)
                return 0

            time.sleep(iv)

        except KeyboardInterrupt:
            log("收到中断，退出。")
            write_done(counts()[2], total)
            return 0
        except Exception:
            log("主循环异常（自愈继续）:\n" + traceback.format_exc(limit=3))
            time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
