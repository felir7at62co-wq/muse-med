---
description: "部署并验证 Muse 账号网关、云端知识库和按账号隔离的语音转写。"
kind: "package-reference"
---

# Muse accounts gateway

[English](README.md) | 中文

## Summary

本目录包含单独部署的 Muse 账号网关。网关提供按账号隔离的语音转写、按管理员授权阅读参考资料，以及私有剧本保存。桌面端和工作区包不启动它，也不保存火山或 TOS 凭据。

## Release inputs

网关需要 Node 22 或更新版本、对应版本的 `muse-runtime` 和 `global` 发布目录，以及既有账号、模型、知识库路由使用的发布根目录 DSH 依赖。复制进每个新的不可变发布目录后，在本目录运行 `npm ci --omit=dev`；`package-lock.json` 锁定 TOS SDK。服务器必须具备 `ffprobe`。账号数据库、知识库文件、凭据和 ASR 任务账本不得复制进发布树。

服务从 `MUSE_ASR_CONFIG` 指向的私有 JSON 文件读取配置。省略此变量即关闭 ASR，已登录的 ASR 请求返回 503。Linux 上该文件须为权限 0600 的普通文件，包含以下字段：

| 字段 | 用途 |
|---|---|
| `appId`、`accessToken` | 仅服务器使用的火山录音文件标准版 1.0 凭据。 |
| `accessKeyId`、`secretAccessKey` | 仅服务器使用的 TOS 凭据。 |
| `bucket`、`region`、`endpoint`、`prefix` | 私有 TOS 桶、匹配区域的官方端点，以及以 `/` 结尾的专用临时前缀。 |
| `root` | 发布树外的私有绝对路径，保存按账号隔离的任务收据和短期暂存 MP3。 |
| `ffprobePath` | 服务器 `ffprobe`，核验真实编码和时长以执行限额。 |
| `timeoutMs`、`signedUrlTtlSeconds` | 提供方/访问验证超时和仅 GET 签名 URL 有效期；后者至少比 `maxDurationSeconds` 多一小时，且不超过七天。 |
| `maxAudioBytes`、`maxDurationSeconds` | 上传 MP3 最大字节数与识别时长；时长不得超过 18,000 秒。 |
| `maxDailySeconds`、`maxDailyJobs`、`maxActiveJobs` | 每账号计费上限；`maxActiveJobs` 必须是 1，使单进程网关的限额预留串行化。 |
| `retentionSeconds`、`sweepIntervalSeconds` | TOS 临时对象留存时间和后台清理间隔。留存至少覆盖媒体时长加一小时，且不超过签名 URL 有效期；清理间隔至少 60 秒，且不超过留存时间。 |

上传前，网关读取桶 ACL 和策略；只接受桶所有者授权及没有 Allow 语句的策略。读取权限不足或返回结果无法核实时停止上传。对象上传显式设置 private ACL，之后匿名 GET 必须返回 403，签名分段 GET 必须成功，才提交提供方任务。检查失败会保留私有任务账本记录，但不会产生提供方计费提交。后台清理到期对象，包括状态仍不明的任务；任务 ID 保留，仍可只读查询提供方。账号查询状态时也会清理，网关报告留存到期后，桌面端删除对应的本地 MP3。

凭据值不得进入 Git、systemd `Environment=`、桌面设置、日志或模型工具结果。开发环境和正式环境都通过 `MUSE_KB_VAULT` 与私有 `MUSE_KB_SECRET` 文件启用知识库机器端点。`MUSE_KB_DOCUMENT_GRANTS` 指向由管理员维护、位于可写共享 vault 和编辑器可写目录外的普通 JSON 文件；在 POSIX 上，用户组和其他用户不能写入该文件。未设置文件路径时，不授权任何共享文档。网关在检索或阅读前核对每份共享文档的完整 SHA-256。不能仅凭开发 vault 的文件数量或标题把它复制到正式环境。未配置知识库时机器端点不存在；启用后，未鉴权的 `/api/kb/mcp` 请求返回 401。

启用知识库的网关启动前，须把 `MUSE_KB_USER_ROOT` 指向共享 vault 外已存在、仅所有者可访问的绝对目录。目录缺失、权限过宽或与共享 vault 重叠会阻止启动。已登录账号每次可用 `ingest_script` 提交 1–12 段复核后的 Markdown 剧本；请求上限为 2 MiB，单段上限为 400,000 字符。每段的标题、项目相对来源标识与不可变正文按稳定账号 ID 分开保存；结果逐项报告已写入、已存在或失败。账号可通过 `search`、`read` 和 `read_opening` 阅读自己的 `private/SRC-...` ID；其他账号和机器令牌不能读取这些私有 ID。个人资料使用关键词召回，语义向量仅用于已授权的共享文档。此工具不上传视频二进制。桌面端使用前，服务器须完成部署和配置；只发布源码不会启用此功能。

## Verification and release

在本目录运行 `node --test *.test.mjs`；测试中的提供方和 TOS 操作均由替身实现。真实提供方请求须另行获得付费集成检查授权。切流前保存现行服务单元和发布指针，保留上一不可变版本，并备份任务账本及账号状态，且不输出其内容。先发布开发版，再发布正式版。检查 `/login` 返回 200；配置好知识库后，未鉴权 `/api/kb/mcp` 返回 401；配置好 ASR 后，已登录账号 GET 一个随机 `/api/asr/jobs/:id` 返回 404，503 表示未启用。使用两个测试账号保存一段经复核的短剧本：所有者须能检索并阅读其 `private/SRC-...` ID，另一账号不能。再核验获授权的共享资料检索，并对一段另行批准的短音频执行真实 ASR，方可判定服务可用。检查失败时把服务单元切回上一版本；保留持久任务账本，以便继续查询已提交的任务 ID。回滚时不删除旧发布目录或临时 TOS 对象。

rc3 前实际服务单元路径为 `/opt/muse/dev/releases/dev-0.3.0-rc35/muse-accounts` 和 `/opt/muse/prod/releases/dev-0.3.0-rc35/muse-accounts`。单元名分别是 `muse-dev-accounts.service` 与 `muse-accounts.service`。发布工具仅在源码和配置检查通过后切到新版本；本目录本身不会部署。

## Provider basis

ASR 适配器实现用户 Pi 会话验证过的火山 v3 大模型录音文件**标准版 1.0**接口与 `volc.bigasr.auc` 资源。[火山产品说明](https://www.volcengine.com/docs/6561/1354871?lang=zh)的时长限制为五小时；[TOS 签名 URL](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en)最长七天。[TOS 桶策略](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en)和[桶 ACL](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh)都会影响访问权限，因此上传前同时读取两者。旧小模型 `/api/v1/auc` 文档不描述此 v3 适配器。提交/查询状态处理来自用户 Pi 会话，仍需获授权的真实 API 检查。
