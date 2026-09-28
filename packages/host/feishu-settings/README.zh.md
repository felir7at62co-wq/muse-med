# @deepseek-ai/dsh-feishu-settings

[English](README.md) | 中文

产品自有的飞书设置：一个由自身 Config 打开内置桥接的组合行、一套扫码注册流程，以及驱动两者的 Web 设置页。

## 它拥有什么

- **`feishu` 行** —— 本产品的开关。该行以 id `feishu` 组合，因此 settings 服务把它作为 `feishu` 段提供，其自身的 `enabled` 字段（`volatile`，默认 `false`）就是页面写入的值。桌面组合读同一个字段来设置内置 `feishu-channel` 行自己的 `enabled` 键（[`apps/desktop-host/src/feishu-gate.ts`](../../../apps/desktop-host/src/feishu-gate.ts)）；本页是唯一能打开它的入口。
- **`feishu-channel` 行自己的段** —— 内置桥接的凭证。在这个 harness 里，插件的设置段就是它自己解析出的 Config，因此凭证对通过写该行的 config（`appId`、`appSecret`、`registeredBy` 均为 `volatile`，密钥另外带 `role('secret')`）来保存，并通过做了脱敏的 `describe()` 读回——只报告密钥是否已设置。开关为 off 时该行仍保持挂载（被禁用的行没有段可写），并以 `enabled: false` 作为 fail-safe。
- **`feishuSetup`** —— 页面调用的 Typert `@Remote` 命名空间：`status`、`setEnabled`、`setCredentials`、`beginLogin`、`cancelLogin`、`forget`。

## 注册

`beginLogin` 调用 `@larksuite/channel` 的官方 `registerApp`（内置桥接依赖的同一个包），把返回的 URL 在 **Host 侧**渲染成 SVG data URL——浏览器 bundle 不带二维码编码器——并把扫码得到的凭证通过与手工填写相同的入口写进桥接行的段。失败只以有界的 code 传递；平台消息不会进入页面、日志或任何 Remote 应答。

## 保存凭证

`setCredentials` 把 `appId`，以及字段非空时的 `appSecret`，写入桥接行的段。密钥恰好只在尚无密钥时必填：留空表示"保持已存的那个"，而这只有在已存过一个时才有意义，因此页面在填入密钥之前既禁用该操作也说明原因。写入被拒时保留操作者已输入的内容——密钥是页面唯一无法重建的值——只有写入真正落地后才清空该字段。

每一次拒绝都以带类型化原因的 code 抵达页面，而不是 settings 服务自己的消息：该服务的消息会引用它写入的 entry 与路径，而 schema 拒绝可以引用被它拒绝的值——这里就是密钥。`feishu/credentials-unwritable` 带 `section-unregistered`（本组合没有挂载桥接行）或 `write-rejected`；`feishu/secret-required` 与 `feishu/login-failed` 覆盖另外两种。真实异常写进宿主日志。

## 重启顺序

保存凭证与打开开关都在下一次后端启动时生效，因为组合条目的 Config 在启动时解析。页面在开关提示与 `restart-pending` 状态文案里都写明了这一点。

## Known Limitations and Deferred Work

- 本轮群消息策略只读：`approvers` 与发送者/群白名单的权限大于沙箱，页面既不编辑也不显示它们。
- 这里不做真实飞书往返：随包测试替换了注册调用，因此扫码、实时长连接、以及租户自身的权限与可见范围配置仍未验证。
- **刻意的跨插件耦合**：本行对桥接行的段做**读-合并-写**——只动凭证对与扫码者记录，其它键原样保留。这一耦合依赖那一行的 Config schema；上游若改名或改语义，必须同步本行写入的键，否则凭证会写进一个桥接不再读取的键里。
- **开关无法把桥接行变成 entry-disabled。** 设置段只对已挂载的 entry 存在，被禁用的行永远无法接收"桥接首次运行之前扫到的那对凭证"。出厂补丁因此让该行保持挂载，以 `enabled: false` 作为 fail-safe；只要该键为 off，打包插件就会在同步层、控制服务、心跳与二维码应用注册之前返回。
- 本包不发布 `./invariant`：它拥有的事实——存储的开关、待扫码的票据、凭证是否存在——都已经通过 `feishuSetup` Remote 面可观测，不存在第二个可能与它分叉的观察源。
