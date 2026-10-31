# 社区插件源码与构建

[English](README.md) | 中文

这些保留的源码快照记录 Muse 社区插件依赖。[sources.json](sources.json) 记录各公开上游仓库、版本、许可证，以及修订或恢复发行包的 SHA-256。快照保留上游源码和清单；部分文本文件将 CRLF 规范为 LF。已安装的用户配置、凭据、用户媒体和生成的运行时均不作为构建输入。翻译检查排除保留的上游目录及经哈希检查的内嵌上游资源；Muse 自有源码与文档仍接受检查。

[owned-downloads.json](owned-downloads.json) 单独固定 Muse 红果和抖音下载 bundle 的版本。清单还包含本地[逆向工具](muse-reverse-tools/README.zh.md)和独立[番茄下载器](muse-fanqie-download/README.zh.md)及[绿泡泡下载器](muse-lvpaopao/README.zh.md)。各包 README 说明配置与验证限制；它们不改变保留的上游清单。

源码清单中 desktop: false 的条目仅保留用于显式兼容工作，默认构建、桌面打包与开发加载均排除。Codex 订阅包含在产品构建中；不会仅因订阅插件而选择可选 Codex CLI peer。--only dsh-codex-subscription 可单独构建其经过审核的产物。

## 构建

使用已安装依赖、且已构建当前 Host 与 Client 包的源码仓库。在仓库根目录运行：

```sh
pnpm --dir third_party/plugins/toolchain run build --out ../../../.artifacts/community-plugins
pnpm --dir third_party/plugins/toolchain run test:host
pnpm --dir third_party/plugins/toolchain run test:build
pnpm --dir third_party/plugins/toolchain run test:im
```

[build.mjs](build.mjs) 按独立的[工具链锁文件](toolchain/pnpm-lock.yaml)执行冻结安装并禁用安装脚本，再在临时目录中逐个编译和打包插件。`--only dsh-ffmpeg` 可选择单个源码目录。临时目录链接当前仓库已构建的 Host 包，不使用在线用户配置。子进程检查使用临时 Harness 主目录，并排除含凭据的环境变量和继承的 `NODE_PATH`，避免包管理器启动脚本将仅存在于工作区的依赖暴露给产物验收。启动器和 preload 选项保持不变。脚本先移除链接，再删除临时目录；源码目录不会产生构建输出或 `node_modules`。桥接的上游 JavaScript 源码本就位于 `lib`。

每个压缩包保留上游许可证和 Codex 声明，按需添加所内嵌 Heroicons 的许可证，并在 `SOURCE.json` 记录上游固定版本、已审核的 Host/vendor 版本及工具链锁文件摘要。[Host 版本审核](compatibility/host-runtime.mjs)拒绝未审核的 Host 或 vendor 版本。产物清单禁用生命周期脚本、固定运行时依赖，并在 peer 候选中显式允许已审核的 Host 和 vendor 预发行版本。产物移除已退役的 `dsh-invariants` 依赖。构建覆盖不修改保留的清单与源码文件。

Codex 兼容构建在 `SOURCE.json` 记录修改：子任务检查与准备仅接受已审核的 Host provider 版本，CLI 仍固定为 `0.153.4`。provider 与 Host adapter 共用 Host 安装的 pi-ai `0.87.1`；复制后的运行时与产物 peer 仅接受该精确版本。覆盖检查保留的 provider 模块和目录测试的 SHA-256。复制后的检查使用当前模型目录，并通过 GPT-5.6 Luna 验证自定义上下文；不会给已移除的离线模型虚构别名。打包后从 `app.asar.unpacked` 解析 CLI 清单和启动文件。保留的上游文件不变；源码文本不符合预期时，补丁失败，而非静默跳过。

Codex 订阅模型仅在连接了 Codex OAuth 账号时出现在模型选择器中。Muse 登录不授予订阅供应商的访问权限；断开 Codex 后，下次查询列表会隐藏其模型。其模型菜单与固定分组标题在浅色和深色模式下均使用主题的不透明底色。私有构建补丁使用共享的 portal 和视口定位，每次显示一个面板，保留模型、推理等级、速度与输出详略操作，并在 `SOURCE.json` 中记录这些配置。

桌面面板还会把运行时已注册的 MCP 工具列为只读连接。内置 `muse-account` 显示为 Muse 服务，并展示已注册工具数量。兼容覆盖不会把凭据、环境变量值或私有启动参数复制到列表中。

## 兼容性与桌面集成

`dsh-skill-mcp-panel` 固定于上游 2.3.5。它通过 Web 侧栏管理当前 profile 的技能和 MCP 服务配置。随桌面应用打包的产物移除上游 `dsh-panel` 可执行入口，并禁用自动安装全局 CLI：Desktop 只通过 `dsh` profile 启动受支持的 Node 应用。启用时不会调用 npm 或写入应用目录；隔离构建在只读目录下加载生成的面板，并确认技能和 MCP 注册仍然存在。面板网关负责配置 MCP 连接，实际 MCP 客户端仍为 `@deepseek-ai/dsh-mcp-client`。隔离构建会运行保留的模型、网关、插槽与图标检查。

Skills 与 MCP 插件随 Muse 更新。检查完成且内置版本已是最新时会清除更新横幅；上游发布更新版本后仍会显示提示，引导桌面用户更新 Muse，而非安装全局面板 CLI。

Muse 面板及其嵌套技能提供方排除共享用户目录 `~/.agents/skills`，也不使用 `DSH_AGENTS_HOME` 指定的共享目录。为编程助手安装在其中的技能不会出现在 Muse 的管理列表或嵌套目录中。Muse 自有用户技能和明确引用的工作区技能仍然可用，共享技能文件保持不变。Host 文件系统提供方另行将发现范围限制在产品配置的根目录内。

面板识别工作区的 `.muse/skills`、`.dsh/skills` 与 `.agents/skills` 目录，导入继续使用原有全局或工作区保存位置。格式校验和文件事务成功后，新增的结果字段 `status: saved` 与 `discovery: ready | pending | unavailable` 分别表示文件已保存和当前会话的发现状态。尚未发现或无法检查时，浏览器保留对应的中英文提示，不会误报格式错误或删除已保存文件。真正的写入失败仍只回滚本批新建目标；此改动不能还原旧版本已经删除的文件。

构建脚本导入每个生成的 Host 入口。Codex 构建针对当前 DSH API 和 pi-ai 0.87.1 执行 26 项保留的上游检查，包括模型准备和已认证传输校验；上游注册上下文是测试替身，而非完整桌面 Loader。另有八项 Codex 检查加载真实 provider、Host adapter 和 CLI，通过模拟对端验证订阅 SSE 与子任务认证传输，并拒绝运行时版本偏移及错误的归档路径。FFmpeg 执行 89 项保留的检查。构建测试检查导出产物文件，并验证同一平台下两个全新临时目录生成的所有固定插件压缩包均逐字节一致。这不代表跨平台或整个安装包逐字节一致。

Codex 构建还在缺少可选 CLI 的情况下，通过真实 Loader、Settings、本地凭据、LLM、Web 与工具提供方加载产物，检查账号 RPC、重启后的设置保留、卸载和零外网请求。必跑的 Client 产物检查使用当前 Cordis、React、slot 与基础组件挂载账号设置和模型选择器，执行登录命令、模型选择与卸载验证。已记录的 Session 场景覆盖真实订阅图片工具及其未登录账号的拒绝结果。

[桌面打包入口](../../apps/desktop/scripts/package-target.ts)在 S6 步骤构建两份清单中启用桌面的条目，并将压缩包放在第一方打包输入旁。[包集合准备](../../apps/desktop/scripts/prepare-package-set.ts)将[源码插件包名](../../apps/desktop/src/core-package-set.ts)选为显式根，并拒绝注册表替代。桌面开发启动同样构建并暂存其中启用桌面的条目。打包不等于启用：发布仍须通过真实桌面 Host/Client 烟测。账号登录、收费请求和真实媒体编码不在这些免密构建检查范围内。

Market 的 HTTP 界面不适用于无端口的桌面传输。Codex 使用可选的 connection fetch 传输，不要求 Web 服务器。FFmpeg 需要产品配置编码器路径。压缩包存在不代表功能已启用。

### Muse 远程桌面与飞书

`@wenbin_wb/dsh-bridge` 保留上游 2.12.1 版本及 [sources.json](sources.json) 中的固定修订，并保留 MIT 署名。[规范化记录](dsh-bridge/MUSE_SOURCE_NORMALIZATION.json)记录了 21 个规范化尾部空白或文件末尾换行的文本文件的上游与本地 SHA-256。[审核后的覆盖](compatibility/bridge-desktop.mjs)固定该记录，在打包前检查每个规范化文件及保留模块，并将记录写入 `SOURCE.json`。其桌面产物仅保留账号隧道模块，不包含旧飞书 Host、Client、网关、会话桥、文件工具和 SDK。根入口明确报错并引导 IM 使用者改用 `@xmanrui/dsh-im`；`./client` 不再提供，`./remote` 继续提供账号绑定的桌面访问。默认 bundle 挂载规范名称的原生 IM 提供方。产物还排除上游应用 bin、局域网代理、独立隧道服务端、Cloudflare、自更新和上游密码/二维码认证。

远程 provider 复用 `CustomTunnelClient` 的连接建立和原生 WebSocket 升级处理。Muse 适配器直接流式转发原生字节，不积累完整数据帧，包含 Host Ping 和浏览器 Pong；同时提供账号/设备认证、流式 HTTP 上传与下载、逐块确认、取消、按配置间隔持续重连和等待完成的关闭。本地传输测试覆盖二进制上传、Range 响应、不完整原生数据帧、`/api/remote.mux` 心跳往返、取消及凭证拒绝。握手在安装 UUID 之外增加电脑名称和操作系统。云端 relay 验证账号，把每个浏览器标签页路由到其选择的安装，并保持其他电脑连接；桌面仅转发至自身回环 Host。这是一条私有出站连接，不创建公共隧道域名。

`@xmanrui/dsh-im` 提供原生 IM机器人设置、飞书实时过程卡和通道管理。[sources.json](sources.json) 固定其 MIT 源码。[IM 适配层](compatibility/im-desktop.mjs) 在私有暂存区构建上游 Host 和 Client，并在根入口放置 Muse 导入器。空 bundle patch 避免建立第二个 Host 连接。旧 PGZXB 源码以 `desktop: false` 保留，不再激活。账号远程访问继续使用桥接包独立的 `./remote` 提供方。

导入器通过 Host 凭据服务迁移已启用的旧凭证；只有真实已授权消息证明旧聊天对应的发送者后才导入私聊绑定。原文件和完整旧消息认领记录保留。只有原生 `dsh-im` 接收飞书消息和卡片回调，旧数据迁移不参与这些事件的授权。消息和卡片操作使用原生 IM 设置中保存的访问策略，不再叠加旧群名单或私聊名单限制。群消息仍须精确 @ 当前机器人，已登记的主人保留原生特权访问。已有原生 IM 机器人不会被覆盖。没有旧凭证时仍可使用原生 IM 设置。详见[迁移指南](../../docs/upgrade-guide/v0.2.1-alpha.1/muse-im-channel/guide.zh.md)。

获准发送消息的成员无需命令权限，即可回答自己发起任务的提问，包括自定义答案。其他用户会收到明确提示，不能代答该问题。管理按钮仍要求命令权限。群访问策略设为开放只允许消息接入，不改变 Agent 的工具权限或沙箱设置。

同一飞书机器人的私聊和群聊都使用其 IM 设置中选择的工作区。各聊天共享该目录的文件和素材，但分别保存 Session 历史。启动时会清除单个聊天的工作区覆盖，并解除 Session 工作目录与机器人工作区不同的绑定；目录匹配的绑定保留原 Session ID。后续对话命令不能重新建立私有目录覆盖，也不能绑定其他聊天当前使用的 Session。选择其他机器人工作区后，其所有聊天的后续工作都使用新目录。旧 Session 日志与文件留在原位置，适配层不会搬迁。

Muse 包装层和原生飞书插件显式声明 `sessions`、`sessionPersistence` 依赖，使工作区校验可以读取活跃或已持久化的 Session 头部信息。隔离 IM 检查以离线平台传输验证迁移、真实 Loader 和 Agent API、群提及、控制归属及原 Session 历史恢复。服务访问受限的 Cordis 插件通过真实 Host gateway 新建私聊和群聊 Session，验证两者使用同一所选工作区且历史独立；缺少依赖的反例会在请求模型前拒绝未声明的 Session 访问。构建检查比较两份完整 tarball，核对原生 Client 和许可证，并确认保留的上游文件未被改动。这些检查不认证真实机器人，也不能证明租户权限已配置。

### Muse Bot

[Muse Bot](ds-bot/README.zh.md)是固定源码的原生团队工作区。桌面 bundle 只添加一个 Bot 插件，保留 Muse 的模型路由、网页搜索、任务界面、上下文压缩和目标工具。受控构建要求内置记忆复盘默认开启，并在 `SOURCE.json` 中记录该设置；[Bot 参考](ds-bot/README.zh.md)说明配置和模型费用。构建会重建其浏览器模块，并保留 Apache 许可证、上游署名与来源收据；不包含独立插件更新或上游独立应用。

原生飞书群聊和私聊各按已登记应用与聊天 ID 绑定一个 Muse Bot，名称不参与路由。群名通过已认证的群信息接口读取；私聊使用入站发送者姓名，或复用已有消息读取接口，核对原消息、聊天和发送者后再采用姓名。成功取得的名称跨重启缓存；元数据暂不可用时保留 Session 标题，通道重启后再尝试，后续入站发送者姓名也可补齐缺失信息。不申请通讯录权限。团队服务分别保留真实聊天标题和可用于寻址的唯一 Bot 名称，保留用户手工改过的名字。原 Session、工作区、模型和目标保持不变，显式 `/new`、`/use` 延续同一 Bot 身份。第一版绑定记录兼容缺少聊天名称元数据的旧群记录，并原地补充元数据。

工具发现使用 Host 的单一服务：新团队分别配置协调主控和 Muse 专业执行者，各 Bot 独立保存常驻工具。工具选择、历史与缓存行为见[工具发现参考](../../packages/core/tool-discovery/README.zh.md)。

### 红果公开数据

`muse-hongguo-search` 保留恢复的 0.1.0 JavaScript 源码、MIT 许可证、[恢复记录](muse-hongguo-search/RECOVERY.md)及原发行包。原开发提交未恢复；`sources.json` 固定已核实的原包 SHA-256。[Host 覆盖](compatibility/hongguo-host.mjs)依据固定清单检查全部 22 份保留文件，增加经过测试的精确 tools peer，并关闭全局启用。标准、PTC、创造、短剧和编辑预设各自在自己的作用域启用四个工具；极简模式不提供红果工具。

搜索、详情、榜单与收藏筛选读取官方公开数据页，不需要 key 或 Cookie，也无需用户初始配置。结果区分收藏、点赞、热度、近似数及未完整覆盖的数据。搜索覆盖首屏窗口，榜单覆盖所选公开榜单，不能冒充全平台片库。网站请求保持串行、限速、缓存并支持取消；访问限制明确报错。插件不下载视频。恢复后的 20 项离线测试及真实 Host 注册、规范结果、提示词发现、输入拒绝、取消和卸载检查随打包运行。`test:hongguo` 检查两个全新目录生成的压缩包一致；实站可用性另行只读检查。

### Muse 本地工具

在仓库根目录通过独立[构建脚本](build-downloads.mjs)打包自有下载 bundle：

```sh
node third_party/plugins/build-downloads.mjs --out .artifacts/download-plugins
```

标准、PTC、创造、短剧和编辑预设在各自的智能体作用域内启用 `hongguo_download_info`、`hongguo_download`、`douyin_download`、`reverse_skill`、`reverse_analyze`、`fanqie_download_info` 和 `fanqie_download`；极简预设不提供这些工具。工具以发起调用的会话工作区为输出位置。通过 `dsh plugin --profile headless add <tarball>` 安装压缩包会在该 profile 启用对应 bundle 补丁；构建新的桌面发行版则通过预设组合内置它们。

下载 bundle 打包支持 npm 与 pnpm 的生命周期入口；生命周期入口为原生程序时，解析已安装 pnpm 的 JavaScript bin 或 Corepack 启动器，并通过包管理器环境禁用生命周期脚本。Node 打包器不会将原生 pnpm 程序当成 JavaScript；桌面进程编排可以不经过 shell 直接运行该程序。`node --test third_party/plugins/download-pack.test.mjs` 使用已安装的 JavaScript 启动器和 pnpm 的实际生命周期入口分别验证所有自有压缩包，检查凭证文件排除规则，并保持源码清单不变。Node tar 解析器按精确 Unicode 路径读取归档成员。逆向与番茄压缩包必须包含 `SOURCE.json` 声明的文件，且 SHA-256 完全一致；npm 排除的上游 `.gitignore` 元数据除外。

红果默认使用用户提供源码的原接口，并接受多部系列 ID。操作者必须按包内文档配置原始 `config.json`、`devices.json` 和可用的签名服务。缺少原源配置会明确失败，公开试看集不代表全集可用。抖音接受用户指定的视频链接列表，对每个下载运行 FFmpeg 验证，并报告被拦截或部分完成的批次。视频列表本身不代表已覆盖整部剧；平台登录或验证在 Muse 内置浏览器面板中完成，不使用外部 profile 或 Cookie 文件导入。

## 许可证

再分发前请阅读各自保留的上游许可证和声明。构建保留 Codex PSD 编解码器声明，并包含内嵌 Heroicons 的完整许可证。运行时依赖在打包后的依赖图中保留各自许可证。Muse Med 不宣称这些项目由本团队创作或得到其背书。
