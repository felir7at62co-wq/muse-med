---
kind: upgrade-guide
description: 聚变媒体下载现在会修正与实际下载格式冲突的文件扩展名。
---

# 聚变媒体下载路径

[English](guide.md) | 中文

## 变更

`jubian_media` 以前总向指定的 `output_path` 写入，即使提供方的 `.jpg` 地址返回 PNG 字节。现在会根据下载文件头，把缺少或冲突的扩展名替换成 `.png`、`.jpeg`、`.webp` 或 `.mp4`。兼容的扩展名保持不变，包括 JPEG 的 `.jpg`。假定文件总写入指定文件名的调用方必须改用返回的 `path`。

## 迁移

1. 在 `jubian_media` 和 [`mediaMethod`](../../../../packages/jubian/tool-jubian/src/methods.ts) 的调用方中，使用结果的 `path` 读图、抽帧和记录引用。
2. 把 `output_path` 视为期望的基本文件名及目录。与以前指定路径写入相同，修正路径上已有的文件可能被覆盖。
3. 以 `.jpg` 路径下载 PNG 文件，核对结果指向可读取的 `.png` 文件。升级不会重命名已有文件。
