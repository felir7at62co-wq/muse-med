#!/usr/bin/env python3
"""
小说转视频 - 批量下载脚本 (多线程,自动命名,断点续传)

特点:
- 从服务器一次性拉取全部视频清单(不受网页分页/全选限制)
- 多线程并发下载(默认4线程),保证速度
- 自动用视频标题命名(无需再跑重命名脚本)
- 已存在且大小一致的文件自动跳过(支持中断后重跑续传)
- 失败自动重试,最后汇总失败列表

使用方法:
1. 确保已安装 Python 3 (无需任何额外依赖,纯标准库)
2. 运行: python download_videos.py
   - 默认下载全部视频到当前目录下的 videos/ 文件夹
   - 服务器地址取 --base, 未指定时取环境变量 DRAMA_API_BASE

可选参数:
  --base URL        指定服务器地址(默认取环境变量 DRAMA_API_BASE)
                    开发环境用: --base http://<公网地址>:9080
  --out DIR         输出目录(默认 ./videos)
  --workers N       并发线程数(默认 4)
  --keyword KW      只下载标题含关键词的视频
  --source SRC      只下载指定来源(feishu / novel-video)
  --start "2026-07-14 21:00"   只下载该北京时间之后生成的
  --end   "2026-07-14 23:00"   只下载该北京时间之前生成的

示例:
  python download_videos.py --workers 8
  python download_videos.py --keyword 物业 --out ./物业视频
  python download_videos.py --start "2026-07-14 00:00" --end "2026-07-14 23:59"
"""
import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

DEFAULT_BASE = os.environ.get("DRAMA_API_BASE", "")
BEIJING = timezone(timedelta(hours=8))


def sanitize_filename(name: str) -> str:
    """清理文件名中的非法字符(Windows/Linux通用)"""
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    name = name.strip().strip(".")
    return name or "untitled"


def beijing_to_utc_iso(s: str) -> str:
    """把'2026-07-14 21:00'(北京时间)转为UTC ISO字符串"""
    dt = datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=BEIJING)
    return dt.astimezone(timezone.utc).isoformat()


def fetch_list(base: str, keyword=None, source=None, start=None, end=None):
    """从服务器拉取下载清单"""
    params = {}
    if keyword:
        params["keyword"] = keyword
    if source:
        params["source"] = source
    if start:
        params["start_date"] = beijing_to_utc_iso(start)
    if end:
        params["end_date"] = beijing_to_utc_iso(end)

    url = f"{base}/v1/video-delivery/export-download-list"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    print(f"正在从服务器获取下载清单...")
    print(f"  {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    print(f"共 {data['total']} 个视频待下载")
    return data["items"]


def download_one(item, out_dir, max_retry=3):
    """下载单个视频,返回(title, status)"""
    title = item["title"]
    url = item["cdn_url"]
    filename = sanitize_filename(title) + ".mp4"
    filepath = os.path.join(out_dir, filename)

    # 获取远端文件大小
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            remote_size = int(r.headers.get("Content-Length", 0))
    except Exception:
        remote_size = 0

    # 已存在且大小一致 -> 跳过(断点续传)
    if os.path.exists(filepath) and remote_size > 0:
        if os.path.getsize(filepath) == remote_size:
            return (title, "skip")

    # 下载(带重试)
    for attempt in range(1, max_retry + 1):
        try:
            tmp = filepath + ".part"
            with urllib.request.urlopen(url, timeout=600) as resp:
                with open(tmp, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
            # 校验大小
            if remote_size > 0 and os.path.getsize(tmp) != remote_size:
                os.remove(tmp)
                raise IOError(f"大小不符(期望{remote_size},实际{os.path.getsize(tmp)})")
            os.replace(tmp, filepath)
            return (title, "ok")
        except Exception as e:
            if attempt == max_retry:
                return (title, f"fail: {e}")
            # 重试前清理
            try:
                if os.path.exists(filepath + ".part"):
                    os.remove(filepath + ".part")
            except Exception:
                pass
    return (title, "fail: 未知")


def main():
    parser = argparse.ArgumentParser(description="小说转视频批量下载")
    parser.add_argument("--base", default=DEFAULT_BASE, help="服务器地址")
    parser.add_argument("--out", default="videos", help="输出目录")
    parser.add_argument("--workers", type=int, default=4, help="并发线程数")
    parser.add_argument("--keyword", default=None, help="标题关键词筛选")
    parser.add_argument("--source", default=None, help="来源筛选")
    parser.add_argument("--start", default=None, help="起始北京时间 '2026-07-14 21:00'")
    parser.add_argument("--end", default=None, help="结束北京时间 '2026-07-14 23:00'")
    args = parser.parse_args()

    base = args.base.rstrip("/")
    if not base:
        parser.error("请用 --base 或环境变量 DRAMA_API_BASE 指定服务器地址")
    os.makedirs(args.out, exist_ok=True)

    try:
        items = fetch_list(
            base,
            keyword=args.keyword,
            source=args.source,
            start=args.start,
            end=args.end,
        )
    except Exception as e:
        print(f"获取清单失败: {e}")
        sys.exit(1)

    if not items:
        print("没有匹配的视频")
        return

    print(f"开始下载到 {os.path.abspath(args.out)} (并发{args.workers}线程)\n")

    ok = skip = fail = 0
    failures = []
    done = 0
    total = len(items)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download_one, it, args.out): it for it in items}
        for fut in concurrent.futures.as_completed(futures):
            title, status = fut.result()
            done += 1
            if status == "ok":
                ok += 1
                print(f"[{done}/{total}] 完成: {title}")
            elif status == "skip":
                skip += 1
                print(f"[{done}/{total}] 已存在跳过: {title}")
            else:
                fail += 1
                failures.append((title, status))
                print(f"[{done}/{total}] 失败: {title} ({status})")

    print("\n" + "=" * 50)
    print(f"下载完成: 成功 {ok} / 跳过 {skip} / 失败 {fail} / 总计 {total}")
    if failures:
        print("\n失败列表(可重新运行本脚本自动续传重试):")
        for title, status in failures:
            print(f"  - {title}: {status}")
    print("=" * 50)


if __name__ == "__main__":
    main()