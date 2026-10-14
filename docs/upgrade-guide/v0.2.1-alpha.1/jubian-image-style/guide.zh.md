---
kind: upgrade-guide
description: 剧变资产生图保留声明的动漫媒介，并提供显式的图片风格选择。
---

# 剧变图片媒介

[English](guide.md) | 中文

## 变更

`jubian_video image_generate` 与 `image_generate_batch.items` 的每项请求接受 `image_style: "anime" | "live_action"`；顶层批次 `image_style` 会被拒绝。构造器的 `ImageRequestInput.imageStyle` 提供相同选择。动漫请求使用提供方 `style: 1`，包括完整提示词描述的3D动漫；真人使用 `style: 0`。省略选择时识别开头的正向媒介声明，可带同一行精确的 `项目风格:` 或 `项目风格：` 前缀；未标记的旧提示词保留真人。已发布的动画声明包括 `风格化动画`、`3D anime`／`3danime`、`stylized animation`／`stylizedanimation`。后续正文和负面排除不用于选择媒介。显式选择与声明冲突，在计费前失败。回执回显解析的媒介，不证明视觉质量。

## 迁移

1. 已确认二维／三维动画提供 `image_style: "anime"`，已确认真人提供 `"live_action"`，批量逐项填写。`prompt` 保留完整自定义风格、3D细分画风和材质描述，不用选择参数替代这些词，也不使用顶层批次默认值。
2. 构造器调用方提供 `ImageRequestInput.imageStyle`；需要解析可选请求意图时使用 `resolveImageStyle`。
3. 已提交的 key 用原账本和资产对账。修正媒介后请求体不同，不能复用旧 key 发起另一笔收费提交；原结果明确后，只有获得生成修订的授权才新建，不在未知结果时自动再次收费。
4. 回读保存的资产并查看生成图片，再接受媒介或质量。既有图片及选角不会自动替换。
