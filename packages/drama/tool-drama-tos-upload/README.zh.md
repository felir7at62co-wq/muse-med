---
description: "把一部作品的原始素材和剧本（红果剧的原片和转写材料，或番茄、七猫小说的原文和剧本）存进火山引擎 TOS 的平台与日期目录，不覆盖也不删除远端对象。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-drama-tos-upload

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-drama-tos-upload` 注册模型可见的 `drama_tos_upload` 工具。一次调用把一部作品的文件存到 TOS 桶的 `<rootFolder>/<platform>/<YYYYMMDD>/<work_id>/<kind>/<name>`：红果剧的原片和转写材料，或番茄、七猫小说的原文和剧本，逐个对象核对本地大小和 SHA-256，写入清单，并返回公开地址。它不会用不同内容替换已有对象，也不会删除远端对象；只有明确要求时，才会在全部对象核对成功后删除本地副本。

## 目录

- [使用本包](#use-this-package)
- [写入安全](#write-safety)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在有 TOS 凭据的部署中组合本插件，例如云端转写主机。它被归为可选包，不在 Desktop 默认组合中。

```yaml
- name: '@deepseek-ai/dsh-tool-drama-tos-upload'
  config:
    accessKeyIdRef: VOLCENGINE_ACCESS_KEY_ID
    secretAccessKeyRef: VOLCENGINE_SECRET_ACCESS_KEY
```

两个凭据引用都必须配置，调用开始时通过 Host `credentials` 服务解析；缺少该服务或取不到值时，调用以 `TOS_UPLOAD_UNCONFIGURED` 失败。位置默认值来自所有者 2026-11-15 的选择：`cn-beijing` 的 `muse` 桶、地址 `tos-cn-beijing.volces.com`、公开源 `https://muse.tos-cn-beijing.volces.com`、顶层文件夹 `download-video-date`，默认目录日期按 `Asia/Shanghai` 计算。`endpoint` 只能是 `tos-<region>.volces.com` 或同地域的 `tos-<region>.ivolces.com`。位置字段无效时，插件加载即失败。

| 字段 | 默认值 | 范围 |
| --- | --- | --- |
| `maxFiles` | 400 | 每次 1–2000 个文件 |
| `maxFileBytes` | 1 GiB | 单个文件最多 5 GiB |
| `maxTotalBytes` | 20 GiB | 每次最多 200 GiB |
| `partSizeBytes` | 20 MiB | 5 MiB–1 GiB |
| `taskNum` | 2 | 每个文件 1–16 个并行分片 |
| `maxRetryCount` | 2 | 每个请求 0–10 次 SDK 重试 |
| `requestTimeoutMs` | 300000 | 1000–1800000 |
| `connectionTimeoutMs` | 10000 | 100–60000 |

工具参数：`platform`（`hongguo`、`fanqie` 或 `qimao`）、`work_id`（作品在该平台上的纯数字 ID）、可选的 `title` 和 `date`（`YYYYMMDD`）、`files`（绝对路径 `path`；`kind` 为 `video`、`novel`、`asr`、`ocr`、`observations` 或 `scripts`；可选的远端文件名 `name`），以及可选的 `remove_local`。

<a id="write-safety"></a>
## 写入安全

- 每个键都由校验过的部分拼在 `<rootFolder>/<platform>/<date>/<work_id>/` 之下。远端文件名不能为空、不能以 `.` 开头、不能含 `/`、`\` 或控制字符，且不超过 200 个 UTF-8 字节。
- 本地输入必须是普通文件；目录和符号链接在任何远端请求之前就被拒绝。
- 上传和清单写入都设置 TOS 的 `forbidOverwrite`。已有键的大小和记录的 SHA-256 一致时报告为 `already_present`；其他已有键以 `TOS_UPLOAD_CONFLICT` 失败。
- 每次上传后，`HeadObject` 必须返回与本地一致的大小和 SHA-256，否则以 `TOS_UPLOAD_UNVERIFIED` 失败。SDK 在传输中还会校验 CRC64。
- 绑定层没有删除操作。只有 `remove_local` 为 true 时，才会在清单写入后删除本地文件；删除失败的文件列在 `kept_local` 中。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

`src/upload.ts` 先把请求解析成计划（校验、键、本地 SHA-256），这一步不访问远端；随后对 `TosUploadClient` 接口执行计划。`src/tos-client.ts` 把该接口绑定到 `@volcengine/tos-sdk@2.9.1`，并把 SDK 失败映射为带代码的 `HarnessError`，不回显请求细节。`src/index.ts` 在加载时校验配置，每次调用时解析凭据，并注册工具。清单键为 `manifest-<UTC 时间戳>.json`，重复调用不会替换之前的清单。清单记录平台、作品 ID、标题、桶、日期、目录、创建时间，以及每个对象的类型、键、大小、SHA-256 和上传状态，因此数据站任务接口等使用方仅凭清单地址就能登记一部作品的文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [凭据](../../credentials/credentials/README.zh.md) — Host 管理的凭据引用与秘密解析。
- [人物参考库 TOS 读取](../character-library-tos/README.zh.md) — 读取经过审查的人物参考的只读 TOS 提供者。

-----

<a id="model-experience"></a>
## 模型体验

### 短剧素材上传

#### 模型看到什么

组合本插件后，模型会看到 `drama_tos_upload` 的定义，其描述包含配置的键结构。调用成功时返回一个 JSON 对象：桶、日期、目录键和地址，每个对象一行（类型、本地路径、键、地址、字节数、SHA-256、状态），清单的键和地址，以及本地清理结果；失败时带 `TOS_UPLOAD_*` 代码和指明文件或键的中文说明。默认 `rootFolder` 下的描述原文如下：

##### 工具描述

```markdown
把一部作品的原始素材和剧本存到 TOS：红果剧的原片和转写材料，或番茄、七猫小说的原文和改成的剧本。位置是 download-video-date/{platform}/{日期}/{work_id}/{kind}/{文件名}，文件公开可读，返回每个文件的公开地址和本次清单。远端已有同名同内容的文件记为已存在，同名不同内容的不会覆盖；不会删除远端文件。remove_local 为 true 时，全部文件核对成功后才删除这些本地文件。
```

#### Token 影响

提供该工具的每次请求都会带上一份固定的参数定义。结果每个文件一行，一部 65 集的剧连同转写材料会返回几百行。

#### KV Cache 影响

定义文本只取决于配置，跨轮次保持不变。结果是普通工具结果，追加在可复用前缀之后。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **尚未组合** — 没有任何已发布的配置选用本插件；云端转写组合会连同凭据引用一起加入。
- **对象公开** — 所有者在 2026-11-15 选择公开存储。`muse` 桶允许匿名读取任意键，而键由公开的红果 id 拼成，知道键的人都能下载。
- **部署密钥未限定前缀** — 所有者选择沿用现有的桶密钥，它能写整个桶。本工具只写自己的前缀、从不删除，但密钥本身不限于该前缀。
- **不跨调用续传** — 中断的分片上传不会续传；再次调用会从头上传该文件。
- **三个平台** — 只支持 `hongguo`、`fanqie` 和 `qimao`。抖音下载由数据站自己存储，不经过本工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

设计和所有者的存储决定记录在每日爆款转写循环设计稿中（维护者检出目录下的 `.artifacts/daily-hit-transcription-loop-design-20261115.md`）。远端清理依靠桶的生命周期规则，不由本工具执行。

</details>
