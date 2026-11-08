---
description: "通过无密钥 PTC 验证音频绑定、完整结果与原 key 回读恢复。"
kind: "reference"
---

# 通过 PTC 绑定与回读音频

[English](README.md) | 中文

本场景是[原生场景](../muse-audio-binding-readback-native/README.zh.md)的相邻场景，使用随包 Node PTC runtime。五次 `run_code` 调用派发实际 `tools.jubian_storyboard` 绑定，并打印每个完整结果。第一个程序将实际预览结果保存在私有工作区；后续保存程序读取该结果中的路径与指纹。共享回环供应商与观察器验证唯一一次免费保存、独立成功／不匹配／失败回读、未变的原 key ledger 字节、保留的卡片字段，以及后续模型请求中的全部五个结果。已记录的 PTC 派发证明实际执行。不联系外部供应商，不下载媒体、不生成或试听。
