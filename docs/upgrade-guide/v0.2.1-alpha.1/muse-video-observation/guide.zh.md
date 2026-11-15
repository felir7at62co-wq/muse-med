---
kind: upgrade-guide
description: Muse 将自主选择的视频取样改为整集观察，并持久保留对应来源的真实进度。
---

# Muse 视频观察

[English](guide.md) | 中文

## 变更

Muse 统一编导为 `tool-video-inspect` 启用 `requireCompleteReview`。其中 `video_inspect` 以整集 `scan`、分批 `next`、逐图 `observe`、`status` 和 `metadata` 替换 `sample`、帧数和局部范围参数；该部署不再注册 `video_contact_sheet`。未完成的扫描和逐图观察保留为对应来源的证据缺口，不限制 `screenplay_export_docx` 或 `present`；交付不将这些观察标为完成。其他部署只有显式启用该配置才改变接口。

进度使用新增的 `video/review` 会话事件和 Host 内部投影。没有这些事件的旧会话没有待完成清单。不认识该必要事件的旧运行时拒绝读取包含它的会话，使用过新工具的会话须保留新版运行时。会话封装和写入版本不变。可选 `follow_up` 缺省时仍为活跃。`close` 结束跟进，保留覆盖与验收状态；自动来源选择排除关闭记录，当前任务明确引用和已有稿件绑定仍保留其证据缺口。

## 迁移

1. 将自定义 Muse 抽帧指令改为对完整单集视频调用 `video_inspect` 的 `scan`。检测灵敏度和批大小属于产品配置，不作为工具参数。
2. 逐批调用 `next`，用 `observe` 为实际返回的每个 `frame_id` 记录可见内容、变化和疑点。图片路径或确认文字不能证明图片进入了模型请求。
3. 通过 `status` 查看所选视频的真实扫描和观察进度；导出或展示后，未完成的观察仍保持可见。临时中断、报错、切换话题或重启不会关闭审看，需要时继续已有进度。
4. Agent 判断审看任务已经结束时，可用已保存的 `review_id` 或 `file_path` 和可选 `reason` 调用 `close`，无需再次询问用户。用 `review_id` 查询 `status` 只读保存进度，不打开来源文件。`reopen` 核对来源版本后恢复；视频缺失或变化时保持关闭，变化的视频需要重新扫描。
