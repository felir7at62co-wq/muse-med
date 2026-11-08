---
description: "通过无密钥原生工具验证音频引用名称持久化与原 key 回读恢复。"
kind: "reference"
---

# 音频绑定与回读

[English](README.md) | 中文

随包 Headless profile 通过普通 Loader 加载生产 Jubian，连接经过认证的回环 HTTP fixture（测试前置数据）。五次原生调用依次预览同名但身份不同的两个音频引用、按核对过的指纹保存、独立读取卡片，再于名称变化和 HTTP 失败后按原 key 核对。唯一一次免费 `isGenerate: 0` PUT 保存回退与显式文件名，保留图片、卡片身份、模型设置和时长。后续调用只读，原始 ledger 字节保持不变。每个完整实际结果进入下一次模型请求，独立工作区凭据记录这些观察事实。受控供应商数据不代表完成试听、生成声音身份或媒体质量验收。

[PTC 相邻场景](../muse-audio-binding-readback-ptc/README.zh.md) 通过实际 `tools.jubian_storyboard` 派发执行相同五步操作。
