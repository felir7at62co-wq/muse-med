# Agent Note: 将内置飞书桥接改为显式启用

Status: implemented

[English](2026-09-24-desktop-feishu-bridge-opt-in.md) | 中文

## Problem

内置飞书桥接把未配置的启动当成同意：上游在没有凭据时启动扫码注册应用，为跨实例同步开启本地控制服务，并在应答聊天前读取一份共享设置文档。把这个包放进产品 bundle 列表，会在首次启动时注册一个飞书应用并打开这些通道；而它的入口配置从环境变量推导凭据，继承来的变量因此可以把产品指向另一个部署的应用。

## Decision

产品把 `@moyu-good/dsh-lark-bridge` 0.6.1 作为 profile bundle 携带，其 `feishu-channel` 行由[桌面组合补丁](../../../../apps/desktop-host/config/desktop.cordis.patch.yml)以 Loader 的 entry 级 `disabled` 随包发布，该补丁同时覆盖该行的 config，设为 `enabled: false`、`autoRegistration: false` 和 `crossInstanceSync: false`；该行保留 `requireMention: true`，并拒绝 `ask_user_question` 与 `exit_plan_mode`。`disabled` 是唯一能阻止该行插件代码运行的开关，因此未被操作的桌面根本不挂载桥接：不注册设置段，不安装聊天通道、通道工具或 slash 命令。`desktopComposition` 按产品自有设置文档里的 `feishu.enabled` 重新计算该开关，文档或分节缺失即关闭，改动在下一次后端启动时生效。

三个开关来自[兼容性覆盖](../../../../third_party/plugins/compatibility/lark-desktop.mjs)，它只改写私有暂存树；固定的上游快照保持不变。三个开关都是可选字段且默认 `true`，因此未被补丁覆盖的行仍保留桥接上游的常开行为；当它要改写的源码锚点缺失或重复时，覆盖会让构建失败。

同一个包还被一个本仓库不参与组合的界面挂载：muse Web profile（`~/.muse/profiles/web`）在 `dsh.profile.bundles` 里列的是市场原版 0.6.1，没有 `SOURCE.json`，也没有那三个插件级开关——那份 `Config` 只有 `appId`、`appSecret` 与 `requireMention`，且该行一旦启动，启动路径就无条件开启同步层与扫码注册。在那里唯一能阻止该行运行的开关是 Loader 的 entry 级 `disabled`，因此该 profile 自己的 patch 层（`cordis.patch.yml`，作用于所有 bundle 层之后）禁用 `feishu-channel`，并由受支持的启动路径固化这条默认：`pnpm muse:web` 在启动 Web 应用之前确保该条目存在，只在 profile 列了该 bundle 时追加——没有对应行的条目会让 Loader 记录 `patch: entry "feishu-channel" not found`——已有条目则原样跳过，操作者自己的选择得以保留。桌面闸门层只覆盖桌面组合，两个界面各自独立受闸；在上游 profile 模板能自带 Web profile 默认 overlay 之前，这条默认由该启动器承担。

muse Web profile 也组合了同一个设置行：它的 patch 层插入了同一个 `@deepseek-ai/dsh-feishu-settings` bundle，于是 Web GUI 的设置侧边栏出现飞书分区，而 `feishu-channel` 仍是 entry 级禁用，分区如实报告这一状态。让该行在那里可见需要两个 profile 本地步骤：包的 bundle 必须构建（`lib/client.js` 由 client 行表提供，另有 `lib/index.js`），且 profile 必须能解析到该包（依赖条目 + profile 自己的链接）。Host 面的工作区构建补齐该行 `feishuSetup` 调用所需的 Typert 产物（`lib/typert.host.js`、`lib/typert.remote-client.js`）：所以"分区可见"只差 client bundle 与 profile 链接，而"Remote 可用"要等 `pnpm run build:lib:host` 跑过。官方 `dsh web` 的 home 组合的是市场原包，既没有闸门也没有设置行，因此那条路径启动时仍会自行发起终端扫码注册；要在那里挂同一行是另一个决定，因为同样需要上述两步再加它自己的闸门。

产品自有的设置行把那个开关变成页面：`@deepseek-ai/dsh-feishu-settings` 注册 `feishu` 段（文档缺失、分节缺失、键缺失都表示关闭），发布 `feishuSetup` Remote 命名空间（`status`、`setEnabled`、`setCredentials`、`beginLogin`、`cancelLogin`、`forget`），并在 Host 侧把每个注册 URL 渲染成 SVG data URL——浏览器 bundle 不带二维码编码器。凭证绝不进入补丁或任何组合条目：该行把 `appId`/`appSecret` 这一对写进桥**自己**的 `dsh-lark-bridge` 段，采用读-合并-写，因此该段其余键全部保留，任何配置 dump 也带不走这对凭证。settings 服务拒写未注册的命名空间，所以该行只在开关为 off 时预注册这个段——那正是闸门禁用桥行的唯一一次启动——这也正是流程只有两步的原因：存好凭证并打开开关，然后重启后端，此后桥在自身组合 config 之上解析到已存的凭证。损坏的设置文档同样不构成同意：闸门 fail-closed，只报读取器的 code 与位置，绝不把坏文档变成启动失败。

在产品开关生效时，桥接完全跳过跨实例分支：不读取共享设置文档，不启动控制服务，不发布对等心跳，也不续订 presence。`DSH_SYNC_HOME` 只由该同步存储的目录解析读取，因此产品绝不读取另一个部署的同步目录。被禁用或缺凭据时，它也不启动扫码注册。

该行被激活后，桥接先注册设置段，再经过它自己的 `enabled` 门，这正是该包在休眠状态下仍可配置的原因。凭据填入产品自有设置文档中的 `dsh-lark-bridge` 设置段，绝不放进该行；注册声明的 `applies: 'restart'` 使改动在下一次后端启动时生效。该注册还让这个设置段在桥接解析出的配置里高于该行的组合 base：那里存着 `enabled: false` 时，该行已被激活桥接仍保持休眠；而存着 `enabled: true` 也无法激活一个 `disabled` 的行。补丁会替换目标行的整个 config，所以 `appId` 和 `appSecret` 有意缺席：基础 bundle 行从 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 推导它们，保留这两个键会让继承来的变量把产品绑定到另一个部署的应用。

在 `crossInstanceSync` 为 false 时启用桥接，聊天路径保留，仲裁路径被去掉：入站消息不再对照已退位设备或云端仲裁出的活跃端点检查，命令路径也拿不到同步上下文。

两个凭据并不等于对该租户可用的承诺。飞书应用自身的权限和可见范围决定谁能触达机器人、哪些消息、表情回应与 slash 面板 API 会应答；本插件的授权名单只是收窄这一范围。

## Alternatives considered

**让桥接不挂载，用户之后再添加。** 未挂载的包不注册任何设置段，产品无法在启用前接受凭据，而每次启用都需要一次产品自身设置无法表达的安装。

**沿用上游默认值并在文档中说明。** 首次启动会在操作者没有要求的情况下注册飞书应用并打开控制服务；产品的默认值必须是休眠的。

**在该行保留由环境变量推导的凭据。** 继承来的 `FEISHU_APP_ID` 会把产品绑定到另一个部署的应用，而这正是产品自有 home 与设置要避免的跨部署复用。

**只用 `enabled` 控制桥接。** 为聊天打开它，同时也会打开扫码注册、跨实例设备仲裁和第二次 home 读取；选择聊天的操作者并没有选择这些。而且 `enabled` 是插件 Config 键，桥接会通过自己的设置段解析它，本身不构成激活权威。

**直接修补固定的上游源码。** 已记录的上游修订保持逐字节不变，评审过的改动留在构建覆盖里，而覆盖在写入任何暂存文件之前就拒绝未评审的修订。

## Consequences

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责插件归属、共享包身份与包生命周期；[独立产品决策](2026-09-23-muse-med-independent-desktop.zh.md)负责产品 home、它的设置与组合；[社区源码提案](../../proposed/process/2026-09-23-muse-med-community-plugin-source.zh.md)负责源码保留与显式启用的要求。三者均未被完全取代。

覆盖测试钉住每一处改写、上游快照未变，以及未评审修订被拒绝且不产生部分写入。运行时检查用真实 Loader 与真实设置提供方启动已编译的暂存插件，并带上产品行所设的同样三个开关：存储了 `enabled: true` 且没有凭据时，不注册应用、不开控制套接字、不发外部请求、也不读取无关 `DSH_SYNC_HOME` 下的任何内容；设置段报告 `restart` 与存储值；有凭据时连接一个通道，入站消息到达 agent 而不是设备仲裁回复，释放时关闭该通道。解析配置检查钉住覆盖的 `true` 默认值，产品行检查钉住三个开关与凭据的缺席。桌面闸门检查用真实 Loader 启动组合后的行：设置文档缺席时该行不挂载，存储 `feishu.enabled: true` 时它挂载且三个开关仍为 false，闸门读取在它接受的每一份文档上与设置服务的解析结果一致。

未做过真实的飞书往返。扫码开户、实时长连接、卡片渲染以及租户自身的权限与可见范围配置仍未验证，在打包产品中启用桥接同样未验证。

两条组合约束塑造了这个设置行。Loader 挂载的 service 只能在自己的行注入的作用域里解析服务：无论属性代理还是 `ctx.get`，从 service 自己的 context 都够不到兄弟行，因此 `apply` 在 `ctx.inject(['settings'], …)` 里解析 `settings`（组合里还有 `loader` 时一并解析）并显式传给 service。cordis 还会把注册的 service 包成 Proxy，于是 `#private` 字段在它自己的方法里读不到；该行改用 TypeScript `private` 字段。写进桥的设置段是一次刻意的跨插件耦合：它跟随桥的 `Config`，上游一旦改名或改变凭证键的形状，本行的占位 schema 与写入键必须同步跟动。
