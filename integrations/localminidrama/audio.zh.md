---
description: "持久化独立 TTS 与明确角色、人生时期的声音参考。"
kind: "reference"
---

# Muse 音频操作

[English](audio.md) | 中文

`planMuseAudio` 在 `planCloudPrefix` 后安装音频服务，移除上游 TTS 的凭据日志和虚构零用量，用明确的分镜绑定替代全剧首个声音的自动回退。制作页的**声音与配音**对话框与有日志记录的 `localmini_voice`／`localmini_tts` 工具共用上传、试听、历史与明确采用操作。既有音频文件保留可用。

## 独立 TTS

明确选择分镜、对白或旁白、已启用的 OpenAI/MiniMax TTS 配置及供应商原生音色 ID。上传参考不代表已经克隆 TTS 音色。生成前先将 `operation_id` 保存在 SQLite；相同操作重放返回原记录，同一标识改动输入会拒绝，并发请求不重复调用供应商。中断或结果不明的调用保留为 `unknown`，不会自动重发。输入指纹检查和生成预留在同一 SQLite 立即事务中执行，改用另一个 UUID 也不能重复相同的未解决请求。

供应商返回的原始字节保存在操作固定路径并记录 SHA-256。只有 FFprobe 确认存在音频、FFmpeg 完整解码成功后，生成记录才为完成；完成不代表采用。采用时再次验证原始 SHA，并在同一数据库事务中更新分镜与所选版本，绑定失败不报告成功。恢复只检查原已保存文件，不调用供应商。历史区分独立 TTS 与原视频声音；新记录保留不可变的配音原文及其 SHA，未保存原文的旧记录返回 null，不猜测重建。界面可将保留的原文复制到编辑框。供应商用量未回报，不记为零。

适配复用上游 [OpenAI speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) 二进制客户端及 [MiniMax 同步 TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-http) 十六进制音频客户端。OpenAI 正文最多 4,096 字符，MiniMax 必须少于 10,000 字符。MiniMax 使用配置地址或默认 `https://api.minimax.io`，请求 `/v1/t2a_v2`，不使用旧 GroupId 查询参数；当前适配仅接受速度 1。保存配置不会验证真实请求或模型权限。

`cancel_wait` 持久记录取消等待的意图，并停止界面的本地等待。复用的同步供应商客户端没有已确认的远程取消操作；原请求仍可能完成并产生费用。取消不会将供应商标记为已取消、清除未知状态或授权另一次付费尝试。应按同一生成标识查历史；恢复只读取保留的原始字节。

`localmini_tts` 提供 `capabilities`、`generate`、`history`、`get`、`recover`、`adopt` 和 `cancel_wait`。生成必须明确正文、对白或旁白、配置、已配置模型、供应商音色与速度。首次尝试在创建 Host 回执前免费询价；项目授权或价格缺失、余额不足时停止，不合成；已有原回执只读重放，不重新询价。供应商派发事务仍再次校验预算，金额只由所有者在制作平台配置。写入固定当前 `database_id`，云端写入还要求当前 `account_id`。生成与采用使用不同的操作标识，供应商凭据仍由制作平台私有保存。

## 正式视频声音参考

上传版本必须指定确切角色与明确人生时期。文件须为 2–30 秒的 WAV，只有一个音轨，单声道或双声道，使用 16/24/32 位有符号整数 PCM。既有 15 秒版本保持不变。已登记字节与 SHA 不可变，采用单独记录；不从服装、集数或姓名推断时期。

每包绑定按上传顺序记录每个准确声音资产、角色、时期与 SHA。零参考表示明确清空，最多可保存十个不同角色时期的参考；同一角色时期出现多个版本造成歧义时拒绝。保存前比较旧绑定的 `operation_id`，声音必须属于该包实际绑定的角色。普通图片编辑保留当前声音选择，制作提供者整体发布有序映射；保存结果未知时通过回读核对，不重复 PUT。

[Ark 创建 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1) 定义逐模型参考限制。`volcengine_omni` 下，已知 Seedance 2.5 profile 最多接受十段音频，每段 2–30 秒、合计最多 30 秒；已知 Seedance 2.0 profile 最多三段，每段 2–15 秒、合计最多 15 秒，且需图片或视频输入。官方 profile 要求官方来源与准确文档模型 ID；别名须明确配置 `settings.muse_model_capabilities[model].profile`。其他模型或协议保持不支持或未知，应明确拆包或使用独立 TTS；适配不会静默丢弃音频，也不会自动创建付费子请求。

实际 Ark 请求按顺序将校验过的原始 WAV 作为 `reference_audio` 传入，并在提示词中增加带编号的角色与人生时期映射，遵循[官方多参考说明](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh)。原生生成尝试将有序输入元数据冻结为不可变历史，即使后续模型验证拒绝提交也保留；清空或修改当前绑定不会重写既有输入。供应商提交前校验文件 SHA、请求大小与模型限制；普通视频端点上的原始音频字段会被拒绝而非忽略，应使用正式绑定 API。这些检查证明输入，不证明声线相似度、克隆质量、账号权限或真实付费调用成功。

`localmini_voice` 提供 `capabilities`、`inventory`、`upload`、`adopt`、`binding`、`bind` 和 `video_inputs`。上传通过发起 Session 的文件系统读取工作区内有界普通文件，回执保留准确 SHA。已保存参考不会克隆 OpenAI／MiniMax TTS 声线。原生声音资产及历史继续可用，但不代表剧变当前模型支持传递声音参考；剧变视频只使用准备结果明确列出的供应商输入，缺少支持时必须停止并报告，不能声称声音已绑定成功。

## HTTP API

以下路径均以 `/api/v1/muse/audio` 开头。既有 `/api/v1/audio/extract` 和 `/extract/batch` 改用同一持久化生成服务，也必须提供操作标识。

| 方法与路径 | 操作 |
| --- | --- |
| `GET /capabilities?config_id=…&model=…` | 不含私钥的 TTS 配置与数据库身份；可选准确视频模型声音限制 |
| `GET /voices?drama_id=…` | 版本清单、采用状态及适配能力 |
| `POST /voices` | Multipart：`file`、`character_id`、`voice_period_id`、`operation_id` |
| `POST /voices/:id/adopt` | 使用 `operation_id` 选择该角色时期版本 |
| `GET /video-bindings/:storyboardId` | 当前准确绑定；分镜不存在返回 404 |
| `PUT /video-bindings/:storyboardId` | `{operation_id,expected_operation_id,voices:[{voice_asset_id,character_id,voice_period_id,sha256}]}`，首次绑定期望 `null` |
| `GET /video-inputs?storyboard_id=…` | 不可变的生成尝试说话人映射 |
| `POST /tts` | `{operation_id,storyboard_id,tts_kind,config_id,model,voice_id,text,speed}`，不自动采用 |
| `GET /tts?storyboard_id=…` / `GET /tts/:operationId` | 原生成元数据与采用状态 |
| `POST /tts/:operationId/recover` | 仅验证原文件 |
| `POST /tts/:operationId/cancel` | 使用稳定 `operation_id` 记录停止等待，不宣称供应商已取消 |
| `POST /tts/:operationId/adopt` | `{operation_id,sha256}`，验证后明确采用完成音频 |

界面的操作缓存仅保存请求指纹和操作 UUID，并按数据库身份隔离，不保存配音正文。操作标识不能持久化时停止提交。明确新建版本可能再次产生供应商费用，应先刷新并核查未知记录。

## 存储与验证

音频服务在单调递增的 `muse_audio_schema` 版本 2 下执行完整 SQL，包括不可变资产触发器。事务从版本 1 单调迁移，不改写既有声音资产或音频字节，过去未保存的配音原文保持缺失；不修改或使用上游按分号拆分的迁移执行器。备份时同时保留既有 SQLite 数据库与完整存储目录。`muse_audio.request_timeout_ms` 默认 120,000，范围 1,000–900,000；`probe_timeout_ms` 默认 30,000，范围 1,000–300,000。

运行 `node --test integrations/localminidrama/tests/muse-audio.test.mjs`。夹具使用私有 SQLite、本地 HTTP 供应商和真实 FFmpeg/FFprobe，验证重放、未知结果、坏音频、数据库失败、不可变声音版本、精确归属、HTTP 端点及界面操作标识持久化。`FFMPEG_PATH` 和 `FFPROBE_PATH` 指定测试程序；缺工具而跳过不算验收。测试还覆盖实际 Ark 请求构造中的多说话人参考、提交前拒绝、schema 迁移及不重复合成的取消等待。独立 `snapshots/session/muse-localmini-audio` 用这些工具重放只读 Muse 会话，不调用供应商。本测试不使用真实供应商凭据、不付费生成，也不验证声线相似度。
