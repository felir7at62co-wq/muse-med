# 社区插件源码与构建

[English](README.md) | 中文

这六份源码快照保留了 Muse Med 使用的社区插件。[sources.json](sources.json) 固定各公开上游仓库、修订、版本及许可证。快照保留上游源码和清单；部分文本文件将 CRLF 规范为 LF。已安装的用户配置、凭据、用户媒体和生成的运行时均不作为构建输入。翻译检查仅排除这六个上游目录；本 README 与其他自有文档仍须成对维护。

## 构建

使用已安装依赖、且已构建当前 Host 与 Client 包的源码仓库。在仓库根目录运行：

```sh
pnpm exec node third_party/plugins/build.mjs --out .artifacts/community-plugins
pnpm exec node --test third_party/plugins/build.test.mjs
```

[build.mjs](build.mjs) 按独立的[工具链锁文件](toolchain/pnpm-lock.yaml)执行冻结安装并禁用安装脚本，再在临时目录中逐个编译和打包插件。`--only dsh-ffmpeg` 可选择单个源码目录。临时目录链接当前仓库已构建的 Host 包，不使用在线用户配置。子进程检查使用临时 Harness 主目录，并排除含凭据的环境变量。脚本先移除链接，再删除临时目录；源码目录不会产生构建输出或 `node_modules`。桥接的上游 JavaScript 源码本就位于 `lib`。

每个压缩包保留上游许可证和 Codex 声明，按需添加所内嵌 Heroicons 的许可证，并在 `SOURCE.json` 记录上游固定版本、Host 版本及工具链锁文件摘要。产物清单禁用生命周期脚本、固定构建所用的运行时依赖版本，并仅向 DSH peer 候选增加经测试的精确 Host 版本。上游清单保持不变。Host 版本变化时，脚本拒绝构建，直到完成新的兼容性审核。

Codex 临时运行时补丁在 `SOURCE.json` 记录修改：子任务检查与准备仅接受已审核的 Host provider 版本，CLI 仍固定为 `0.153.4`。打包后从 `app.asar.unpacked` 解析 CLI 清单和启动文件。保留的上游文件不变；源码文本不符合预期时，补丁失败，而非静默跳过。

Codex 订阅模型仅在连接了 Codex OAuth 账号时出现在模型选择器中。Muse 登录不授予订阅供应商的访问权限；断开 Codex 后，下次查询列表会隐藏其模型。

桌面面板还会把运行时已注册的 MCP 工具列为只读连接。内置 `muse-account` 显示为 Muse 知识库，并展示已注册工具数量。兼容覆盖不会把凭据、环境变量值或私有启动参数复制到列表中。

## 兼容性与桌面集成

`dsh-skill-mcp-panel` 固定于上游 2.1.2。它通过 Web 侧栏管理当前 profile 的技能和 MCP 服务配置。随桌面应用打包的产物不暴露上游 `dsh-panel` 可执行入口：Desktop 只通过 `dsh` profile 启动受支持的 Node 应用。面板网关负责配置 MCP 连接，实际 MCP 客户端仍为 `@deepseek-ai/dsh-mcp-client`。隔离构建会运行保留的模型、网关、插槽与图标检查。

构建脚本导入每个生成的 Host 入口。Codex 针对当前 DSH API 和 pi-ai 0.85.1 执行 26 项保留的上游检查，包括模型准备和已认证传输校验；上游注册上下文是测试替身，而非完整桌面 Loader。另有六项 Codex 检查加载真实 provider 和 CLI，通过本地模拟对端验证其认证传输，并拒绝运行时版本偏移及错误的归档路径。FFmpeg 执行 89 项保留的检查。构建测试检查全部导出产物文件，并验证同一平台下两个全新临时目录生成的六个插件压缩包均逐字节一致。这不代表跨平台或整个安装包逐字节一致。

[桌面打包入口](../../apps/desktop/scripts/package-target.ts)是将这些压缩包放在第一方打包输入旁的集成位置。[包集合准备](../../apps/desktop/scripts/prepare-package-set.ts)必须将六个插件包名选为显式根；源码工作区不得以注册表安装包替代这些压缩包。打包不等于启用：发布仍须通过真实桌面 Host/Client 烟测。账号登录、收费请求和真实媒体编码不在这些免密构建检查范围内。

Market 的 HTTP 界面不适用于无端口的桌面传输。Codex 使用可选的 connection fetch 传输，不要求 Web 服务器。FFmpeg 需要产品配置编码器路径。压缩包存在不代表功能已启用。

### Muse 远程桌面与飞书

`@wenbin_wb/dsh-bridge` 保留上游 2.12.1 版本及 [sources.json](sources.json) 中的固定修订，并保留 MIT 署名。[规范化记录](dsh-bridge/MUSE_SOURCE_NORMALIZATION.json)记录了 21 个规范化尾部空白或文件末尾换行的文本文件的上游与本地 SHA-256。[审核后的覆盖](compatibility/bridge-desktop.mjs)固定该记录，在打包前检查每个规范化文件及保留模块，并将记录写入 `SOURCE.json`。私有产物通过 `./remote` 暴露 Muse 远程 provider，通过根入口暴露可选飞书 provider。产物排除上游应用 bin、局域网代理、独立隧道服务端、Cloudflare、自更新和上游密码/二维码认证。

远程 provider 复用 `CustomTunnelClient` 的连接建立和原生 WebSocket 升级处理。Muse 适配器直接流式转发原生字节，不积累完整数据帧，包含 Host Ping 和浏览器 Pong；同时提供账号/设备认证、流式 HTTP 上传与下载、逐块确认、取消、按配置间隔持续重连和等待完成的关闭。本地传输测试覆盖二进制上传、Range 响应、不完整原生数据帧、`/api/remote.mux` 心跳往返、取消及凭证拒绝。云端 relay 验证 Muse 账号，并选择该账号绑定的桌面；桌面仅转发至自身回环 Host。这是一条私有出站连接，不创建公共隧道域名。

飞书 provider 通过维护中的 SDK 复用上游网关、会话节点、命令、卡片和审批。适配器通过当前 Host 服务读取工作区与会话元数据及标题，保留 `feishu-channel` 凭证段，在下载媒体前检查提及/发送者策略，拒绝物理路径位于活动工作区外的出站文件，并在卸载时等待自有工作结束。provider 默认关闭，启用前必须保存凭证。桌面 profile 迁移保留凭证值及备份，并关闭产品开关；更换应用或扫码者时清除先前发送者与会话绑定。真实飞书扫码注册、消息收发及租户权限仍未验证。

## 许可证

再分发前请阅读各自保留的上游许可证和声明。构建保留 Codex PSD 编解码器声明，并包含内嵌 Heroicons 的完整许可证。运行时依赖在打包后的依赖图中保留各自许可证。Muse Med 不宣称这些项目由本团队创作或得到其背书。
