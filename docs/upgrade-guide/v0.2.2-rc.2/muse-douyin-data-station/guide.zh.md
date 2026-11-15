---
kind: upgrade-guide
description: "Muse 桌面版不再加载本地抖音下载器；douyin_download 改为在数据站排队下载抖音作品，douyin_download_task 与 douyin_data 已移除。"
---

# 抖音下载改由数据站完成

[English](guide.md) | 中文

## 变更

此前，除极简预设外，Muse 桌面版的所有预设都加载 `muse-douyin-download`。其中 `douyin_download` 把校验过的 MP4 文件保存到会话工作区，`douyin_download_task` 查看、恢复或取消这些本地任务，`douyin_data` 读取页面指标并可通过 `download: true` 下载。`muse_media_download` 也会把抖音作品保存到公司云端。

现在没有预设加载 `muse-douyin-download`。`douyinDownloadTool` 为 true 时，`@deepseek-ai/dsh-muse-account` 注册延迟加载的 `douyin_download`，桌面组合已启用它。该工具使用已登录的 Muse 账号在数据站排队下载一个作品或整部合集，返回公开存储地址，不写入本地文件。参数为 `action`（`download`、`query` 或 `quota`）、`url`、`aweme_id`、`mix_id` 和 `wait_seconds`；`urls`、`publicOnly` 和 `mode` 已移除。桌面版不再提供 `douyin_download_task` 和 `douyin_data`。`muse_media_download` 对抖音目标返回 `douyin-unsupported`；TikTok 和 Bilibili 不变。

已保存的会话和本地任务记录仍留在磁盘上，但桌面版不再恢复或取消未完成的本地抖音任务。引用已移除工具的提示词、技能和自定义工具列表将找不到这些工具。

## 迁移

1. 升级前让未完成的本地抖音任务结束，或记下其链接以便重新提交。已保存在 `source/media/douyin/` 下的文件保留在原工作区。
2. 确认每位 Muse 用户都在数据站成员名单中，否则数据站返回 `team-access-required`。每日额度与数据站网页共用。
3. 把 `douyin_download_task`，以及使用 `urls`、`mode` 或 `publicOnly` 的 `douyin_download` 调用，改为每个作品或合集一次 `douyin_download` 调用，例如 `{ "action": "download", "url": "<分享链接>", "wait_seconds": 60 }`；作品仍为 `preparing` 时再调用 `{ "action": "query", "aweme_id": "<编号>" }`。
4. 用 `muse_media_data` 代替 `douyin_data` 读取抖音页面指标。把针对抖音的 `muse_media_download` 调用改为 `douyin_download`。
5. 仍需本地抖音文件的自定义组合可以自行加载 `muse-douyin-download`。它的 `douyin_download` 与账号工具在同一作用域注册会失败，在智能体预设作用域中则会遮蔽账号工具，因此该组合应保持 `douyinDownloadTool: false`。
6. 用 `{ "action": "quota" }` 确认：配置正确时返回 `state: "ok"` 和 `enabled: true`。
