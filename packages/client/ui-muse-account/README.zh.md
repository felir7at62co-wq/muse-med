---
description: "桌面设置中的 Muse 账号登录和状态界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-muse-account

[English](README.md) | 中文

## 概述

这个客户端插件在桌面侧栏和设置中加入 Muse 账号入口。它通过 [muse-account](../../host/muse-account/README.zh.md) 提供的已认证 Remote 服务登录、验证状态或退出；密码不会进入模型对话。

## 目录

- [使用本包](#use-this-package)
- [实现方式](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面应用将本插件与 Host 的 `muse-account` 行一起加载。打开**设置 → MUSE 账号**或侧栏入口输入账号凭据。注册需要单独选择，默认不勾选；登录失败不会自动创建账号。

必填的 `feedbackUrl` 指向产品的 HTTPS 反馈页。侧栏的**意见反馈**按钮打开该页面，不附加账号凭据。桌面配置使用 Muse 网关的 `/feedback`；浏览器登录状态与桌面保存的会话独立。

在 Muse 桌面中，本插件还通过 `museAccount.feedback` 为现有回答与任务反馈弹窗提供发送服务。弹窗提交使用桌面保存的登录状态，侧栏页面使用浏览器登录状态，两者均进入同一个账号意见箱。[弹窗包](../ui-message-feedback/README.zh.md)负责可选摘录、失败保留草稿及保存凭据确认。Muse 发送服务缺失时不会显示仅本地保存成功；其他配置继续使用原有本地反馈方式。

账号行铺满展开侧栏的可用宽度，左右留白一致。意见反馈与蓝色更新控件位于下一行；没有状态控件时，意见反馈铺满该行。侧栏收起时使用紧凑的图标按钮。

-----

<a id="understand-the-implementation"></a>
## 实现方式

Host 与 Client 分别通过 `tsconfig.host.json` 和 `tsconfig.client.json` 编译；包根配置仅组合这两个程序。浏览器包先装载生成的 `museAccount` Remote contribution，再注册本地化文案、设置页、侧栏入口与初次运行登录面板。它仅从 Host 接收限定的状态与错误码；已保存的 cookie 和知识库 bearer 留在 Host 进程。本包不发布运行时不变量伴随插件，因为这些注册可通过其所属的 slot 与 Remote 注册表观察，无需另存状态核对。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Muse 账号 Host](../../host/muse-account/README.zh.md) — 登录存储、知识库工具和语音访问。
- [桌面应用组合](../../../apps/desktop/README.zh.md) — 打包配置和用户流程。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与触发条件

#### 模型能看到什么

`museAccount` Remote 命名空间处理浏览器请求。这个界面插件不增加模型工具或提示词；Host 包拥有账号和知识库工具的 schema。

#### Token 影响

界面不贡献模型 token。

#### KV Cache 影响

界面不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 账号操作需要已配置的 Muse 网关。部署限制和同一系统用户的文件访问限制由 Host 包说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
