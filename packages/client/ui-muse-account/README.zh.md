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

桌面应用将本插件与 Host 的 `muse-account` 行一起加载。打开**设置 → MUSE**或侧栏的 **MUSE** 入口，选择**飞书登录**。启用飞书时，网关直接打开飞书官方授权页面。授权后确认与桌面一致的设备码，Host 保存登录状态后页面自动显示账号。连接失败后可以重开网页或检查结果，也可取消待完成的登录。关闭账号页面会取消尚未兑换的授权；已开始保存的登录先完成。首次运行面板使用同一登录流程。现有 Host 登录接口和账号数据保留。

页面每次打开时先向网关验证已保存的登录状态，再显示账号状态。重试和**验证登录状态**也会发起在线验证。网关不可用时显示错误和重试入口，保留已保存的会话；确认会话失效时显示飞书登录入口。验证成功不会作为长期可信标志持久化。重试验证成功也会推进首次登录页面。关闭页面后，页面忽略延迟返回的状态、登录和退出结果；Host 已接受的登录仍可更新已保存的会话。

仅当 Host 返回已验证的管理员身份及管理地址时，登录后的账号区域才显示**用户管理**。重新验证时立即隐藏该入口，验证成功后才重新显示；缓存身份和普通用户均不显示。按钮打开 Host 验证过的管理地址，不附加凭据。

现有桌面配置继续提供必填的 `feedbackUrl` 设置以保持兼容。它接受不含 URL 凭据的 HTTPS 页面；本地网关仅可在 `localhost`、`127.0.0.1` 或 `[::1]` 使用 HTTP，可显式指定端口，且页面路径不得为根路径。**Muse Bot 设置 → 反馈**可打开原生会话反馈表单，确认内容后由用户提交。

在 Muse 桌面中，本插件还通过 `museAccount.feedback` 为现有回答与任务反馈弹窗提供发送服务。弹窗提交使用桌面保存的登录状态，反馈进入账号意见箱。[弹窗包](../ui-message-feedback/README.zh.md)负责可选摘录、失败保留草稿及保存凭据确认。Muse 发送服务缺失时不会显示仅本地保存成功；其他配置继续使用原有本地反馈方式。

侧栏仅显示一个账号按钮，旁边保留连接和更新状态。展开时按钮包含文字，收起时显示带悬停提示的紧凑图标。

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
