---
kind: upgrade-guide
description: "严格来源采用必须使用所属 Session 中真实绑定摘要的 OCR 和完整观察，不能只提供独立审核 JSON。"
---

# 严格来源审核必须提供真实工具证据

[English](guide.md) | 中文

## 变更

启用 `require_source_review` 后，正式渲染与归档要求发起 Session 中当前源片的完整 OCR 和实际看图记录。独立审核 JSON、没有完整文件摘要的旧 OCR 结果或其他 Session 的报告不能建立这些证据。原文件与已发布 Session 事件格式不变；新增私有投影缓存从既有真实成功工具事件重建签发记录。

## 迁移

1. 使用随包预设。自定义创作集成保留旧 `video_inspect`，启用 `sourceReviewCompanion` 以提供 `video_source_review`；短剧集成维持 `requireCompleteReview=true` 和完整 `video_inspect`。创作模式仍可使用旧采样和可信收据。
2. 在部署范围及帧数上限内，对当前完整源片实际运行 `video_ocr`，间隔为 0.5 秒。保留成功结果的 `raw_json_path` 和 `raw_json_sha256`。局部或未知扫描仍待继续。
3. 使用当前可用的完整审看工具：`scan`，再 `next`，图片进入成功的图片模型请求后才 `observe`。可通过有界的 `scan.timestamps_seconds` 补看缺失的 OCR 或处理时点。完成后保存真实返回的 `observation_report`、`observation_report_sha256`、`observation_session_id` 和 `review_id`。重复原请求时间或实际解码时间会保留已有帧和笔记。
4. 按[渲染器格式](../../../../packages/drama/tool-episode-render/README.zh.md)，把准确值及有实际画面依据的可见文字决策写入选片审核的 `source_qa`。清理片还需保留原片证据并核对处理时段；复制相同字节到另一文件不能借用认可。
5. 通过正常 Muse 工具重试正式渲染或归档。`SOURCE_QA_TOOL_PENDING` 表示 PTC 结果仍在提交：结束当前 `run_code`，在后续独立调用中复用已有文件继续。同一 Session 恢复后可复用其真实证据，另一 Session 则需自行获取。显示、同步和最终交付检查仍分别进行。
