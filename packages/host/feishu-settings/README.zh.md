---
description: "在设置中配置内置飞书机器人、保存应用凭证，并排查设置或重启状态。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu-settings

[English](README.md) | 中文

## 概述

在设置 → 飞书中配置内置飞书机器人。保存已有应用的凭证，或扫描二维码注册应用。分别保存凭证与启用状态，再重启后端使其生效。入口已启用不代表已确认消息收发或实时连接。

## 目录

- [保存凭证](#storing-credentials)
- [注册](#registration)
- [重启顺序](#restart-sequence)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="storing-credentials"></a>
## 保存凭证

填写 App ID 与 App Secret 后，点击**保存凭证**。启用开关只保存启用状态，不会保存凭证输入框中的内容。`setCredentials` 把凭证对写入桥接行的段。尚未保存密钥时必须填写；已有密钥时留空会保留它。只有返回状态确认了本次 App ID 与已保存的密钥后，页面才清空已输入的密钥。写入被拒或无法确认时，保留输入供重试。

<a id="registration"></a>
## 注册

扫描二维码注册应用，作为填写已有凭证对的替代方式。注册完成会保存返回的凭证；注册或凭证写入失败会报告有界的错误码。已撤销扫码的迟到错误不会覆盖当前扫码状态。

<a id="restart-sequence"></a>
## 重启顺序

先保存凭证，再打开开关，然后重启后端使两者生效。页面分别报告凭证保存与开关保存。开关已开启但缺少凭证时，桥接行仍保持挂载和可写；补存凭证后再次重启。桥接入口已启用描述的是配置状态；消息收发还需要飞书权限与平台配置。本页不报告已经验证的实时连接。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

发布的 Client 代码使用 `lib/client.js`；`lib/types/client` 只包含声明文件。

[组合包补丁](cordis.patch.yml)添加 `feishu` 设置行。其 `enabled` 字段默认为 `false`，并持久化到配置补丁。桌面的[依赖层](../../../apps/desktop-host/src/feishu-gate.ts)要求桥接在 `feishuSetup` 可用后才解析 Config，并保留其其他依赖。[Host 插件](src/index.ts)在发布该服务前安装配置瀑布流监听器，启动时捕获产品开关和桥接的完整凭证，只投影运行时启用状态，并先委托插值再读取凭证表达式。之后编辑凭证或开关均不会改变本次启用状态，需下次后端启动才生效；用户 profile 始终可编辑。

凭证属于 `@wenbin_wb/dsh-bridge` 行的 `feishu-channel` 设置段。[设置服务](src/service.ts)通过 settings 服务写入 `appId`、`appSecret` 与 `registeredBy`，并通过脱敏的 `describe()` 读取公开字段。Host 检查桥接的 volatile 密钥是否为非空值，只返回存在状态；schema 的空默认值不算已保存凭证。关闭或缺少凭证时该行仍保持挂载，使其设置段可写。更换应用或扫码者会清除先前发送者和活动会话绑定；其他设置继续合并保留。

注册调用 `@larksuite/channel` 的官方 `registerApp`，在 Host 侧将返回的 URL 渲染为 SVG data URL，并通过与手工填写相同的设置操作保存凭证。浏览器 bundle 不带二维码编码器。平台注册消息不会进入页面、日志或任何 Remote 应答。

设置写入被拒时，页面收到类型化的错误码，而不是可能包含被拒密钥的 settings 服务原始消息。`feishu/credentials-unwritable` 区分桥接设置段缺失与写入被拒；`feishu/secret-required` 和 `feishu/login-failed` 覆盖缺少密钥与注册失败。底层设置异常会写入 Host 日志。

</details>

-----

<a id="model-experience"></a>
## Model Experience

无，本包通过设置管理飞书配置，不注册模型工具、提示词文本或请求 token。

#### KV Cache effect

保存凭证或更改启用状态不会改变模型请求，也不会使已可复用的请求前缀失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

凭证持久化已独立于实时消息收发进行验证。设置与桥接集成有以下限制。

- 页面既不编辑也不显示群消息策略：桥接的发送者/群白名单与提及要求控制入站访问。
- 包测试替换了注册调用，并通过 Loader 验证设置持久化。扫码、实时长连接以及租户的权限与可见范围配置仍未验证。
- 本行通过 settings 写入桥接凭证段；键名必须与[审核后的 provider schema](../../../third_party/plugins/compatibility/muse-feishu-channel.mjs)保持一致。
- 桥接行保持挂载且 `enabled: false`，使启用前即可保存凭证。开关关闭时，打包后的 provider 会在创建网关或会话节点之前返回。桌面迁移保留旧凭证及备份，关闭产品开关，并要求显式启用。
- 本包不发布 `./invariant`：它拥有的事实——存储的开关、待扫码的票据、凭证是否存在——都已经通过 `feishuSetup` Remote 面可观测，不存在第二个可能与它分叉的观察源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
