# @deepseek-ai/dsh-feishu-settings

[English](README.md) | 中文

产品自有的飞书设置：一个打开内置桥接闸门的设置分区、一套扫码注册流程，以及驱动两者的 Web 设置页。

## 它拥有什么

- **`feishu`** —— 本产品的开关。`enabled` 默认 `false`，因此设置文档缺失、为空或无法读取都表示关闭。桌面组合读同一个键来计算内置 `feishu-channel` 行的 **entry 级 `disabled`**（[`apps/desktop-host/src/feishu-gate.ts`](../../../apps/desktop-host/src/feishu-gate.ts)）；entry 开关是唯一的激活权威，本页是唯一能打开它的入口。
- **`dsh-lark-bridge`** —— 内置桥接自己的设置段，归属取决于哪一行在跑桥接：跑桥接的那一行会用自己的 schema 注册该命名空间，并在自身组合 config 之上解析存下的凭证对。因此本行只在页面读写的**那一刻该名字仍空闲**时注册占位 schema——桥接行永不挂载的组合（Web profile 的闸门在操作者手动打开前一直禁用它）没有其它注册者，而 settings 服务拒写未注册的命名空间。凭证因此落在桥接的用户层，由桥接在自身组合 config 之上解析——任何组合条目、任何配置 dump 都不会带上它。
- **`feishuSetup`** —— 页面调用的 Typert `@Remote` 命名空间：`status`、`setEnabled`、`setCredentials`、`beginLogin`、`cancelLogin`、`forget`。

## 双层真相

产品开关与桥接自己的设置段是两层，页面两层都报。即使开关已打开，存储的 `dsh-lark-bridge.enabled: false` 仍会盖过该行的组合 config，此时页面显示 `overridden`，而不会声称机器人已在运行。

## 注册

`beginLogin` 调用 `@larksuite/channel` 的官方 `registerApp`（内置桥接依赖的同一个包），把返回的 URL 在 **Host 侧**渲染成 SVG data URL——浏览器 bundle 不带二维码编码器——并把扫码得到的凭证通过与手工填写同一个写入点写进桥接的设置段。失败只以有界的 code 传递；平台消息不会进入页面、日志或任何 Remote 应答。

## 凭证如何保存

`setCredentials` 把 `appId` 与（字段非空时的）`appSecret` 写进桥接的设置段。密钥是否必填取决于当前是否已存有密钥：留空表示"保持已存的那一份"，这只有在已经存过一份时才有意义，因此尚未存过时页面既禁用保存动作、也说明原因。被拒绝的写入保留操作者输入的内容——密钥是页面唯一无法重建的值——只有写入真正落盘后才清空该字段。

每一次拒绝都以"带类型原因"的 code 送达页面，绝不转发 settings 服务自身的消息：该消息会引用它写入的段与路径，而 schema 拒绝还可能引用它拒绝的值，在这里就是密钥。`feishu/credentials-unwritable` 携带 `section-unregistered`、`provider-read-only` 或 `write-rejected`；`feishu/secret-required` 与 `feishu/login-failed` 覆盖另外两种拒绝。真实异常写入宿主日志。

## 重启顺序

保存凭证与打开开关都在下一次后端启动时生效，因为组合条目的 `disabled` 与设置段的 config 都在启动时解析。页面在开关提示与 `restart-pending` 状态文案里都写明了这一点。

## Known Limitations and Deferred Work

- 本轮群消息策略只读：`approvers` 与发送者/群白名单的权限大于沙箱，页面既不编辑也不显示它们。
- 这里不做真实飞书往返：随包测试替换了注册调用，因此扫码、实时长连接、以及租户自身的权限与可见范围配置仍未验证。
- 页面会报告桥接自己的 `enabled` 覆盖，但不会清除它：清理由另一个插件拥有的命名空间里的键属于那个插件的契约，页面改为引导操作者去设置文档处理。
- **刻意的跨插件耦合**：本插件在没有其它行占用时注册 `dsh-lark-bridge` 命名空间，并只对该段做**读-合并-写**（`appId`/`appSecret` 两个键，其它键原样保留）。这一耦合依赖桥接自身的 Config schema；上游若改名或改语义（例如把凭证键换名、或让该段变成别的形状），必须同步本插件的占位 schema 与写入键，否则凭证会写进一个桥接不再读取的键里。
- **注册顺序存在本行观测不到的竞态**：确实运行桥接的组合会在 Loader 收敛时注册该设置段，这早于 Web 服务应答任何页面调用——但若某次页面调用先到，本行就会占下这个名字，桥接自身的注册随即失败、退化为只用 entry config。要识别这种情况需要能看到同级行的 Loader 视图，而本行挂载所在的 context 并不提供。
- 本包不发布 `./invariant`：它拥有的事实——存储的开关、待扫码的票据、凭证是否存在——都已经通过 `feishuSetup` Remote 面可观测，不存在第二个可能与它分叉的观察源。
