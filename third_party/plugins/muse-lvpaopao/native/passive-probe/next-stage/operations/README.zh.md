# 绿泡泡固定操作

[English](README.md) | 中文

本模块提供自有固定表达式与不使用 socket 的注册适配器。可信 helper 选择已认证的目标及上下文，并以明确的操作允许清单构造 `NativeRpc`。仅注册模块不会附加微信或执行业务调用。部署及验收范围见 [helper 说明](../../../README.zh.md)。

```python
from native_rpc import NativeRpc
from operations.fixed_operations import fixed_operations, call_operation

registry = fixed_operations(['status', 'search', 'detail', 'episodes'])
rpc = NativeRpc(send_frame, 'wx404dde55fb12df78', registry,
                initial_sequence=discovery_seq,
                initial_op_id=discovery_op_id,
                initial_cdp_id=discovery_cdp_id)
await rpc.verify_context(selected_native_context, selected_execution_context)
model_result = await call_operation(rpc, 'search', {'query': '老手'})
```

## 操作字段

| 操作 | 调用参数 | 最多业务调用次数 | 附加公开字段 |
| --- | --- | --- | --- |
| `status` | `{}` | 0 | `hasRequire`, `hasBizRequest`, `hasNativeWrapper` |
| `search` | `{query}` | 1 | `resultCount`, `partial`, `candidates[{title,srcAppId,originDramaId}]` |
| `detail` | `{srcAppId,dramaId}` | 1 | `srcAppId`, `dramaId`, `title`, `episodeCount`, `isFirstMediaFree`, `hasVideoInfo`, `hasPlayAuthorization` |
| `engagement` | `{srcAppId,dramaId,episodeNo}` | 1 | 来源标识、实际集号、`observedAtMs`、可空的 `counts{likes,comments,recommendations,shares}` |
| `episodes` | `{srcAppId,dramaId,start,count}` | 2 | 详情字段及 `requestedStart`, `requestedEndExclusive`, `episodeNumbers`, `partial` |
| `download_first_episode` | `{srcAppId,dramaId}` | 2 | 详情字段及 `serialNo`, `isStraight`, `hasPrivateMedia` |
| `download_episode` | `{srcAppId,dramaId,episodeNo}` | 2 | 详情字段及实际 `serialNo`, `isStraight`, `hasPrivateMedia` |

注册器使用真实的 `native_rpc.FixedOperation` 类型，拒绝未知参数，通过 `@@PARAMS@@` 传入固定操作标签与已验证参数。`NativeRpc` 处理 JSON 转义、当前目标身份、上下文关联、串行调度、序号和有大小限制的回执。表达式仅使用已有插件命名空间和固定 host 模块；调用参数不能选择任意代码或模块路径。

公开元数据包含操作及状态、匹配身份、应用及插件版本、登录状态、业务调用次数与超时状态。失败返回固定错误码。可选诊断只包含固定失败阶段、类别及数字或 null 的原生错误码，不保留原始异常、堆栈、token 或播放地址。仅有业务调用计数不能证明提供方执行已结束。

## 参数校验与生命周期

搜索词最多 80 个 Unicode 码点。AppID 是 `wx` 加十六位小写十六进制字符。剧目 ID 保持为 1–128 字符的不透明字符串，保留前导零。响应中安全的非负数字 ID 可精确转为字符串；不安全 ID 会被略过并标记搜索结果不完整。搜索最多返回五十个实际候选。

分集操作先读当前详情，再接受从 1 开始的 `start` 和 1–20 的数量。提供方使用右开结束值：1–20 集发送 `end_no=21`。结果仅包含实际返回、去重并排序的集号。缺项、重复、格式错误、超出范围或在最后一集截断均设置 `partial`，不会补造缺失集号。

`engagement` 仅为指定集读取 `usergetdramameta`，映射 `like_sum`、`comment_sum`、`public_like_cur_media_amount` 和 `share_sum`；不包含仅好友的推荐计数、个人记录或播放数据。只接受安全的非负整数，包括零；其他值保持 null。整剧编排及累计由工具消费端负责。

原生业务调用在原求值栈中同步发起。单次 Promise 时限为 15 秒，两次业务调用的 RPC 时限为 35 秒。这些时限不能取消已发送到微信的原生调用。超时、上下文丢失或取消后，完成情况可能未知，均不授权自动重放。操作不会解锁剧集、启动广告或修改用户状态。

原始 `{publicResult, privateResult}` 只留在可信 helper 中，`call_operation` 仅返回校验后的公开元数据。首集地址获取还要求事先校验的私有媒体消费者、当前首集免费状态、精确原生序号 1 及 `is_straight`。消费者接收 HTTPS 地址与精确源绑定，传输前先保存私有回执，不向模型返回播放地址。持久 host 管理存储、下载、解码和清理；仅注册操作不会启用这些能力。任意集按实际序号请求，必须收到匹配该集的原生 `is_straight` 响应；首集免费标志不能授权其他集。其私有绑定包含实际集号与 `playAuthorization: native-straight-playback`。

helper 的 `download_episode` 与 `download_status` 接受 `{srcAppId,dramaId,episodeNo,idempotencyKey}`；key 必须是 64 位小写十六进制字符，不会传入原生表达式。获取地址前先持久保存来源与 key。状态检查核对原目录，不发原生请求：返回 `request-not-found`、`resume-available`、`outcome-unconfirmed` 或已验证的 `download-returned`。已记录的提供方拒绝保持原拒绝结果。地址获取结果未知时不会自动重放。完整媒体保存在 `downloads/<key>/media/episode-NNNN.mp4`，集号至少四位十进制数字。

传输重试复用加密地址。Range 续传要求相同 URL 哈希、经过验证的持久字节前缀、原始总长度、匹配的 ETag 或 Last-Modified，以及精确的 HTTP 206 Content-Range。资源变化、缺少校验标志或服务器忽略 Range 时不会追加。已完成字节检查点可不再发 HTTP 请求而重新解码。成功文件必须通过元数据、完整解码与 SHA256 检查；发布回执可恢复最终文件已写好、传输状态尚未落盘的情况。 已完成清理的传输失败保留原地址供重试。媒体子进程清理未确认时返回 `media-process-cleanup-failed`，并阻止原 key 续传，不会降为普通重试。

离线测试使用合成包装器和真实的无 socket RPC、Protobuf 实现，不执行提取的目标源码，也不验收新的 Windows 部署。
