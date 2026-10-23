---
kind: upgrade-guide
description: Muse 将自主选择的视频取样改为整集观察，全部检测画面记录完成前限制交付。
---

# Muse 视频观察

[English](guide.md) | 中文

## 变更

Muse 统一编导为 `tool-video-inspect` 启用 `requireCompleteReview`。其中 `video_inspect` 以整集 `scan`、分批 `next`、逐图 `observe`、`status` 和 `metadata` 替换 `sample`、帧数和局部范围参数；该部署不再注册 `video_contact_sheet`。所属会话仍有未完成的扫描或逐图观察时，拒绝 `screenplay_export_docx` 和 `present`，中间文件仍可保存。其他部署只有显式启用该配置才改变接口。

进度使用新增的 `video/review` 会话事件和 Host 内部投影。没有这些事件的旧会话没有待完成清单。不认识该必要事件的旧运行时拒绝读取包含它的会话，使用过新工具的会话须保留新版运行时。会话封装和写入版本不变。

## 迁移

1. 将自定义 Muse 抽帧指令改为对完整单集视频调用 `video_inspect` 的 `scan`。检测灵敏度和批大小属于产品配置，不作为工具参数。
2. 逐批调用 `next`，用 `observe` 为实际返回的每个 `frame_id` 记录可见内容、变化和疑点。图片路径或确认文字不能证明图片进入了模型请求。
3. 通过 `status` 确认整集扫描完成且待记录数量为零，再正常导出和交付。取消或重启后继续原任务；视频发生变化时重新扫描当前版本。
