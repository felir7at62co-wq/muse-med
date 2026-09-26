# Agent Note: 隔离 muse-med 桌面产品及其生产预设

Status: implemented

[English](2026-09-23-muse-med-independent-desktop.md) | 中文

## Problem

改名后的桌面壳仍可能读取开发环境的凭据和会话。直接删除独立发现的两个短剧预设之一，也会丢失生产规则或破坏保存了该 ID 的会话。可分发产品需要自己的配置，而不修改正在运行的 DSH 安装。

## Decision

已打包的 Electron 入口在访问 profile 前，将后端的 `DSH_HOME` 设为 `~/.muse-med`，或显式指定的 `MUSE_MED_HOME`。继承的 `DSH_HOME` 不能隐式导入开发者数据。未打包的开发模式保留启动器管理的 home。产品不迁移已有会话或凭据。Windows 可执行文件和安装产物名称使用 `muse-med`，macOS 产物归集和上传校验执行同一前缀规则。此次产物品牌命名不修改包 ID、应用 ID、更新地址或协议。

Desktop Host 只发现产品根目录，其中有五个预设、默认 `short-drama`：该产品组合加四个只读原生适配器 `standard`、`ptc`、`minimal` 和 `cordis`。适配器复用上游组合，不维护副本，也不改变名册发现 API，并各自改写组合自带的文件系统技能提供方，不让它去选择部署根目录。嵌套 `cordis:group` 会通过适配器挂载其中的行，因此 `minimal` 组合保留它唯一的工具——持久 shell。短剧预设合并维护中的短剧工具与生产流程规则，共享剧变服务留在 Host，并使用公开配乐索引。产品既不修改部署自带预设，也不修改任何用户预设目录；Web profile 选择随发行版交付的名册而非用户根目录。persona 要求当前用户明确授权制作；已有的自动单项目预算上限仍是独立执行策略，不是新增的授权机制。

已打包 Windows 启动时，把媒体 Python 和 FFmpeg 目录放到子进程环境的搜索路径前部，移除继承的 Python 导入覆盖，并提供随包 ASR 模型目录。运行时准备与已安装产物验证负责检查这些资源的存在性和兼容性；环境接线本身不能证明安装包完整。

Host 启用一个文件系统技能提供方，显式指定随包及产品 home 的 `skills` 根目录，并在启动时创建可写目录。默认根目录发现保持禁用。标准和 PTC 适配器禁用组合原生的近层文件系统提供方，极简组合本来就没有该行，创造模式保留自己那一行、只服务其 persona 点名的组合创作技能，因此没有产品预设会选择旧 `.agents` 或项目目录。短剧、标准、PTC 和创造模式提供技能工具。显式插件技能注册仍然可用。

外部 Python 与 Codex CLI 需要真实文件系统路径，因此完整资源包从 ASAR 解包，消费者在启动前解析解包路径。PTC 保留非秘密的 `ELECTRON_RUN_AS_NODE` 启动标记，因为已打包 Host 的可执行文件是 Electron；模型程序仍获得空环境，不会收到 API 凭据。

抢本命令优先使用 `JUBIANAI_ADMIN_TOKEN`，兼容显式提供的 `JUBIAN_TOKEN`，且只读取当前 home 的主凭据文件。非空 `DSH_HOME` 绝不回退到 `~/.dsh` 或其他账号的凭据文件。缺凭据时停止请求；Python 脚本没有自动连接桌面 UI 凭据 Service 或 Vault 的通道。

产品使用用户提供的参考图，而不依赖小红书搜索。core 的 `style_references.py` import/check 命令复用 `asset_style_references.json`，要求真实图片、逐图审核和用户确认。这是 skill 工作流前置条件，不是新增的收费工具授权检查。产品分发策略排除小红书 skill；缺少浏览器再分发证据时，不捆绑或自动下载浏览器。

产品媒体锁定一个官方 SIL OFL Noto Sans CJK SC OTF 及其许可证。启动时通过子进程环境将 `MUSE_FONTS_DIR` 和 `MUSE_FONT_FAMILY` 传到 Python 与 TypeScript 两条渲染路径。非产品环境的 SimHei／Microsoft YaHei 默认值保持不变；产品不依赖系统已安装这些字体。

开发模式使用与打包相同的社区源码 tarball 和兼容性覆盖，构建到专属 `development/community-plugins` 目录。准备阶段在替换一次性项目之前校验全部压缩包及其运行依赖，拒绝压缩包路径穿越和链接，绝不替代为已安装用户 profile 或未构建的上游源码。跳过构建时若缺少产物，会报错并提示重新构建。workspace peer 和冻结的社区工具链提供开发依赖，不引入第二套安装协议。

profile 解析以物化运行时根目录的 `package.json` 为起点，该目录共同拥有 CLI、Desktop Host 和全部源码插件。只取 CLI 或 Host 的依赖图，会遗漏产品或社区包，即使其文件已经存在。开发模式也将已校验且已安装的社区包记入同一个根依赖表。

准备阶段的私有冒烟插件等待 credentials Service 就绪，为五个产品预设各挂载两个并存 Agent，检查工具、随包技能及产品自定义技能，并用旧目录中的同名技能作负对照；未完成时会记录失败原因。父进程必须读到此完成记录；Host 就绪不代表插件已成功激活。启动限时 60 秒，冒烟检查不提供凭据，也不发送模型请求。

## Alternatives considered

**复用开发者 home。** 这样能自动保留本机账号，却会把新产品绑定到个人凭据、插件和会话状态。显式配置账号可避免意外分发或激活这些资源。

**编辑或删除自带预设。** 当前部署也读取本检出目录的自带预设，修改会影响已有会话，也可能被部署更新覆盖。产品私有根目录保留原安装不变。

**增加预设别名或隐藏 ID。** 使用全新 home 的独立产品没有需要迁移的历史会话。产品自有根目录及原生组合适配器无需扩展名册协议；现有 Web 安装的迁移仍是另一项工作。

## Consequences

现有[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责包共享与插件生命周期。[短剧源码决策](2026-09-22-short-drama-source-and-bgm-library-ownership.zh.md)继续负责技能资源与 BGM 分发。两篇均未被完全取代。

启动测试覆盖默认与显式产品 home、开发模式行为及 Windows 媒体环境传播。Loader 测试覆盖产品名册和可撤销的守卫行为；它不能替代完整预设激活、干净机器媒体执行、GUI 检查或安装包验证。抢本离线测试覆盖假账号 home 隔离及缺凭据时拒绝请求。两条渲染路径已用现有 FFmpeg 二进制通过真实汉字冒烟检查；新包尚未完成干净 Windows 验证。已有 DSH 账号与会话保留在原 home；读取随发行版名册的 Web 安装显示同样的五个模式，默认 `short-drama`。
