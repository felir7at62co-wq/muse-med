#!/usr/bin/env python3
"""
harvest.py — 短剧直链收割器
============================
原理：微信 PC 版的 Chromium 渲染进程会把播放器请求的**完整签名直链**
      以明文写进磁盘缓存。本脚本轮询这些缓存文件，抄走直链并**立即整集下载**。

      「播一下」只是为了让微信去生成那行直链 —— 下载是我们自己干的，
      所以播放时长与结果无关（微信只下了它要显示的那部分，我们拉全集）。

    python scripts/harvest.py                 # 前台收割（Ctrl+C 停止）
    python scripts/harvest.py --status        # 只看进度
    python scripts/harvest.py --retry         # 重试之前失败的
    python scripts/harvest.py --once          # 只扫一轮
    python scripts/harvest.py --show-buckets  # 列出见过的 VOD 桶
    python scripts/harvest.py --add-bucket B  # 手动指定桶

⚠ VOD 桶按【分发渠道】划分，不按内容方。同一部剧换渠道就换桶。
  所以未知桶靠「时长探针」自动识别：先下一个文件量时长，命中官方时长表才采纳。
"""
import os, sys, json, re, time, glob, hashlib, argparse, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()

# ---------------------------------------------------------------- 模块状态
_stamp = {}          # path -> (mtime,size)  跳过未变化的文件
BASELINE_T = 0       # 时间基线：只接受 t 比它新的直链
DUR_TABLE = []       # 官方每集时长表（用于探针校验）
_lock_fh = None


def load_durations():
    global DUR_TABLE
    DUR_TABLE = [e.get("duration") for e in C.load_episodes()]
    return DUR_TABLE


def episodes():
    return C.load_episodes()


# ---------------------------------------------------------------- 单实例锁
def acquire_lock(path):
    """Windows 文件锁；进程死了自动释放"""
    try:
        import msvcrt
        fh = open(path, "w")
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        fh.write(str(os.getpid()))
        fh.flush()
        return fh
    except Exception:
        return None


# ---------------------------------------------------------------- 下载
def _fetch(fileid, url, headers, min_size=200_000):
    dst = os.path.join(C.raw_dir(True), f"{fileid}.mp4")
    tmp = dst + ".part"
    try:
        req = urllib.request.Request(url, headers=headers)
        got = 0
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
        with open(tmp, "rb") as f:
            head = f.read(16)
        if b"ftyp" not in head or got < min_size:
            return {"ok": False, "error": f"not mp4 ({got}B head={head[:12].hex()})"}
        os.replace(tmp, dst)
        return {"ok": True, "size": got}
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def download(fileid, url):
    """小程序 CDN：不校验 Referer，裸请求即可"""
    return _fetch(fileid, url, {"User-Agent": C.UA, "Accept": "*/*"})


def download_finder(fileid, url):
    """视频号 CDN：可能校验 Referer/Origin，多套请求头依次重试"""
    variants = [
        {},
        {"Referer": "https://channels.weixin.qq.com/"},
        {"Referer": "https://channels.weixin.qq.com/", "Origin": "https://channels.weixin.qq.com"},
        {"Referer": "https://mp.weixin.qq.com/"},
    ]
    last = "no attempt"
    for hv in variants:
        h = {"User-Agent": C.UA, "Accept": "*/*", **(hv or {})}
        r = _fetch(fileid, url, h)
        if r.get("ok"):
            r["headers"] = hv or "plain"
            return r
        last = r.get("error")
    return {"ok": False, "error": last}


# ---------------------------------------------------------------- 桶探针
def probe_bucket(bucket, url, fileid, cfg):
    """未知桶：下一个文件量时长；命中官方时长表才采纳该桶，否则拉黑并删除探针。"""
    if not DUR_TABLE:
        C.say(f"\n  [未知桶] {bucket} 跳过（还没有 drama.json 时长表，先跑 discover.py）")
        return False
    C.say(f"\n  [候选新桶] {bucket} 下载探针校验时长 …")
    res = download(fileid, url)
    if not res.get("ok"):
        C.say(f"              ✗ 探针下载失败: {res.get('error')}（不拉黑，待重试）")
        return False
    p = os.path.join(C.raw_dir(True), fileid + ".mp4")
    dur = C.mp4_duration(p)
    hit = [i + 1 for i, d in enumerate(DUR_TABLE) if dur and d and abs(d - dur) <= 2.5]
    st = C.load_state()
    if hit:
        if bucket not in cfg["target"]:
            cfg["target"].append(bucket)
        C.save_config(_cfg_wrap(cfg))
        st["seen"][fileid] = {"url": url, "t": time.time(), "ok": True,
                              "size": res.get("size"), "bucket": bucket,
                              "probe": True, "dur": dur}
        C.save_state(st)
        C.say(f"              ✓ 时长 {dur}s 命中第{hit[:6]}集 → 采纳该桶")
        return True
    cfg.setdefault("rejected", []).append(bucket)
    C.save_config(_cfg_wrap(cfg))
    try:
        os.remove(p)
    except OSError:
        pass
    C.say(f"              ✗ 时长 {dur}s 不匹配（共{len(DUR_TABLE)}集）→ 拉黑该桶")
    return False


def _cfg_wrap(buckets: dict) -> dict:
    """把 buckets 结构写回顶层 config"""
    cfg = C.load_config()
    cfg["buckets"] = buckets
    return cfg


# ---------------------------------------------------------------- 扫描
def scan_once(quiet=False, deep=False, force=False, cfg=None) -> int:
    cfg = cfg if cfg is not None else C.load_config()["buckets"]
    found = 0
    for f in C.cache_files(deep):
        try:
            sk = (os.path.getmtime(f), os.path.getsize(f))
        except OSError:
            continue
        if not force and _stamp.get(f) == sk:
            continue
        _stamp[f] = sk
        try:
            data = C.read_shared(f)
        except OSError:
            continue

        # ---------- 渠道①：小程序短剧播放器 ----------
        for m in C.URL_RE.finditer(data):
            bucket = m.group(2).decode()
            fileid = m.group(3).decode()
            t_gen = int(m.group(4), 16)
            url = m.group(0).decode()

            # 第 1 关：时间闸门（只收本次播放新生成的，屏蔽缓存里的历史直链）
            if t_gen <= BASELINE_T:
                continue

            # 第 2 关：桶判定（先过闸门，才允许探针自动采纳新桶）
            seen_b = cfg.setdefault("all_seen", {})
            if bucket in cfg.setdefault("rejected", []):
                continue
            if bucket not in cfg["target"]:
                if not cfg.get("auto_add", True):
                    continue
                if not probe_bucket(bucket, url, fileid, cfg):
                    continue
            if bucket not in seen_b:
                seen_b[bucket] = {"first": time.strftime("%Y-%m-%d %H:%M:%S"),
                                  "vodappid": m.group(1).decode(), "n": 0}
            seen_b[bucket]["n"] = seen_b[bucket].get("n", 0) + 1

            st = C.load_state()
            prev = st["seen"].get(fileid)
            if prev:
                if prev.get("ok"):
                    continue
                # 失败过的，只有拿到更新的签名才重试
                if prev.get("ok") is False and t_gen <= prev.get("t_gen", 0):
                    continue
            found += 1
            if not quiet:
                C.say(f"  [新直链] {fileid}  -> 立即下载 …")
            res = download(fileid, url)
            st["seen"][fileid] = {"url": url, "t": time.time(),
                                  "ok": res.get("ok"), "bucket": bucket,
                                  "t_gen": t_gen, "size": res.get("size"),
                                  "error": res.get("error")}
            if res.get("ok"):
                if not quiet:
                    C.say(f"           ✓ {res['size']/1024/1024:.2f} MB")
            else:
                st["failed"][fileid] = url
                if not quiet:
                    C.say(f"           ✗ {res.get('error')}")
            C.save_state(st)

        # ---------- 渠道②：视频号原生短剧（token 一次性，发现即下）----------
        for fm in C.FINDER_RE.finditer(data):
            if C.FINDER_VIDEO_FLAG not in fm.group(0):
                continue                      # 封面图，跳过
            furl = fm.group(0).decode("ascii", "replace")
            st = C.load_state()
            ff = st.setdefault("finder", {})
            if furl in ff:
                continue
            found += 1
            fid = "finder" + hashlib.md5(furl.encode()).hexdigest()[:16]
            if not quiet:
                C.say(f"  [视频号直链] …{furl[-52:-12]}  -> 立即下载 …")
            res = download_finder(fid, furl)
            ff[furl] = {"t": time.time(), "ok": res.get("ok"),
                        "error": res.get("error"), "size": res.get("size")}
            if res.get("ok"):
                if not quiet:
                    C.say(f"           ✓ {res['size']/1024/1024:.2f} MB")
            else:
                if not quiet:
                    C.say(f"           ✗ {res.get('error')}")
            C.save_state(st)

    return found


# ---------------------------------------------------------------- main
def progress():
    st = C.load_state()
    ok = sum(1 for v in st["seen"].values() if v.get("ok"))
    bad = sum(1 for v in st["seen"].values() if v.get("ok") is False)
    by = {}
    for v in st["seen"].values():
        b = v.get("bucket", "?")
        by[b] = by.get(b, 0) + 1
    total = C.load_config().get("episode_count") or "?"
    C.say(f"[进度] 直链 {len(st['seen'])} 个 | 下载成功 {ok} | 失败 {bad} | 目标 {total} 集")
    if by:
        C.say("       按桶: " + "  ".join(f"{k}:{v}" for k, v in by.items()))
    fd = st.get("finder", {})
    if fd:
        C.say(f"       视频号: {len(fd)} 条（成功 {sum(1 for v in fd.values() if v.get('ok'))}）")


def main():
    global BASELINE_T, _lock_fh
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=None, help="轮询间隔秒")
    ap.add_argument("--status", action="store_true", help="只显示进度")
    ap.add_argument("--retry", action="store_true", help="重试失败的")
    ap.add_argument("--once", action="store_true", help="只扫一轮")
    ap.add_argument("--deep", action="store_true", help="全量扫描（慢）")
    ap.add_argument("--show-buckets", action="store_true")
    ap.add_argument("--add-bucket", action="append", default=[])
    ap.add_argument("--reset-baseline", action="store_true",
                    help="重设时间基线（会重新纳入缓存里的历史直链）")
    ap.add_argument("--force", action="store_true", help="允许多实例并存")
    args = ap.parse_args()

    cfg_all = C.load_config()
    b = cfg_all["buckets"]
    for x in args.add_bucket:
        if x not in b["target"]:
            b["target"].append(x)

    if args.show_buckets:
        C.say("已见过的 VOD 桶（* = 当前目标）")
        C.say("-" * 72)
        for k, v in sorted(b.get("all_seen", {}).items(), key=lambda x: -x[1].get("n", 0)):
            star = "*" if k in b["target"] else " "
            C.say(f" {star} {k:<34} vodappid={v.get('vodappid','?'):<12} "
                  f"出现{v.get('n',0):>5}次  首次 {v.get('first','?')}")
        C.say(f"\n目标桶: {b['target']}")
        C.say(f"已拉黑: {b.get('rejected', [])}")
        C.say(f"自动接纳新桶: {b.get('auto_add')}")
        return 0

    C.raw_dir(True)
    load_durations()

    if args.status:
        progress()
        return 0

    # 时间基线：持久化，保证重启后仍能收到会话中途新生成的直链
    if not b.get("baseline_t") or args.reset_baseline:
        # 只按本剧的目标桶校准（全桶算会被别的小程序顶到未来，把本剧直链全挡掉）
        b["baseline_t"] = C.max_url_t(b.get("target"))
    BASELINE_T = b["baseline_t"]
    C.save_config(_cfg_wrap(b))

    if not args.force:
        _lock_fh = acquire_lock(os.path.join(C.WORK_ROOT, "harvest.lock"))
        if _lock_fh is None:
            C.say("已有 harvest 实例在运行，本实例退出（加 --force 可强开）。")
            return 3

    if args.retry:
        st = C.load_state()
        for fid, url in list(st.get("failed", {}).items()):
            C.say(f"重试 {fid} …")
            res = download(fid, url)
            if res.get("ok"):
                st["seen"][fid] = {**st["seen"].get(fid, {}), "ok": True,
                                   "size": res["size"]}
                st["failed"].pop(fid, None)
                C.say(f"  ✓ {res['size']/1024/1024:.2f} MB")
            else:
                C.say(f"  ✗ {res.get('error')}")
            C.save_state(st)
        progress()

    if args.once:
        n = scan_once(deep=args.deep, force=True, cfg=b)
        C.say(f"本轮新发现 {n} 条")
        progress()
        return 0

    root = C.wechat_profile_root()
    C.say("=" * 66)
    C.say("短剧直链收割器")
    C.say(f"  微信缓存 : {root or '❌ 未找到'}")
    C.say(f"  缓存文件 : {len(C.cache_files(args.deep))} 个")
    C.say(f"  目标桶   : {b['target'] or '（空，靠探针自动发现）'}")
    C.say(f"  输出     : {C.raw_dir()}")
    C.say(f"  时间基线 : {BASELINE_T:#x}")
    C.say("=" * 66)
    C.say("现在请到【微信 PC 版】里打开该剧，播一集（看到画面在动即可）。")
    C.say("每播一集，这里就会自动出现一条 [新直链] 并立刻整集下载。")
    C.say("Ctrl+C 停止。")
    C.say("")
    progress()
    scan_once(deep=args.deep, force=True, cfg=b)
    C.say("")

    iv = args.interval if args.interval is not None else C.load_config().get("poll_interval", 3.0)
    try:
        while True:
            time.sleep(iv)
            n = scan_once(deep=args.deep, cfg=b)
            if n:
                C.say("")
                progress()
    except KeyboardInterrupt:
        C.say("\n已停止。")
        progress()
    return 0


if __name__ == "__main__":
    sys.exit(main())
