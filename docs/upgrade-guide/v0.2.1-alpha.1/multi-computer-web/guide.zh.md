---
kind: upgrade-guide
description: "桌面模式的 Web 访问选择一台安装，不再把整个账号绑定到唯一在线电脑。"
---
# Muse Web 选择电脑

[English](guide.md) | 中文

## 变更

桌面模式下，同一账号的多台安装可以同时在线。仅一台在线时，网站自动进入 `/desktop/<installation-UUID>/`；其他情况显示电脑选择页。`/computers` 始终打开选择页。每个标签页保持绑定所选安装，包括断线期间。多台电脑在线时，未选择目标的桌面请求返回 503 与 `desktop-selection-required`；`/api/desktop/status` 增加 `selection-required`。

版本 1 的账号存储增加 `desktopDevices`，记录名称、操作系统和最近连接时间。已有 `desktopDeviceId` 记录仍可读取并保留。新客户端在版本 1 的握手中发送可选的 `deviceName` 和 `platform` 字段；旧客户端使用基于 UUID 的名称。导出的 `MuseDesktopTunnelOptions` 要求提供者调用方传入这两个字段。

## 迁移

1. 部署同一发布版本的账号网关与 Muse 桌面桥接。保留现有私有账号数据库和安装标识。设置 `MUSE_WORKSPACE_MODE=desktop`；云端模式保留现有行为。
2. 自定义 `MuseDesktopTunnelOptions` 调用方须提供 `deviceName`（1–80 个字符，不含控制字符）与 `platform`（`win32`、`darwin`、`linux` 或 `unknown`）。资源、HTTP 请求和 WebSocket 通过选中的 `/desktop/<installation-UUID>/` URL 转发。由网关核对归属并去掉前缀。
3. 在两台电脑和网站登录同一账号。确认选择页列出两台电脑，不同标签页显示各自会话，停止一台后另一台仍可使用。断线标签页须等待原来的电脑。传输配置见[网关部署](../../../../services/muse-accounts/README.zh.md#desktop-website-access)。
