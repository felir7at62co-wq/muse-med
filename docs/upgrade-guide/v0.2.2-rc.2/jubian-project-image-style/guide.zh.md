---
kind: upgrade-guide
description: "剧变生图在未指定参数或提示词开头风格时，改为在计费提交前继承项目保存的风格。"
---

# 剧变生图继承项目风格

[English](guide.md) | 中文

## 变更

`jubian_video` 的 `image_generate` 和 `image_generate_batch` 此前在未指定 `image_style`、且提示词开头没有声明其他风格时使用真人写实。这类请求现在继承剧变项目保存的风格。没有保存风格的项目继续沿用原默认值。项目保存的风格不受支持时，新请求须指定受支持的风格才能计费提交。

## 迁移

1. 项目使用其他风格而本次仍需真人写实时，在单次请求或对应批量项设置 `image_style: "live_action"`。若提示词开头声明了风格，须与该选择一致。
2. 生成 3D 写实图片时，使用保存为 3D 写实的项目，或显式设置 `image_style: "realistic_3d"`。在提示词中保留完整的画风指引，并查看生成图确认效果。回执中的 `image_style` 记录请求选择。
3. 用原 `idempotency_key` 核对既有提交或结果不明的提交。更改风格无法覆盖该键下已经保存的请求。
