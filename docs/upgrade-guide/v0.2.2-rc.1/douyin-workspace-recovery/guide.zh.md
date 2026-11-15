---
kind: upgrade-guide
description: "持久抖音浏览器下载要求 Host 明确提供工作目录绑定能力。"
---

# 持久抖音任务的目录绑定与恢复

[English](guide.md) | 中文

## 变更

持久抖音下载在原生浏览器回退前，要求 `douyinBrowser.supportsExpectedCwd === true`。旧版本 4 Host 缺少该能力时，在原生 I/O 前返回 `DESKTOP_WORKSPACE_BINDING_UNAVAILABLE`。不需要浏览器回退即可成功的公开下载保持原有行为。Host 与插件须配套更新；仅包版本相同不能证明具备该能力。

注册表恢复仅在持有恢复内核锁，并验证完整持有者身份和对应进程已退出后，才回收该记录。旧匿名恢复 guard、不完整持有者和含未知归属字段的记录仍返回 `DOUYIN_TASK_LOCKED`；升级不推断归属，也不自动删除旧文件。Session 数据、注册表格式版本 1 和原会话、模型、工作区绑定均保留。

## 迁移

1. 对需要浏览器回退的持久任务显式续跑前，配套安装 Host 与抖音插件。Host 须公开 `supportsExpectedCwd:true`；成功的原生请求保留接收时的规范目录。请求被阻塞不授权改绑工作区，也不授权换身份重新下载。
2. 旧注册表仍返回 `DOUYIN_TASK_LOCKED` 时，保留文件并在迁移前请求显式核对持有者。不要仅凭文件年龄、超时或空文件删除锁。参阅[插件恢复限制](../../../../third_party/plugins/muse-douyin-download/README.zh.md#persistent-downloads)。
