---
kind: upgrade-guide
description: "剧变工具用独立错误码报告本地项目绑定失败。"
---

# 剧变项目绑定错误

[English](guide.md) | 中文

## 变更

`project_config.json` 缺失、无效或指向其他项目时，剧变工具改为报告 `PROJECT_BINDING_INVALID`，此前报告 `CONTRACT_CHANGED`。现有有效的项目配置可继续使用。

## 迁移

1. 按错误码处理剧变错误的调用方应识别 `PROJECT_BINDING_INVALID`，提示核对本地项目目录和 `jubian_script_id`。
2. 在缺少配置文件的测试目录中验证。预检应报告本地错误，剧变任务列表应保持不变。
