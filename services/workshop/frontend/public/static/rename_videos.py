#!/usr/bin/env python3
"""
视频批量重命名脚本
使用方法: 
1. 将此脚本和mapping.json放在下载视频的文件夹里
2. 运行: python rename_videos.py
"""
import json
import os
from pathlib import Path
import sys


def main():
    script_dir = Path(__file__).parent
    mapping_file = script_dir / "mapping.json"
    
    if not mapping_file.exists():
        print("❌ 错误: 找不到mapping.json文件")
        print("请先从视频交付中心下载mapping.json")
        sys.exit(1)
    
    # 读取映射
    with open(mapping_file, 'r', encoding='utf-8') as f:
        mappings = json.load(f)
    
    print(f"📋 加载了{len(mappings)}条映射规则")
    
    # 查找并重命名
    renamed = 0
    skipped = 0
    errors = []
    
    for item in mappings:
        old_name = item['filename']
        new_name = f"{item['title']}.mp4"
        
        old_path = script_dir / old_name
        new_path = script_dir / new_name
        
        if not old_path.exists():
            skipped += 1
            continue
        
        if new_path.exists():
            print(f"⚠️  跳过 {old_name}: 目标文件已存在")
            skipped += 1
            continue
        
        try:
            old_path.rename(new_path)
            print(f"✅ {old_name} → {new_name}")
            renamed += 1
        except Exception as e:
            errors.append(f"{old_name}: {str(e)}")
    
    # 汇总
    print("\n" + "="*50)
    print(f"✅ 成功重命名: {renamed}个")
    if skipped > 0:
        print(f"⏭️  跳过: {skipped}个")
    if errors:
        print(f"❌ 失败: {len(errors)}个")
        for err in errors:
            print(f"   - {err}")
    print("="*50)


if __name__ == "__main__":
    main()