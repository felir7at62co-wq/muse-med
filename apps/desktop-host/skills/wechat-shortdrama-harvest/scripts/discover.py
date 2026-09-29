#!/usr/bin/env python3
"""
discover.py — 剧目发现 + 元数据（时长表 + 官方封面）拉取
=========================================================
原理：微信短剧播放器会把自己的会话凭证和请求参数**明文写进 Chromium 缓存**。
      本脚本把它们捡出来，重放公开的 wxadramaplayer 接口，拿到官方元数据。

    python scripts/discover.py                # 列出缓存里出现过的所有剧目
    python scripts/discover.py <drama_id>     # 抓取该剧目的元数据
    python scripts/discover.py --auto         # 若只有一个剧目，直接抓它
    python scripts/discover.py <drama_id> --no-covers   # 跳过封面下载

产出（写入工作区）：
    drama.json        剧目元数据 + 每集时长 + 每集封面 URL
    covers/epNN.jpg   官方分集封面（判集用）
    config.json       回写 drama_id / drama_name / episode_count / src_appid

⚠ 会话有效期约 2 小时。过期后重跑本脚本前，先在微信里再打开一次该剧播放页。
"""
import os, sys, re, json, time, argparse, urllib.request, urllib.error
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()


class SessionExpired(RuntimeError):
    pass


SESSION_HINT = (
    "wxa_plugin_session 有效期约 2 小时。\n"
    "    修复：在【微信 PC 版】里重新打开一次该剧的播放页"
    "（走到能看见视频画面的那一步），然后重跑 discover.py。"
)


# ------------------------------------------------------------------ 从缓存捡凭证
def scan_credentials():
    """返回 (sess, tick, host_appid, src_appid, drama_id 计数)"""
    sess = tick = host = src = None
    dramas = Counter()
    for f in C.cache_files(deep=True):
        try:
            data = C.read_shared(f)
        except OSError:
            continue
        if b"wxadramaplayer" not in data:
            continue
        for m in C.SESS_RE.finditer(data):
            sess = sess or m.group(1).decode()
        for m in C.TICK_RE.finditer(data):
            tick = tick or m.group(1).decode()
        for m in C.SRC_RE.finditer(data):
            src = src or m.group(1).decode()
        # 宿主 appid：只认 &appid= / ?appid=，排除 src_appid 里的子串
        for m in re.finditer(rb"[?&]appid=(wx[0-9a-f]{16})", data):
            host = host or m.group(1).decode()
        for m in C.DRAMA_RE.finditer(data):
            dramas[m.group(1).decode()] += 1
    return sess, tick, host, src, dramas


# ------------------------------------------------------------------ API
def api(action, sess, tick, host, src, drama_id, extra="", timeout=25):
    url = (f"https://mp.weixin.qq.com/intp/wxadramaplayer?action={action}"
           f"&wxa_plugin_session={sess}&wxa_plugin_ticketrandom={tick}"
           f"&src_appid={src}"
           f"&appid={host}&f=json"
           f"&plugin_version=1.11.6&plugin_code_version=1.11.6"
           f"&public_lib_version=3.17.2&publib_lib_version=3.17.2"
           f"&client_version=4.1.13.63&client_system=Windows%2011%20x64"
           f"&client_platform=windows&benchmark_level=-1"
           f"&drama_id={drama_id}{extra}")
    req = urllib.request.Request(url, headers={"User-Agent": C.UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SessionExpired(f"HTTP {e.code}。{SESSION_HINT}")
    ret = (j.get("base_resp") or {}).get("ret")
    if ret not in (0, None):
        raise SessionExpired(f"接口返回 ret={ret}。{SESSION_HINT}")
    return j


def fetch_meta(drama_id, sess, tick, host, src, want_covers=True):
    print(f"\n① getdramainfo  (drama_id={drama_id})")
    info = api("getdramainfo", sess, tick, host, src, drama_id,
               "&platform=windows&sdk_version=3.17.2&media_no=1&scene=1007&force_jump_flag=0")
    di = info.get("drama_info") or {}
    name = di.get("drama_name") or f"drama-{drama_id}"
    count = di.get("media_count") or len(di.get("media_list") or [])
    print(f"   剧名     : {name}")
    print(f"   集数     : {count}")
    print(f"   题材     : {di.get('theme')}  /  {di.get('era')}")
    print(f"   简介     : {(di.get('desc') or '')[:80]}…")

    if not count:
        print(f"   ⚠ 未取到集数。{SESSION_HINT}")
        return None

    print(f"\n② getdramamedialist  (start_no=1, end_no={count + 1})")
    ml = api("getdramamedialist", sess, tick, host, src, drama_id,
             f"&start_no=1&end_no={count + 1}")
    lst = ml.get("list") or []
    print(f"   取到 {len(lst)} 集，官方总时长 {sum(x.get('duration', 0) for x in lst)} 秒")
    if not lst:
        print(f"   ⚠ 列表为空。{SESSION_HINT}")
        return None

    data = {"drama_id": str(drama_id), "drama_name": name,
            "episode_count": len(lst), "theme": di.get("theme"),
            "era": di.get("era"), "desc": di.get("desc"),
            "cover_url": di.get("cover_url"), "src_appid": src,
            "host_appid": host, "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "list": lst}
    os.makedirs(C.drama_dir(True), exist_ok=True)
    json.dump(data, open(C.drama_json(), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"   已保存 -> {C.drama_json()}")

    cfg = C.load_config()
    cfg.update({"drama_id": str(drama_id), "drama_name": name,
                "episode_count": len(lst), "src_appid": src, "host_appid": host})
    C.save_config(cfg)
    print(f"   已回写 -> {C.CONFIG_F}")

    if want_covers:
        dl_covers(lst)
    return data


def dl_covers(lst):
    cd = C.covers_dir(True)
    print(f"\n③ 官方分集封面 -> {cd}")
    got = 0
    for e in lst:
        ep = e.get("media_no")
        p = os.path.join(cd, f"ep{ep:02d}.jpg")
        if os.path.exists(p) and os.path.getsize(p) > 1000:
            got += 1
            continue
        try:
            req = urllib.request.Request(e["cover_url"], headers={"User-Agent": C.UA})
            with urllib.request.urlopen(req, timeout=20) as r, open(p, "wb") as f:
                f.write(r.read())
            got += 1
        except Exception as ex:
            print(f"   ep{ep:02d} 失败: {str(ex)[:60]}")
    print(f"   {got}/{len(lst)} 张可用")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("drama_id", nargs="?", help="剧目 ID；不给则列出发现的所有剧目")
    ap.add_argument("--auto", action="store_true", help="只有一个剧目时自动选它")
    ap.add_argument("--no-covers", action="store_true", help="不下载封面")
    args = ap.parse_args()

    sess, tick, host, src, dramas = scan_credentials()
    print("=" * 72)
    print("微信缓存凭证扫描")
    print("=" * 72)
    if not sess:
        print("❌ 缓存里找不到 wxa_plugin_session。")
        print("   请先在【微信 PC 版】里打开一个短剧小程序，进到任意一部剧的播放页，再重跑。")
        return 1
    print("  会话 session : 已发现" if sess else "  会话 session : 未发现")
    print("  票据 ticket  : 已发现" if tick else "  票据 ticket  : 未发现")
    print(f"  宿主 appid   : {host}")
    print(f"  内容方 appid : {src}")

    if not dramas:
        print("\n❌ 没扫到任何 drama_id。请在微信里真正打开一部剧（进到播放页）。")
        return 1
    print(f"\n缓存里出现过的剧目（按出现次数）：")
    for did, n in dramas.most_common(20):
        print(f"    drama_id={did}   出现 {n} 次")

    did = args.drama_id
    if not did and args.auto:
        if len(dramas) == 1:
            did = next(iter(dramas))
            print(f"\n--auto：只有一部，选 drama_id={did}")
        else:
            print(f"\n--auto：有 {len(dramas)} 部，无法自动判定，请显式指定 drama_id")
            return 1
    if not did:
        print("\n用法：python scripts/discover.py <drama_id>")
        return 0

    try:
        r = fetch_meta(did, sess, tick, host, src, want_covers=not args.no_covers)
    except SessionExpired as e:
        print(f"\n❌ {e}")
        return 1
    if not r:
        return 1
    print("\n" + "=" * 72)
    print("✅ 元数据就绪。下一步：")
    print("   python scripts/harvest.py     # 开始收割（然后去微信里播一集）")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
