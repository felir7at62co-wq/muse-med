# Muse 公司媒体服务

[English](README.md) | 中文

Muse 公司媒体服务由私有 DTK 部署和账号授权网关组成。桌面客户端复用当前 Muse 登录，上游凭据留在服务器。云端下载只有经过客户端导入并校验后，才成为本地素材。

## 组件

| 目录 | 职责 |
| --- | --- |
| [deploy](deploy/README.zh.md) | 固定上游源码、私有 DTK 部署与基础设施验证 |
| [gateway](gateway/README.zh.md) | 公司成员准入、MCP 输入验证、账号限制、所属任务与文件交付 |
| [ops](ops/README.zh.md) | 网关版本打包、私有配置、HTTPS 接入与回滚 |

网关独立于现有 Muse 账号进程运行，并使用其已鉴权的身份接口。部署不需要替换或重启账号网关。私有配置、HTTP 响应和验证命令见网关参考。

## MCP 客户端验证

需显式启用的 [SDK 验收测试](tests/mcp-client.test.mjs) 使用 `dsh-mcp-client` 安装的 SDK 和操作人员自己的私有登录会话，验证协议协商、工具元数据、鉴权、跨来源拒绝及未知任务隔离，不请求平台内容或下载媒体。未设置会话变量时，测试明确跳过。

```sh
MUSE_MEDIA_SESSION_FILE=/absolute/private/session.json node --test services/muse-media/tests/mcp-client.test.mjs
```

仅在验收机器需要 HTTP 代理时设置 `MUSE_MEDIA_HTTP_PROXY`，云端服务不继承该设置。
