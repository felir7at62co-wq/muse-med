# Agent Note: 内置飞书桥接显式选择启用

Status: implemented

[English](2026-09-24-desktop-feishu-bridge-opt-in.md) | 中文

## Problem

内置聊天桥接可能在操作者选择聊天之前启动开户、控制服务或跨实例读取。由环境变量推导的凭证还可能把产品绑定到其他部署的应用。随包携带不构成对这些副作用的授权。

## Decision

产品通过[审核后的暂存覆盖](../../../../third_party/plugins/compatibility/bridge-desktop.mjs)携带 `@wenbin_wb/dsh-bridge`。保留的上游快照不变。产物提供可选飞书 provider，默认 `enabled: false`；上游根入口激活、局域网/控制服务、Cloudflare、自更新和上游密码/二维码认证均被排除。

[桌面启用层](../../../../apps/desktop-host/src/feishu-gate.ts)在后端启动时读取产品的 `feishu.enabled` 开关，并传入 `feishu-channel.enabled`。关闭时该行仍保持挂载，使基于 Config 的设置段能在启用前接受凭证。关闭时 provider 不创建网关或会话节点；开启时要求凭证、保留提及要求，并拒绝需要另一界面接收答案的工具。

设置行通过 settings 将凭证写入当前 profile 的 `feishu-channel` 段。volatile 字段保持可写，密钥脱敏，更换应用或扫码者会撤销先前发送者与会话绑定。profile 迁移保留旧凭证和备份，并关闭产品开关。桥接通过当前 Host 服务读取工作区与会话元数据，不读取其他部署的存储或旧存储世代。

旧 Muse Web 启动器独立将用户安装的旧桥接行默认设为 entry-disabled，并保留操作者已有选择。桌面组合不控制该独立 Web profile。飞书应用注册由产品 Settings 操作负责；Muse 远程 provider 使用账号/设备认证，与飞书开关独立。

## Alternatives considered

**不挂载桥接，要求以后安装。** 未挂载的行没有可接受凭证的设置段，产品无法在启用前配置它。

**接受上游默认值或环境推导凭证。** 这会允许未被要求的开户及跨部署凭证复用。

**为聊天启用整个上游根入口。** 选择聊天不授权局域网服务、公共隧道、独立更新或另一个 home 的读取。审核后的产物只提供所需 provider。

**直接改写保留的源码。** 可审核的适配属于私有暂存；覆盖在写入前检查每个保留模块。

## Consequences

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)负责共享包身份与生命周期，[独立产品决策](2026-09-23-muse-med-independent-desktop.zh.md)负责产品 home 与组合。

[覆盖检查](../../../../third_party/plugins/compatibility/bridge-desktop.test.mjs)验证源码审核拒绝及公开服务元数据读取。[桌面 Loader 检查](../../../../apps/desktop/tests/feishu-setup-loader.spec.ts)验证真实补丁组合与产品开关；[凭证检查](../../../../packages/host/feishu-settings/tests/service.spec.ts)验证 profile 写入、脱敏和绑定撤销。产物检查通过模拟 SDK 对端运行真实 provider 与会话节点。真实扫码注册、消息收发、卡片、租户权限与打包后的启用仍未验证。

service 从已注入作用域取得依赖；消费者在那里解析 settings 并显式传入。Cordis 通过代理包装服务，实现字段因此使用 TypeScript private，而非 JavaScript `#private` 槽位。设置键必须与桥接 Config 保持一致。
