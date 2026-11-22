#!/usr/bin/env python3
"""
视频批量重命名脚本 (自动更新版)
使用方法:
1. 将此脚本放在下载视频的文件夹里
2. 运行: python rename_videos_auto.py
3. 脚本会自动从服务器获取最新映射数据
"""
import json
import os
from pathlib import Path
import sys
import urllib.request
import urllib.error

# 配置 - 默认取环境变量 DRAMA_API_BASE
# 只有当命令行参数以http开头时才用作自定义域名(防止文件名被误当参数)
DEFAULT_API_BASE = os.environ.get("DRAMA_API_BASE", "")
API_BASE = DEFAULT_API_BASE
for arg in sys.argv[1:]:
    if arg.startswith("http://") or arg.startswith("https://"):
        API_BASE = arg.rstrip("/")
        break
if not API_BASE:
    sys.exit("请用参数 http://服务器地址 或环境变量 DRAMA_API_BASE 指定服务器地址")

MAPPING_URL = f"{API_BASE}/v1/video-delivery/export-mapping"

# 设好 DRAMA_API_BASE 后直接运行即可: python rename_videos_auto.py
# 如需连其他环境: python rename_videos_auto.py http://其他域名


def fetch_mapping():
    """从服务器获取最新映射数据"""
    print("正在从服务器获取最新映射数据...")
    try:
        with urllib.request.urlopen(MAPPING_URL, timeout=30) as response:
            if response.status != 200:
                print(f"服务器返回错误: {response.status}")
                return None
            data = json.loads(response.read().decode("utf-8"))
            print(f"成功获取{len(data)}条映射规则")
            return data
    except urllib.error.URLError as e:
        print(f"网络错误: {e}")
        print("提示: 请检查网络连接或服务器地址")
        return None
    except Exception as e:
        print(f"获取映射失败: {e}")
        return None


def main():
    script_dir = Path(__file__).parent

    mappings = fetch_mapping()
    if not mappings:
        print("\n提示: 如果无法连接服务器,可以手动下载mapping.json放在同一目录")
        local_mapping = script_dir / "mapping.json"
        if local_mapping.exists():
            print("使用本地mapping.json作为备份")
            with open(local_mapping, "r", encoding="utf-8") as f:
                mappings = json.load(f)
        else:
            print("没有可用的映射数据,程序退出")
            sys.exit(1)

    print(f"\n开始处理{len(mappings)}个视频文件名...")

    renamed = 0
    skipped = 0
    errors = []

    for item in mappings:
        old_name = item["filename"]
        new_name = f"{item['title']}.mp4"

        old_path = script_dir / old_name
        new_path = script_dir / new_name

        if not old_path.exists():
            skipped += 1
            continue

        if new_path.exists():
            print(f"跳过 {old_name}: 目标文件已存在")
            skipped += 1
            continue

        try:
            old_path.rename(new_path)
            print(f"{old_name} -> {new_name}")
            renamed += 1
        except Exception as e:
            errors.append(f"{old_name}: {str(e)}")

    print("\n" + "=" * 50)
    print(f"成功重命名: {renamed}个")
    if skipped > 0:
        print(f"跳过: {skipped}个 (文件不存在或目标已存在)")
    if errors:
        print(f"失败: {len(errors)}个")
        for err in errors:
            print(f"   - {err}")
    print("=" * 50)

    if renamed > 0:
        print("\n重命名完成!")
    elif skipped == len(mappings):
        print("\n提示: 请确保脚本和视频文件在同一目录")


if __name__ == "__main__":
    main()