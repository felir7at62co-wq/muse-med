# Agent Note: 将内置飞书桥接改为显式启用

Status: implemented

[English](2026-09-24-desktop-feishu-bridge-opt-in.md) | 中文

## Problem

内置飞书桥接把未配置的启动当成同意：上游在没有凭据时启动扫码注册应用，为跨实例同步开启本地控制服务，并在应答聊天前读取一份共享设置文档。把这个包放进产品 bundle 列表，会在首次启动时注册一个飞书应用并打开这些通道；而它的入口配置从环境变量推导凭据，继承来的变量因此可以把产品指向另一个部署的应用。

## Decision

产品把 `@moyu-good/dsh-lark-bridge` 0.6.1 作为 profile bundle 携带，其 `feishu-channel` 行由[桌面组合补丁](../../../../apps/desktop-host/config/desktop.cordis.patch.yml)以 Loader 的 entry 级 `disabled` 随包发布，该补丁同时覆盖该行的 config，设为 `enabled: false`、`autoRegistration: false` 和 `crossInstanceSync: false`；该行保留 `requireMention: true`，并拒绝 `ask_user_question` 与 `exit_plan_mode`。`disabled` 是唯一能阻止该行插件代码运行的开关，因此未被操作的桌面根本不挂载桥接：不注册设置段，不安装聊天通道、通道工具或 slash 命令。`desktopComposition` 按产品自有设置文档里的 `feishu.enabled` 重新计算该开关，文档或分节缺失即关闭，改动在下一次后端启动时生效。

三个开关来自[兼容性覆盖](../../../../third_party/plugins/compatibility/lark-desktop.mjs)，它只改写私有暂存树；固定的上游快照保持不变。三个开关都是可选字段且默认 `true`，因此未被补丁覆盖的行仍保留桥接上游的常开行为；当它要改写的源码锚点缺失或重复时，覆盖会让构建失败。

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
