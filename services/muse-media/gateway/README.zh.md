# 公司媒体网关

[English](README.md) | 中文

本参考描述位于 DTK 5.1.10 前方的独立 Python ASGI 网关。它使用固定 DTK API 镜像中的 FastAPI、HTTPX 和 Uvicorn 依赖。一个进程负责按账号统计请求，SQLite 负责保存任务身份、幂等记录和下载预约。

## 鉴权与公司成员

每次操作只向固定的本机 `GET /api/muse.account` 接口传递当前 Muse 会话。其返回的 `accountId` 用于从只读账号文件读取最新账号记录。只有未禁用且匹配已配置飞书 app/tenant 的成员，或明确授权的账号 ID，才能访问。管理员身份本身不授予权限。网关在返回结果或文件前再次核对同一身份、revision 和成员资格；退出登录、账号禁用、切换账号或移除授权都会阻止交付。

接受 `Cookie: __Host-muse=…` 或携带同一 Muse 会话的 Bearer，二者都不是上游 DTK Key。拒绝冲突凭据、其他浏览器来源和跨站请求。账号源目录以只读方式挂载，以便看到原子替换后的账号文件，且不会作为网页内容提供。每次鉴权都重新读取 policy 和账号文档。

## 私有配置

将 [config.example.json](config.example.json) 和 [policy.example.json](policy.example.json) 复制到仅所有者可读的私有文件，并将 `MUSE_MEDIA_CONFIG` 指向配置路径。示例中的所有配置字段都必须提供；未知、遗漏、无效或互相矛盾的字段会阻止启动。后端地址必须是没有末尾斜线的固定 loopback HTTP origin，公开鉴权来源必须是 HTTPS。上游 Key、账号源、policy 和数据库都使用绝对路径。公司身份值和 Key 不得写入提交的示例。

| 配置字段 | 含义 |
| --- | --- |
| `requests_per_minute`、`max_requests_per_account` | 不依赖来源 IP 的账号频率，以及同时运行的重请求数量 |
| `max_downloads_per_day` | 持久保存的 UTC 日提交次数，包含失败和未确认的提交 |
| `max_downloads_per_account`、`max_downloads_global` | 未结束的下载预约数量 |
| `reservation_ttl_seconds` | 观察或未确认预约的期限；到期可释放槽位，不代表任务失败 |
| `request_timeout_seconds`、`auth_timeout_seconds` | 上游操作和身份操作的总截止时间 |
| `max_request_bytes`、`max_response_bytes`、`max_file_bytes` | 输入、MCP/JSON 回复和交付文件的大小上限 |
| `max_jobs_per_page`、`sqlite_timeout_seconds` | 所属回执的分页大小和 SQLite 锁等待时间 |

只运行一个 worker。HTTPX 使用 `trust_env=False` 并拒绝跳转，shell 代理设置不会悄悄改变生产流量去向。保持上游 DTK 端口私有，其 Key 只授予所需的平台和媒体权限，不授予身份管理或管理员权限。HTTP 鉴权失败返回 401，公司或来源拒绝返回 403，限流返回 429 和 `Retry-After`。REST 对其他账号或不存在的任务/文件返回 404。MCP 工具业务失败则返回 HTTP 200、`isError: true`、安全的 `state: failed` 结果，并保留原 JSON-RPC ID；包含无效参数、不可用的所属任务和请求 ID 冲突。鉴权与限流仍保留 HTTP 状态。

## MCP 与所属任务

`POST /api/media/mcp/` 接受 JSON-RPC 的 `initialize`、`ping`、`notifications/initialized`、`tools/list` 和 `tools/call`。协商只声明已经实现的 2024/2025 协议版本，不声明现代发现方法。末尾斜线属于端点的一部分。支持 `parse_url`、`get_video`、`get_user`、`list_user_posts`、`list_comments`、`get_content_history`、`download_media` 和 `get_task_result`。不提供 `pool_status`、转写、管理方法或任意 URL/路径代理。`GET /api/media/status` 只返回就绪状态和当前调用者的配置额度。

下载调用必须携带稳定的 `request_id`，相同的规范化参数会复用同一账号所属回执。同一键对应不同参数时拒绝请求。网关先提交预约，再调用上游。上游明确工具或 HTTP 拒绝会记为 `failed` 并携带固定公开代码。超时、不完整或畸形响应、进程丢失会留下 `unconfirmed` 和固定代码。这两种状态都不会自动重新提交。未完成任务使用网关生成的 `job_id`；`get_task_result` 只接受这个 ID，并在查找私有上游标识前验证归属。观察过期会释放预约，但保留回执和原任务以便核对；释放槽位不代表上游工作已停止。

| 路由 | 响应 |
| --- | --- |
| `GET /readyz` | 本机就绪状态和 SQLite schema 版本，不含账号信息 |
| `GET /api/media/jobs?offset=0` | 仅当前调用者的回执摘要和 `next_offset` |
| `GET /api/media/jobs/{job_id}` | 所属回执及经过安全投影的结果 |
| `GET /api/media/jobs/{job_id}/files/{name}` | 经固定 DTK 端点获取的所属 manifest 文件 |

MCP 调用返回 JSON `result.structuredContent` 和内容一致的文本。读取结果使用 `state: ok`；任务使用 `pending`、`unconfirmed`、`cloud_saved`、`partial` 或 `failed`。回执包含 `job_id`、工具名、时间戳、`automatic_resubmit: false`、可选 `request_id`/安全 `code`，以及安全文件字段（`name`、`bytes`、`sha256`、`kind`）。下载回执通过 `file_coverage` 披露报告、接受、拒绝的条目数、完整性和截断状态。上游完工记录只有在报告的每个 manifest 条目都被接受时才标为 `cloud_saved`；过滤、重复、未完成或截断条目会使其标为 `partial`，没有有效文件则标为 `failed`。未确认回执还包含 `reservation_active` 和 `next_action`。不会返回上游 ID、服务器路径、原始错误、签名媒体 URL、Cookie 或 Key。公开内容仍是不可信来源材料，缺失指标仍为 null。

所有准入操作共用同一个账号频率桶，包含 MCP 工具发现和回执查询。回执查询绕过重请求并发限制，使完成的任务能够释放下载预约。文件发送结束后才释放请求槽位。文件先写入私有临时目录，与持久 manifest 的字节数和 SHA-256 核对，再次鉴权后发送，并在响应的 `finally` 路径删除。这只能确认云端字节，不能代替媒体解码检查或本地素材登记。

## 运行与验证

使用网关目录作为构建上下文：

```sh
docker build -t muse-company-media:local services/muse-media/gateway
```

镜像入口执行 `python -m uvicorn app:configured_app --factory --app-dir /app/gateway --host 127.0.0.1 --port 19581 --workers 1`。部署时使用 host 网络、只读根文件系统、移除 capabilities、仅所有者可读的配置/Key 挂载、只读账号源目录和可写私有数据库目录。工厂在启动前加载 `MUSE_MEDIA_CONFIG`。只将状态目录设为可写，不能公开上游端口或原始 Key。

本地验证使用 Python 3.12 或更新版本，并安装相同的 FastAPI/HTTPX 依赖，然后运行：

```sh
python -m unittest discover -s services/muse-media/gateway -p 'test_*.py' -v
python -m compileall -q services/muse-media/gateway
```

测试使用真实 ASGI 路由、隔离账号文件和 SQLite 数据库、模拟外部 HTTP、受控时钟和明确的并发请求。覆盖鉴权、跨账号访问、限制、重复提交、未知结果、重启恢复、JSON/SSE 大小限制、秘密移除和中断文件发送，不访问平台。生产就绪仍需分别验证已部署容器、真实 Muse 会话、反向代理和受控平台请求。

## 保留期与预演批准

将 `MUSE_MEDIA_RETENTION_CONFIG` 指向符合 [retention.example.json](retention.example.json) 的私有文件，即可运行由服务拥有的五分钟保留期循环。未配置时不运行循环。媒体账本从 schema 1 单调升级为 2，保留任务并新增文件占用、导入回执、删除隔离标记和审计；schema 1 二进制不能重新打开它。恢复时保留升级后的数据库，用当前二进制关闭清理循环或运行预演。受理新请求后不能恢复旧数据库。

必须先将独立的 DTK `media.max_bytes` 清理设为零，文件系统容量护栏继续启用。每轮通过媒体存储 API 核对这一设置；不一致会阻止删除并使观察窗口无效。网关接管 20 GiB 下载准入上限、16/12 GiB 高低水位及 80/85/92 百分比磁盘阈值。容量压力只改变处理顺序和批次目标，不缩短承诺的保留期。没有符合条件的文件可释放空间时，停止新下载，继续提供查询和已有文件领取。

签发的文件占用按账号、文件名和摘要保护两小时，包含 HTTP 传输后的本地解码。只有携带该占用和摘要的 `POST /api/media/jobs/{job_id}/files/{name}/imported` 才确认本地导入，发送字节本身不代表接收成功。已确认导入的云副本保留 24 小时，未确认任务保留七天。共享同一上游物理目录的所有账号及清单文件必须全部符合条件。每份非空上游清单必须不超过接收上限、只包含完整且不重复的文件，并与每个所属任务持久保存的文件名、大小、摘要和类型全部一致；清单不完整或不一致时保护整个目录。置顶、活跃占用、未结束或不确定下载、未知引用及空清单均保护整个目录。旧客户端不发送确认，使用较长保留期。

预演记录候选及保护原因，不删除媒体或网关遗留暂存文件。启用需要仅所有者可读的批准文件，匹配相同运行代码和策略的连续 24 小时记录：没有错误、删除、独立清理、时钟倒退或超过十分钟的间隔。修改规则或运行模块后需要重新预演。循环在每轮及每次删除前重新读取策略，因此切回预演也会停止后续删除，不依赖重启成功。启用后的每次删除都在文件领取和下载建单使用的同一准入锁内，重新检查完整清单及保护条件。仅通过上游文件 API 删除，核对清单确认后才将回执记为 `failed / cloud_media_evicted`；原文件事实仍可查询，不能自动重新下载。删除结果不明会留下持久隔离标记，阻止后续删除、文件传输和新下载，等待运维核对。不提供 shell 递归或任意路径删除。上游管理员不能在托管清理期间并发提交或删除媒体。

循环还会识别自身暂存目录中遗留 24 小时的普通 `media-*` 文件，并避开所有活跃文件占用。不会扫描项目、凭据、源码版本、数据库或任意 Docker 卷。启用阶段的审计记录保留 90 天，预演批准证据继续保留。日志轮转和旧应用版本移除使用单独经运维审查的策略，不进入媒体删除器。
