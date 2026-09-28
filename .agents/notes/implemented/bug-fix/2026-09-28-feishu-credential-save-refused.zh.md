# Agent Note: Store the Feishu credential pair when no bridge row owns the section

Status: implemented

[English](2026-09-28-feishu-credential-save-refused.md) | 中文

## Problem

只要产品开关已经打开、而组合里没有跑桥接行，在飞书设置页保存 App ID 与 App Secret 就会以 `gateway/internal` 失败——muse Web profile 的闸门在操作者打开之前一直把 `feishu-channel` 置为 entry 级禁用，而官方 profile 根本不挂闸门。本行只在 `feishu.enabled` 为 false 时注册桥接的 `dsh-lark-bridge` 设置段，其假设是"开关为 off 的那一次启动正是桥接行不可能运行的那一次"。开关已打开且没有桥接时，没有任何一行注册该命名空间，于是 `provider.update` 抛出 `settings namespace "dsh-lark-bridge" is not registered`；本行丢弃该异常并抛出裸 `Error('bridge-settings-unavailable')`——它不带 `RemoteError` 标记，因而在 Gateway 处折叠成 `gateway/internal`。页面显示笼统的"操作失败"，状态读取没有描述符可读、于是报"尚未保存应用凭证"，而同一个缺陷也命中扫码完成后的写入，因为两者共用同一个写入点。

两个页面缺陷让失败更难摆脱。密钥字段留空的保存会被接受，于是存下一个没有密钥的 app id——这正是设置文档里只有 `dsh-lark-bridge.appId`、没有 `appSecret` 的由来。而被拒绝的保存会清空密钥字段，丢掉页面唯一无法从任何应答中重建的值。

## Decision

`FeishuSetupService` 在页面读写的那一刻、当名字空闲时注册桥接的设置段，并且绝不占用别的行已经拥有的名字。桥接行在它运行的地方仍然是所有者：它用自己的 `Config` schema 注册该命名空间、并在自身 entry config 之上解析已存的凭证对；第二次注册会让它的注册失败，使它退化为只用 entry config。

每一次拒绝都以带已声明 code 的 `RemoteError` 离开 Host，因此 Gateway 会原样携带它，而不是折叠成 `gateway/internal`：

- `feishu/credentials-unwritable` 携带 `reason` —— `section-unregistered`（没有行拥有该段，本行也无法注册它）、`provider-read-only`，或 `write-rejected`（settings 服务或该段的 schema 拒绝了这对凭证）。
- `feishu/secret-required` —— 尚未存过任何密钥，而请求也没有携带。
- `feishu/login-failed` 携带平台的有界 `code`；平台自身的文本绝不越过边界，扫码路径与手工填写走同一个写入点。

settings 服务的异常只进宿主日志，绝不进页面：它的消息会引用它写入的段与路径，而 schema 拒绝还可能引用被拒绝的值——在这里就是密钥。原因词表之所以是封闭集合，也是同一个理由。

页面只陈述它知道的事实：尚未存过密钥时该字段必填；只有在已经存过一份之后，留空才表示"保持已存的那一份"；被拒绝的保存保留两个字段的输入并显示原因；只有真正落盘的写入才清空密钥。

## Alternatives considered

**经凭据 seam 存密钥。** 姊妹页 Jubian 把它的管理 token 存在 `CredentialRef` 之下，而 `.credentials.yaml` 正是"存储的密钥"该待的地方。但这里行不通，因为消费方是第三方桥接：它从组合 entry config、自己的设置段、以及 `~/.dsh/dsh-lark-bridge/settings.json` 解析 `appId`/`appSecret`，从不为此读取 `ctx.credentials`（它对该服务的唯一用途是可选的云端 carrier）。把这对凭证搬过去需要修改第三方插件才能被消费；在那之前，页面存的会是一个没人读取的值。

**无条件注册占位 schema。** 这会让正在运行的桥接自己的注册失败——settings 服务拒绝重名命名空间——桥接随后退化为只用 entry config，而那正是它不读取的那份凭证所在之处。这种失败是静默的，只有桥接自己记录，比要修的缺陷更糟。

**保留随开关判断的注册，只把错误报得更好。** 页面在操作者正看着的那个组合里依然无法保存；而一个"存不上"的报告，正确的修法就是让它能存上。

**用 Loader 判定归属。** 读 `feishu-channel` 的 entry 状态是最精确的规则，但本行挂载所在的 context 并不枚举同级行：在行内调用 `ctx.loader.entries()` 只得到 include entry 且其子树为空，而在组合根上同样的调用能列出每一行。在同级行的 Loader 视图存在之前，`rowStateOf` 的探针保持既有契约。

## Related

[飞书可选启用决策](../architecture/2026-09-24-desktop-feishu-bridge-opt-in.zh.md)继续拥有闸门、bundle 与两步流程；其中"设置行如何取得桥接设置段归属"的表述已按上述规则更正。该决策未被取代。

## Consequences

写入路径不再依赖产品开关，因此在报告来源的 Web profile 里、以及任何桥接行永不挂载的组合里，这对凭证都能存下。若某次页面调用在正在运行的桥接注册该段之前到达本行，本行会占下这个名字，使那个桥接退化为只用 entry config；该竞态被限制在启动窗口内（早于 Web 服务应答任何页面调用），并且由于本行无法观测它，已记录在包 README 的已知限制里。

`setCredentials` 现在会在尚未存过密钥时拒绝空密钥，因此先前被接受的"只写 app id"不再存在；页面改为禁用该动作并说明原因。

## Testing

`packages/host/feishu-settings/tests/service.spec.ts` 驱动真实的文件提供方：开关已打开且没有桥接行时保存成功、`status()` 报出 `hasSecret`；由运行中的桥接注册所拥有的段会被写入而不是被重复注册；扫码完成后走同一个写入点；每一种拒绝原因都按 code、带类型的原因、以及"失败信息与文档中都不含密钥"来断言；尚未存过密钥时的空密钥被拒绝且什么都不写入。`tests/section.client.spec.tsx` 钉住页面：必填密钥未填写前保存动作不可用，被拒绝的保存保留已输入的密钥并显示原因，落盘的保存才清空它，控件是共享的 `Switch` 与 `Input` 原语、且文案只经 locale 键取得。`apps/desktop/tests/feishu-setup-loader.spec.ts` 通过真实 Loader 组合随包发布的补丁文件，并断言已存的凭证对可被页面读到，同时仍不出现在任何组合条目、诊断输出与 Remote 应答中。
