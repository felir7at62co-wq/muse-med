# Muse 桌面端

[English](README.md) | 中文

桌面应用是完整 dsh Web 应用外的一层 Electron 壳。Electron RunAsNode 子进程启动共享 profile runner，Electron 立即从 `dsh-app://app/` 加载打包内的 Web 入口。共享加载页等待 Host 启动注入，然后在同一文档中启动客户端。Electron 将应用 HTTP 请求转发给已认证的 Web Host，转发时丢弃描述 Node fetch 连接而非资源本身的响应头（`transfer-encoding`、`connection`、`keep-alive`），并把插件 bundle 响应标记为 `no-store`，因为其每次启动都变化的 revision 只会在 Chromium 磁盘缓存中累积；WebSocket 流连接到该 Host，仅为归属的应用窗口附加凭据。Node IPC 承载启动注入、就绪与关闭。muse-med 只绑定 `127.0.0.1`，由系统分配端口，避免占用官方 DSH 应用的端口。共享 profile runner 提供设置和插件管理服务；生成的产品覆盖层保留产品预设、内置技能及飞书开关。共享包通过运行时解析，不创建指向 ASAR 内部的目录链接。

桌面壳显示 **Muse**，使用 `renderer/icon.png`：由提供的黑底白蜘蛛原图转换的方形 PNG。Windows 托盘和可执行文件图标由它生成；macOS 打包直接使用它。Windows 可执行文件为 `muse-med.exe`；打包和上传校验统一使用发布文件名 `muse-med-${version}-${os}-${arch}.${ext}`。muse-med 使用自己的应用标识和 GitHub 更新源。已打包 muse-med 的会话、设置、凭据和插件使用 `~/.muse`；当旧的 `~/.muse-med` 目录存在而 `~/.muse` 不存在时，它继续读取旧目录，因此改用新 home 的版本不会让已安装副本的数据落空；`MUSE_MED_HOME` 可显式覆盖该位置，继承的 `DSH_HOME` 或 `MUSE_HOME` 都不会选中它，因为它们可能指向共享的 harness home。开发模式保留启动器管理的独立 home。

Muse 产品版本由 [`muse-product.json`](muse-product.json) 声明，当前为 `1.0.0-beta.1`。Electron、安装包文件名和更新版本比较使用该版本或其带编号的测试构建。内置 DSH 包保留独立的 `0.1.7-rc.8` 版本；关于和崩溃报告显示 DSH 版本及源码提交。产品版本变化不会改变应用 ID、数据目录或更新缓存身份。

视频预览使用鉴权 `/api/video` 流。Electron 转发字节范围与响应流，不复制完整视频。未经内容编码且状态为 200 或 206 的 GET/HEAD 响应保留合法的 `Content-Length`，供原生媒体跳转使用；编码响应与其他路由沿用普通解码响应头策略。关闭预览会取消其流，不停止 Agent 工作。

## 关键技术决策

`renderer/icon.png` 是应用窗口、macOS 安装包和“关于”对话框使用的 Muse 图案。[render-tray-icon.ts](scripts/render-tray-icon.ts) 由它生成已提交的 Windows 托盘与可执行文件图标；图案变化后运行 `pnpm run render:tray-icon`。[render-brand-assets.ps1](scripts/render-brand-assets.ps1) 从同一图标渲染安装页面的明暗主题图像，以及欢迎页的 `renderer/assets/welcome-mark*.png`；图标变化后重新运行它，使这些界面使用当前图案。卸载程序的欢迎和完成页共用 `installer/assets/uninstaller-sidebar.png`，准备阶段将其转换为 164×314 BMP。

快捷键覆盖保存在 `app.getPath('userData')/keybindings.json`，与 `DSH_HOME` 分离。主进程校验并串行保存修改后才发布已接受键位。读取失败保留上次接受的键位并阻止编辑，包括全部恢复；不可读和未来版本的文件保持不变。开发时可通过 `DSH_DESKTOP_USER_DATA_DIR` 隔离这些偏好，启动器会输出解析后的路径。格式和冲突语义见[快捷键服务](../../packages/client/shortcuts/README.zh.md)。

macOS“文件”菜单显示已接受的单键绑定（包括方向键），并通过 Client 页面 owner 路由“关闭页面或窗口”。Windows 和 macOS 在主文档、内嵌 frame 和浏览器 guest 输入之前拦截所有已接受的完整绑定，包括编辑和终端输入。录制和输入法组合状态仍受保护。更新蒙层从创建到最后一个蒙层关闭期间阻挡父窗口及其浏览器 guest 的产品快捷键和编辑按键递送。每次打开或关闭蒙层都会作废待完成的组合键状态。主进程通过显式的创建能力和输入状态读取能力，让更新对话框与快捷键输入共享同一个蒙层管理实例。双键组合会将首键的初次按下事件交给页面，且不拦截其松开事件；完整组合及其重复事件会被消费。渲染进程将可配置绑定的分发交给原生适配器。双键组合不注册原生菜单快捷键。已接受的命令通过可信 preload 转发一次。Linux 通过 DOM 分发主文档快捷键，并将已接受的内嵌 frame 绑定转发给 Client 解析器。关闭最后一个窗口后 macOS 保留应用生命周期；Windows 退出桌面实例并停止其任务。[关窗决策](../../.agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.zh.md)记录了这一生命周期选择。

macOS PNG 使用带留白的圆角底板，供传统 ICNS 打包使用，包含最高 1024 像素的表示。它是扁平图标，并非 Icon Composer 文档。Apple 的[应用图标指南](https://developer.apple.com/design/human-interface-guidelines/app-icons)要求向 Icon Composer 提供未遮罩的图层；这些输入需要在 macOS 上单独导出，不能复用已做圆角的 ICNS 图案。发布前须在支持的 macOS 版本中验收 Finder 和 Dock 的显示效果。

<a id="bundled-workspace-dependencies"></a>

### 内置工作区依赖

electron-builder 只把清单中的 `dependencies` 复制进 `app.asar/node_modules`，因此 Electron 主进程 bundle `lib/main.js` 内联其工作区 devDependencies，裸导入只剩 `electron`、Node 内置模块与这些 `dependencies`；沙箱 preload 只能留下 `electron`、`events`、`timers` 与 `url`，即其 `require` polyfill 能解析的模块。主进程 bundle 从被内联包的 `lib/` 产物解析它们，所以根 `build:lib:host` 在并发的工作区 tsdown 阶段之后才为 `apps/desktop` 打 bundle，并由 [`desktop-bundle-imports`](scripts/desktop-bundle-imports.mjs) 让任何静态、动态或 `require()` 导入无法在打包应用内解析的 Desktop bundle 直接失败。没有这项检查时，rolldown 无法解析的导入会作为外部说明符进入产物，并在启动时以 `ERR_MODULE_NOT_FOUND` 失败。[bundle 顺序决策](../../.agents/notes/implemented/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.zh.md)记录了备选方案。

Windows 签名打包按 PE 文件内容扫描第一方运行时和应用生产依赖，包括没有常规扩展名的文件。最终扫描覆盖整个解包应用。目录链接、格式错误的 `MZ` 文件以及非 PE 的 `.exe`、`.dll` 或 `.pyd` 文件会使打包停止；以 `MZ` 开头的数据文件也会被拒绝，除非包含有效 PE 头。它保留有效的上游签名，并在记录运行时哈希或执行冒烟检查前为未签名代码补签。公钥验签每个进程处理最多 32 个文件，同时最多运行四个进程；硬件令牌签名仍串行执行，每个新签名必须匹配配置的证书且带时间戳。硬件签名或验签失败会停止本轮执行；独立的时间戳请求遵循下文的有界重试规则。electron-builder 只有在验签和逐字节比对通过后，才保留复制后运行时可执行文件的签名。写入发布完成记录前，必须通过最终 PE 签名检查，以及使用全新缓存的 ASAR 载荷和 Host 冒烟检查。开发、仅准备和未签名构建不使用硬件令牌，可能被 Windows 代码完整性策略阻止；任何构建模式都不会关闭该策略。冒烟检查通过不代表兼容所有企业策略。

Desktop 携带独立的 Python、Node.js 和 pnpm 分发包。Python 包含 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml、XlsxWriter 及其完整依赖。`load_workspace_dependencies` 工具首次使用时，将该产物离线安装到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`（通常为 `~/.dsh/dsh-runtimes/dsh-primary-runtime`），并返回解释器、pnpm 脚本和库目录的绝对路径，以及记录内置分发包名称与版本的 `pythonDistributions`。版本报告不包含用户自行安装的包。Office 任务默认使用这些库，用户或工作区指令指定其他环境时遵循其要求。pnpm 脚本通过返回的 Node 可执行文件运行。返回的 Node 库目录为随包交付的库预留，不是 pnpm 的全局安装目录。

Desktop 默认注册 `office-docx`、`office-pptx` 和 `office-xlsx`。这些技能使用内置 Python 库创建文件和进行定点编辑，随后重新打开文件，并在交付前运行共享结构检查器。PowerPoint 的创建和编辑使用 python-pptx。技能资源复制到 ASAR 外的 `runtime/office-skills`，让 Python 可以读取检查器。可用的 `render_document` 工具可以补充视觉检查；缺少该工具不妨碍创作或交付。检查范围与限制见 [Office 技能包](../../packages/skill/skill-office/README.zh.md)。

该产物随 Desktop 版本发布。`runtime.json` 记录 Desktop 版本、目标平台、顶层解释器和包管理器版本及 Python 分发包版本表，以及所选目标的锁定产物输入与组装格式的摘要。分发包名称按 PEP 503 归一化；名称归一化后重复时，清单会被拒绝。旧 `components` 清单通过归一化继续可读，并保留其原有库版本一致性校验。匹配的安装会被复用；依赖或压缩包变化后，即使 Desktop 版本不变，也会在完整暂存副本完成后替换目录。不含摘要的旧清单会在下次安装时被替换。用户自行添加的 Python 包仅在产物身份一致时保留。目录替换失败时保留之前的安装；解释器仍在运行时，Windows 可能拒绝替换。

Desktop 私有的 `runtime/bin` 目录仅添加到包安装进程，不进入 PTC 和 agent shell 从 Host 继承的 PATH。该工具不修改 PATH、环境变量或用户包管理器配置。pnpm 的全局包、命令入口和 store 保留自身默认值及用户设置，包括环境不支持全局安装时的原生错误。不提供独立依赖更新器。[第一方 Runtime 决策](../../.agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.zh.md)记录这些选择。

Node 准备内置解释器和 Python 库，无需系统 Python 或 pip。[下载锁](../../scripts/primary-runtime/lock.json)固定解释器压缩包、Python 分发包版本及目标平台 wheel 的 URL 和哈希；共享构建器从根开发依赖中解析 pnpm 固定版本。测试检查根 package-manager 版本和 Desktop 固定版本保持一致。每个目标的 wheel 文件名必须与分发包版本一致。所选目标、wheel 记录及分发包映射内部的键顺序，以及 wheel 条目顺序都会影响产物身份，编辑时须保留；锁文件顶层键的顺序不影响该身份。库 wheel 解压到 site-packages，各 wheel 的 `.data/scripts` 目录保留辅助文件，不生成命令行包装器。其他安装方案会被拒绝。本机目标检查在清理暂存目录后以及 macOS 签名后验证锁定 wheel 的集合与版本，允许解释器自带的 pip，并检查 Python 版本、Office 文档读写和依赖完整性，不写入字节码。独立 Node 可执行文件获得 V8 所需的 JIT 权限。跨目标执行和签名安装需要对应的发布主机。`dev:desktop` 和 `start:desktop` 都会在启动 Electron 前准备 `.desktop-build/targets/<target>/runtime/primary-runtime`；首次准备可能需要下载锁定的依赖。准备未完成时，启动命令不能报告成功退出。

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证。 | Muse 拥有独立产品版本；打包校验内置 DSH 的精确版本，并记录两者。DSH 升级随重新验收的产品版本一同发布。 |
| 运行时 | Electron 的 Node.js 带有 Electron 补丁、fuse、ABI 与生命周期约束，而系统运行时和包管理器状态不可控。 | dsh 通过内置的上游 Node.js 运行，所有包操作都使用内置 pnpm。Electron 的 Node.js、系统 Node.js、系统 pnpm 与用户的包管理器配置都不进入执行路径。Node.js 官方许可证按原始字节随包保存在 `runtime/node/LICENSE`。 |
| 包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | `app.asar/dsh` 携带完整生产依赖树；profile 只安装外部插件。 |
| 状态归属 | 共享可执行依赖图会让 CLI（命令行界面）与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile。 | Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。已打包产品在访问 profile 前设定自己的 `$DSH_HOME`，不导入 CLI 数据。可执行包、插件激活、锁文件和 `node_modules` 仍由 Desktop 独占管理。 |
| 通信 | 监听 Web 服务会引入端口归属、认证、CORS 与暴露风险；Electron 与上游 Node.js 之间也需要明确的跨进程协议。 | 已认证的 Host 监听系统分配的回环端口。Electron 通过 HTTP 转发 `dsh-app://` 请求，WebSocket 流连接同一个 Host。Node IPC 承载就绪通知、归属的原生视图所需凭据，以及生命周期控制。 |
| 插件变更 | 包安装和 Host 启动可能失败。 | Desktop 停止 Host 后直接修改当前 profile。失败保留部分修改供用户修复，不自动回滚 profile。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。 | Electron 壳、匹配的 dsh 运行时、Node.js 与 pnpm 组成一个已签名更新单元。平台更新产物可以复用未变化的数据块，但运行时版本选择绝不脱离 Desktop 发布。 |

[薄壳决策](../../.agents/notes/implemented/architecture/2026-09-10-desktop-web-wrapper.zh.md)负责共享 Web 行为与 Desktop 适配。[Electron 打包与更新决策](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责发布身份、签名及更新验收。


## 安装归属

Electron 拥有 `$DSH_HOME/profiles/desktop`。其 `dependencies` 包含 pnpm 安装的包；`dsh.profile.bundles` 包含内置 bundle，后接已启用插件。签名应用从 `resources/app.asar/dsh` 提供 dsh、私有 Desktop Host 及其生产依赖。打包应用选择 runtime profile 解析，不创建包链接；开发 profile 使用文件系统链接。宿主与插件在同一个 Electron Node 模式进程中执行；Desktop 不启用 `--preserve-symlinks`。CLI 不能启动或修改此 profile。

Desktop Host 为所有桌面会话只组合一次短剧设置和剧变工具；有报价的收费调用按剧变 `script_id` 自动使用人民币 4000 元默认上限，本机设置可调整额度。宿主加载维护的短剧技能包，提供六个产品预设：默认的 `short-drama`、编辑模式、标准模式、PTC 模式、极简模式和创造模式。编辑模式将获授权的小说或视频整理成可追溯的来源大纲，提供不同换梗方向及可调整的集数与篇幅建议，再写完并审校用户选定的剧本。视频转写须先校订为分场剧本，再尝试写入当前账号的私有知识库；成功项读回核对，失败项保留项目文件并标明。写正文前，Agent 阅读本次来源剧本或小说，也可检索并打开获授权的知识页参考写法；参考页不可用不阻止创作。编辑反馈保存在项目版本中，只有已授权且校订的修订稿才写入知识库。MUSE 登录提供按账号隔离的知识库和云端语音服务；随包 MCP 按 ID 检索并阅读获授权的来源和 Wiki 页面。开头读取工具接受获授权的 `viral-script` 来源和当前账号的私有剧本。账号绑定的 `audio_transcribe` 工具向除极简模式外的桌面预设开放；模型提供方凭据仍须在模型设置中单独配置。四个原生编码预设通过只读薄适配器复用；其他自带及个人预设仍被排除。Windows 打包准备构建哈希锁定的 Python、文档与媒体依赖及 FFmpeg 运行时；完整安装包及干净机器检查通过前，发布仍未验收。公开分发二进制还须完成媒体描述文件记录的对应源码审核。

用户尚未保存其他通道时，Muse 的资产图默认使用 KU_AI。Agent 先检查整批提示词、参考图、身份、对账证据及预计费用，再让剧变并行提交生图；每项保留独立幂等键、预算判定、回读及视觉审核。Agent 核对实时价格后，可在已授权范围内为单次调用选择 DUO_YUAN_TAN_SUO 作为备用通道；收费任务仍在处理或结果未知时，必须先对账，再换通道或 key。随包的技能与 MCP 面板出现在 Web 侧栏，管理当前 profile 的配置。根 Agent 完成一轮任务或调用 ask_user_question 时，桌面壳会播放系统提示音。短剧任务完成时逐集交付已核验的成片和对应的剪映可编辑草稿。

本地启动页提供启动状态和可用恢复操作；加载后的 dsh 渲染进程仅接收桌面协议标记。独立插件窗口接收结构化的列表、安装、删除、更新和更新检查操作；两个渲染进程都无法访问文件系统、原始 Electron IPC、shell 或任意 pnpm 参数。

应用 preload 只向 `dsh-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择、用于 composer 路径引用的 `__DSH_HOST_PATHS__` 桥接和租约范围内的 Browser 桥接。产品页面还获得含 `productName: muse-med` 的 Desktop 标记、更新展示数据和打开原生确认的操作，不能选择安装产物或授权安装。Muse 产品标记使设置仅显示 MUSE 账号入口，隐藏 DeepSeek 账号与余额入口。插件管理使用 Web 应用经过认证的 HTTP API；独立插件窗口是唯一额外的管理文档。Electron 在 `dsh-app://shell/` 本地提供该窗口文档、更新弹窗文档和资源，不依赖 Host 就绪。任何渲染进程都不会获得文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数。

只有主应用窗口启用 `<webview>`。guest 挂载必须匹配主进程签发的租约和分区；guest 保持 sandbox、context isolation 和 Web security，不启用 Node integration 或 guest preload。Browser IPC 监听只为应用文档创建。[Sidebar Browser](../../packages/client/ui-sidebar-browser/README.zh.md) 说明存储分组和 guest 限制；Host 鉴权仍独立于 URL 过滤而必需。

`dsh-app://shell/` 无需联系 Host 即可提供打包的更新文档、脚本和样式。静态请求保留 GET/HEAD、路径范围和 MIME 处理；每个更新文档继续使用隔离 preload 和所属窗口的 IPC 校验。

产品 UI 保留 Web 操作，包括通过共享认证 HTTP 路由执行的“打开方式…”。Desktop 使用 Web 的自动目录选择机制，并以共享 Web 模板的 bundle 列表初始化新 profile。

Electron 根据应用语言选择类型化的英文或中文 shell 文案，并回退到英文。macOS 应用包通过 `CFBundleLocalizations` 声明支持英语和简体中文，让 macOS 根据用户的首选语言匹配初始应用语言。主界面仍优先使用已保存的 Client UI 语言偏好。在 Windows 上，主文档的语言会更新桌面菜单、恢复与更新提示。仓库 Client UI i18n 检查覆盖桌面端源码。

Windows 使用 40 DIP 顶栏，保留原生窗口按钮，颜色随应用调色板同步。侧栏开关旁的本地化“应用”和“编辑”入口打开原生弹出菜单。仅当应用框架发布 shell overlay 席位后才挂载菜单，启动加载期间不显示。“应用”提供桌面插件、检查更新和退出；“编辑”向当前编辑器发送对应按键，提供撤销、重做、剪切、复制、粘贴、删除和全选，不受自定义快捷键绑定影响。插件管理使用主应用的“插件”页面。按 Alt 不会出现额外的原生菜单行。其他平台保留原生菜单。可编辑区域保留快捷键和不带快捷键标注的右键菜单；命令可用状态由 Chromium 提供，选中的只读文本提供“复制”命令。

macOS 上自定义菜单保留 Electron 的标准 Window 菜单及应用隐藏命令，包括 Minimize（⌘M）和 Hide（⌘H）。Linux 保留应用菜单和 Edit 菜单。

### 短剧资源与限制

维护中的短剧技能 tarball 不含小红书技能。工作流通过 core 的 `style_references` 导入与检查操作接受用户提供的参考图，并保留继续制作前的审核和用户确认。这些是技能层面的要求，不是新增的收费工具授权机制。Python 与 TypeScript 渲染路径为字幕和水印选择锁定的 OFL 许可 Noto 字体。源码测试及开发用 FFmpeg 输入的字形渲染已通过；最终重建安装包与干净机器的字体路径仍待验收。

本地媒体准备覆盖 Python 文档与媒体依赖及 FFmpeg；默认负载不含本地 ASR 模型或 Whisper 依赖。默认云端转写需要登录 MUSE、网关已启用服务且服务器有提供方额度；桌面版没有用户 ASR 或 TOS 凭据设置页。模型生成仍须单独配置提供方凭据。公开 BGM 匹配与下载需要联网；可选的 MERT 索引与单曲分析不属于默认离线媒体运行时，且仍受非商业许可限制。随包的剧变抢本技能使用产品内剧变凭据设置；认领前需要用户明确授权目标；定时抢本还需指定开始与结束时间，token 不得写入提示词、日志或源码。

### 运行时与插件激活

[社区源码构建器](../../third_party/plugins/README.zh.md)提供六个必需的本地 tarball 根包；缺少输入会停止打包准备，不回退到 registry 二进制。Codex 订阅、FFmpeg 工具、Ponytail、技能/MCP 面板和 `@wenbin_wb/dsh-bridge` 是内置 profile bundle。插件市场不挂载；原生产品目录消费产品构建为该包新增的 `./catalog` 导出。

应用 → 桌面插件把六个内置社区包与用户自装插件分开显示，仅在你主动加载在线目录后联网，本地过滤，并把确认过的 npm 来源条目交给既有桌面包事务安装。仅 GitHub 或 tarball 来源的条目仍可浏览并给出仓库链接，但不能由该管理器安装。开发模式下包变更是只读的；目录网络失败既不会下载任何内容，也不会隐藏内置清单。

可选飞书通道仅在后端启动时产品的 `feishu.enabled` 开关为 on 才运行。[启用层](../desktop-host/src/feishu-gate.ts)将开关传入 `feishu-channel.enabled`，并保留已组合的凭证。关闭时该行仍保持挂载，使 Settings 能在启用前保存凭证；审核后的 provider 仅在启用后创建网关与会话节点。从旧内置桥接迁移时保留凭证值和备份，并关闭开关。保存或确认凭证、显式启用飞书，再重启后端。真实扫码注册、消息收发及租户权限仍未验证。

桥接的独立 `./remote` provider 为 Muse 账号访问提供私有出站桌面连接。账号认证与设备绑定选择该账号自己的 Host；本地 HTTP 转发与原生 `/api/remote.mux` WebSocket 帧保留应用既有路由。审核后的产物不启动局域网代理、公共 Cloudflare 隧道或上游独立服务端。复用模块与已测传输行为见[源码与兼容性审核](../../third_party/plugins/README.zh.md)。

产品加载随包短剧与 Muse 技能及自身 `$DSH_HOME/skills`，不扫描已有 DSH、`.agents` 或默认项目技能源；显式插件技能注册仍然可用。Windows 用户将自定义技能放在 `%USERPROFILE%\.muse\skills\<skill-name>\SKILL.md`；`MUSE_MED_HOME` 可指定其他产品 home。Host 在启动时创建 skills 目录。开发模式使用下文说明的独立 home。短剧、编辑、标准、PTC 和创造模式提供技能工具。短剧技能从 ASAR 解包，Host 向外部 Python 提供真实的 `app.asar.unpacked` 路径。 创造模式专属的组合编写技能也从 ASAR 解包，供该模式的文件系统技能提供方读取。Windows 启动将 `runtime/media/python` 和 `runtime/media/ffmpeg/bin` 放到子进程搜索路径前部。[媒体准备器](scripts/prepare-media-runtime.ts)在发布输出前检查锁定输入、依赖导入、编码、字幕烧录、草稿媒体探测及 Word 读写验证；复用时验证完整文件清单并重跑这些检查。构建机器上的验证不能替代无开发工具机器上的安装验证。安装器附带微软官方 VC++ 前置运行库，检查已装版本并在安装前请求授权；拒绝或失败会阻止成功完成和自动启动。再分发需要发行者具有适用的微软许可，不能仅依据运行库终端许可。

共享的 Muse 技能 `audio-transcribe`、`transcript-to-novel`、`transcript-to-script`、`novel-to-script`、`trope-adaptation`、`media-link-import` 和 `jubian-snatch` 可由短剧、编辑、标准、PTC 和创造模式通过技能工具加载；极简模式不提供技能加载器。编辑模式在剧本工作流程之外提供标准模式的全部工具，包括剧变剧本池和视频工具。仅有这些工具可用不会自动开始视频制作。`audio_transcribe` 在标准、PTC、创造、编辑和短剧预设中注册，极简模式不提供此工具。语音技能默认使用当前 MUSE 账号进行云端转写：FFmpeg 从获授权的本地媒体提取音轨，工具先将任务收据保存在 `transcript/jobs/`，完成后把带时间戳的 TXT、JSON 和 SRT 写入 `transcript/raw/`。独立离线 ASR 需要明确授权，并单独准备 Python 环境和模型。转写改编项目将来源链接及获授权复制或下载的媒体放在 `source/`，校订转写放在 `transcript/reviewed/`（剧本正文不显示来源时间码，原始转写与 QA 记录保留时间码供校对），来源和改编大纲放在 `outline/`，版本化产物放在 `draft/`、`final/`、`qa/`；已有资源库只读引用。`media-link-import` 将获授权、无需登录的公开 HTTPS 音视频直链经体积、时长和文件头检查后保存到 `source/media/`，同时保存来源授权记录；记录仍为 pending 时须先复核再转写。每次 TLS 连接都固定到已验证的公网 IP，项目路径中已有的符号链接或 junction 会被拒绝；其他进程主动并发替换目录不在保证范围内。它不解析抖音或微信分享页、不使用登录态，也不解密媒体流，这类页面使用对应的共享平台技能获取原件。Windows 随包提供媒体 Python；其他系统需可用的 Python 3.12+，macOS 安装包的该流程尚未实测。抢本技能检查可领剧本池，只对用户授权的单本或指定时段内的目标发起认领。编辑模式在写正文前提示阅读本次校订的来源剧本；这项阅读不作为阻止开写的检查。

[FFmpeg 源码构建流程](scripts/ffmpeg-source-build/README.zh.md)为离线发行生成二进制与对应源码配对。两个 CI job 均须通过后才能替换开发验证用的 FFmpeg 输入，对应源码归档必须与桌面版本一同发布；提交构建不等于产物通过验收。

签名资源中的 `resources/app.asar/dsh/desktop-runtime.json` 绑定内置 DSH 版本、内置 Node 版本、平台、架构、共享包版本和最终文件清单。启动读取元数据，并检查共享包记录。发布 schema、内置 DSH 版本、目标兼容性和文件完整性在打包时验证。首次启动不会把核心包复制到 profile 存储或通过 pnpm 安装核心包。

1. 主窗口在 profile 准备或后端启动前显示本地加载页。新 profile 创建清单和共享包链接，保留无关文件，然后启动一次实际后端。未变化的启动复用 profile，不扫描已安装插件的清单，但会先按第 2 条规则读取已存储的 bundle 列表。
2. 兼容的应用升级在当前 profile 中刷新共享链接，并检查已启用插件的 peer 要求。仅缺少本版本新增内置 bundle 的 `dsh.profile.bundles`，会在把 manifest 复制到同目录之后就地补齐；其他列表一律响亮失败且不被改动。每次启动都按此规则读取该列表，包括复用 profile 的那次：准备在记录运行时状态之后失败时，那份状态仍是最新的。插件文件、配置、版本和锁文件留在原处；不运行 pnpm。
3. 内置 Node 版本、平台或架构变化时，禁用脚本重新安装锁定的插件依赖图，验证并链接宿主包，然后运行已批准的待执行构建并再次验证。
4. 插件添加、更新和删除使用内置 pnpm 及 Desktop 独有的包管理器状态。保留的宿主包必须声明为 peer；共享包的嵌套副本和别名会被验证拒绝。普通插件依赖必须解析到 profile 内部。
5. 插件变更在直接修改当前 profile 前停止后端。准备成功后启动 Host。包操作或 Host 启动失败会保留已修改文件并报告错误。未完成的包操作保留标记，使下次启动重试锁定依赖的安装和待执行构建。Desktop 不创建 staging 目录、激活日志或回滚副本。

[Web 插件 UI](../../packages/client/ui-plugin-manager/README.zh.md)负责管理界面。Desktop profile 初始化和恢复保留已安装插件文件。

主窗口创建、主文档加载、preload、渲染器、Web 初始化或后端的致命失败，会在每个应用进程中打开一次原生恢复对话框。对话框显示首次错误末尾的限长摘要，标明截断情况，并提供四种恢复操作：退出；重启；禁用第三方插件、备份 profile patch 并重启；重置 Desktop 并重试。重置 Desktop 并重试执行与 `dsh-desktop:configuration-reset` shell 通道相同的 profile 重置：不经备份地删除 Desktop profile 配置与第三方插件，并由应用自带资源重建 profile，随后重启应用。启动失败保留 Web 加载页和动画；运行中失败保留当前页面。预期关闭、取消导航和普通请求错误不会触发恢复。共享 Web 插件管理器报告包操作错误；插件变更后的 Host 启动失败会进入原生恢复。不通过启动超时推断故障。 包含 `listen EADDRINUSE` 的监听失败以退出其他正在运行的 DSH 实例的提示替代诊断和重装建议，仅提供退出和重启。

原生弹窗详情最多包含 1,200 个 UTF-16 代码单元和八行诊断，若已写入下述崩溃报告则附上其路径。Host 错误诊断仅保留 stderr 输出的最后 64 Ki 个字符。更早的输出会被丢弃，避免长期运行的 Host 使壳的诊断缓冲区无限增长。

首个致命弹窗打开前，Electron 会向平台日志目录（`app.getPath('logs')`）写入一份崩溃报告，最多等待写入一秒；写入缓慢或失败时弹窗不带路径。文件 `crash-<UTC 时间>-<source>.log` 记录来源（`host` 为 Host 退出、`web-boot` 为渲染进程启动失败、`renderer` 为渲染进程或文档失败、`main` 为壳自身错误）、后端是否已就绪、应用与运行时版本、包含可枚举属性与 cause 链的错误（截至 256 KiB）、Host 在退出前通过 IPC 报告启动失败时自己的 inspect 错误（最多 64 KiB），以及主窗口最近的 error 级 console 输出（最多 64 KiB）。因此 Host 退出报告包含保留的 stderr 尾部，其中可能含有插件输出。关闭过程中的致命失败只写报告、不弹窗。平台支持时文件仅所有者可读；启动时保留最新十份报告并删除更早的，不触碰目录中的其他文件。

恢复操作等待 Host 关闭后才修改插件启用状态。原生恢复操作在 profile 事务锁内调用共享 app-boot 恢复函数。它禁用第三方 bundle，并将 profile 的 `cordis.patch.yml` 重命名为 `cordis.patch.yml.bak-<timestamp>`（重名时追加序号），无需解析；下次启动创建空 patch。已安装包和已有备份保留。home 级 patch 不变。Electron 控制台记录备份路径（或原文件不存在）以及 home 级 patch 未修改。profile 数据无效、重命名失败或写入失败会作为恢复操作错误报告；已完成的修改保留，Desktop 不会假装恢复成功后重启。Desktop 不提供 profile 重置操作或应急 HTML 文档。

## 开发

开发环境应用菜单提供“刷新页面”（macOS 为 Cmd+R，其他平台为 Ctrl+R）和“重启应用与 Host”。重启会等待 Host 关闭，再重新启动 Electron 和新的 Host；这两项操作都不会重新构建源码。

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，通过现有源码构建器构建五个固定的社区插件，再将其已校验 tarball、冻结的运行依赖及已构建的 CLI 包和私有 Desktop Host 包连同其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不下载安装包内的 Node.js，也不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发 Harness 状态默认写入 `apps/desktop/.desktop-build/development/home`，一次性 npm 项目位于 `apps/desktop/.desktop-build/development/project`，Electron 浏览器数据则位于 `apps/desktop/.desktop-build/development/electron-user-data`。因此，会话、设置、凭据、包链接和浏览器数据都不会进入用户正常使用的 Harness home；显式 `DSH_HOME` 只会替换开发 Harness home。Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

Web 侧的对应命令是 `pnpm run dev:web` 与 `pnpm run start:web`，见[开发指南](../../docs/development.zh.md)。Workspace 开发使用 Electron RunAsNode 运行当前 CLI 与私有 Desktop Host 包，插件管理和恢复使用 `$DSH_HOME/profiles/desktop`，与一次性工作区运行时分离。Host 在开发与打包构建中都使用 runtime 模块解析，不创建官方包的 fallback 链接；开发者安装的包（包括链接）保留原生优先级。需要验证 Electron RunAsNode、内置 pnpm、内置 dsh 资源、插件安装和修复时，应运行未封装安装器的应用目录。

[原生输入与渲染进程键盘测试](tests/keyboard.spec.ts)在[独立的 Client 测试项目](../../tsconfig.desktop-keyboard-tests.json)中编译，由仓库 Client 类型检查纳入。它只导入不依赖 Cordis 的 Desktop 输入、持久化、IPC、浏览器 guest 和蒙层模块。

### 启动引导

Muse 在 Host 就绪后打开工作区。空白首启时，Web 客户端先提供 MUSE 账号登录，再检查是否有可用的模型提供方。该账号会加载网页版模型目录，并用于模型调用、知识库和云端语音服务。桌面端不供应 Muse 官方 GPT 模型，自定义提供方和 Codex 仍可使用。产品预设默认值来自低于用户配置的 bundle 层，因此默认预设修改后会持久保存并在重启后生效。选择“稍后登录”或“稍后配置”后，仍可从侧栏进入对应设置。没有可用模型时，提示弹窗可直接打开模型设置；已有可用凭据则自动完成检查。

侧栏主账号入口打开 MUSE 账号设置。Muse 不显示 DeepSeek Platform 的账号与余额入口、旧插画首启弹窗或原生 DeepSeek 凭据欢迎窗。DeepSeek 退出登录或会话失效不会隐藏工作区。模型设置仍保留包括 DeepSeek 官方服务在内的提供方 API Key 配置。

主界面使用已保存的 `locale.preference`，否则取系统首个支持的语言，最后回退到英语；在设置中切换语言会更新桌面壳文案和菜单。`dsh://open` 仅将应用窗口置前，不传递凭据。

## 打包

<a id="release-versions"></a>

### 发布版本

每次 Desktop 打包前，第一步都要与当前用户确认完整版本号。检查所选部署环境、Muse 产品版本、内置 DSH 版本、保留的发布记录和已发布对象，再提出准确版本供用户确认。用户确认前不得启动打包；仅选择部署环境不代表用户已认可版本号。

从 `muse-product.json` 读取产品基础版本，单独记录内置 DSH 版本。production Desktop 使用产品的精确版本，包括其中的 `alpha`、`beta` 或 `rc` 标识。test 发布保留完整的预发布基础版本并追加 `.YYYYMMDD.index`；稳定基础版本则追加 `-test.YYYYMMDD.index`。上传校验要求完成记录中的产品构建和内置 DSH 版本都与当前来源相符。

| Muse 产品基础版本 | production Desktop | test Desktop 示例 |
|---|---|---|
| `1.0.0-alpha.1` | `1.0.0-alpha.1` | `1.0.0-alpha.1.20260930.1` |
| `1.0.0-beta.1` | `1.0.0-beta.1` | `1.0.0-beta.1.20260930.1` |
| `1.0.0-rc.1` | `1.0.0-rc.1` | `1.0.0-rc.1.20260930.1` |
| `1.0.0` | `1.0.0` | `1.0.0-test.20260930.1` |

日期使用实际创建时的 Asia/Shanghai 日期。每个基础版本、每天的序号从 1 开始，检查保留的发布记录与已发布对象后递增；绝不复用已发布版本。test 分发不发布对应的无后缀基础版本。

把确认后的版本通过 `--build-version` 传给打包命令，该值同时决定产物文件名、更新 feed 与上传校验。`muse-product.json` 保留产品基础版本，包清单保留 DSH 版本：

```sh
pnpm --dir apps/desktop run package:win:x64 --build-version 1.0.0-beta.1.20260930.1
```

`--build-version auto` 会给出当天的下一个序号：读取目标 bucket 中已发布的对象，未配置 bucket 或列举未能在期限内完成时回退到本目标的本地输出目录。上传前请确认它打印的版本号；run script 会自行透传 `--`，打包入口两种写法都接受。

production 发布使用产品版本本身，不传 `--build-version`。其上传成功后会把打包所用 commit 打成 `desktop-v<版本>` 标签；来自有改动工作区的构建不打标签，打标签失败也只打印手工命令，不会让已完成的上传变成失败。test 与本地构建有意不留标签，而所有产物的清单都记录 `dshBuildCommit` 与 `dshBuildDirty`，直接分发的构建同样可溯源。

打包后的 `app-update.yml` 记录产品版本派生的通道：Muse `1.0.0-beta.1` 使用 `beta.yml`，稳定版使用 `latest.yml`。COS 上传元数据使用相同的版本派生文件名，macOS 增加 `-mac`。SemVer 排序为 `1.0.0-beta.1 < 1.0.0-beta.1.20260930.1 < 1.0.0-beta.2`；主版本增加也让 Muse beta 高于 DSH `0.1.7-rc.8`。客户端保持自动降级关闭，只接受更高的元数据版本。纠正为较低版本时需要手动安装。

打包、上传以及手动 macOS 签名检查使用 `apps/desktop/.env.windows` 或 `.env.macos`，由目标平台选择。复制对应的 [Windows 模板](.env.windows.example) 或 [macOS 模板](.env.macos.example)，填写本机配置；Git 忽略这两个本地文件，安装产物也不包含它们。发布字段只从目标文件读取，不回退到系统或 shell 中的同名变量；`PATH`、代理和构建工具环境仍保留。发布版本是命令参数而非发布字段，上传从打包写下的完成记录中读取它。文件使用 UTF-8，支持 BOM；相对证书、SignTool、Apple API Key 和钥匙串路径以 `apps/desktop` 为基准，变量值不做 shell 展开，包含 `#` 或空格的密码需要引号。CI 同样在运行前生成目标文件。

每条打包命令在构建与下载前检查应用 ID、更新地址和该模式需要的签名配置，随后探测本次运行要用的外部工具：归档读取工具，以及 Windows 目标的安装器编译器。macOS 检查身份、Team ID、一套完整公证凭据、`CSC_LINK` 指定的可读本地 p12 文件、显式配置的 `CSC_KEY_PASSWORD`，以及引用的 API Key 和钥匙串文件；Windows 检查公开代码签名证书、SignTool 文件、容器名称和 PIN 格式。仅准备 Windows 资源或显式未签名打包不要求签名凭据。配置检查不验证 PIN 是否正确、Token 是否登录、钥匙串是否解锁或 Apple 是否接受凭据；实际签名与公证负责这些检查。`--build-version auto` 会访问目标 bucket，`--check` 下同样如此。单独运行相同检查：

```sh
pnpm --dir apps/desktop run check:package
```

无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、dsh 准备与 electron-builder 接收相同的平台和架构：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64。Linux 不是受支持的 Desktop 发布目标。

每个目标都在 `apps/desktop/.desktop-build/targets/<target>/` 下持有自己的打包输入、已准备运行时、包集合、dsh 依赖树、pnpm 准备状态、未打包应用、更新元数据和最终产物。Electron 归档缓存继续由 `.desktop-build/downloads` 共享，因为每个归档文件名都包含版本、平台和架构，并且在解包前经过验证。目标构建绝不读取其他目标的可变准备状态。

### 失败后从断点续跑

打包读取工作树，所以打出的字节必须能归因到某一个提交。`pnpm --dir apps/desktop exec tsx scripts/package-target.ts --list-steps` 会打印流水线的十三个步骤（S1–S13）以及每一步产出哪些路径；一次运行在 `git status --porcelain` 除 `.pi-glla/` 之外不为空时拒绝启动，在每一步之前重新读取 HEAD 并在其变化时停下，还会打印它复用的每个产物及其时间与 SHA-256 摘要。

被复用产物若早于 HEAD 的提交时间，会被拒绝而不是仅警告：在提交之前写出的 tarball 不可能包含该提交的修复，而把它打进安装包曾经发出过一个承诺了改动却并未携带该改动的安装器。拒绝信息会点名该产物、它的写入时间和提交时间。

失败可以从出错的那一步续跑，不必从 S1 重建。失败步骤的消息会点名该步骤，`--from <S#>` 从该步跑到结尾并复用更早步骤的产物，`--only <S#>` 只跑单独一步。续跑要求被跳过步骤的每个产物都存在且晚于 HEAD 的提交时间，因此无法证明这一点的运行会在开始前停下：

```sh
pnpm run package:desktop:win:x64:unsigned -- --from S7
pnpm run package:desktop:win:x64:unsigned -- --only S12
```

`release:pack` 步骤只重打发生变化的部分。每个成员的 tarball 都记录在它旁边的 `release-pack-<family>.json` 中，其中含有对 `pnpm pack` 读取的文件、包管理器，以及它依赖的每个同族包输入摘要一起算出的内容摘要，因此由新内容打出的依赖会使其消费方失效，即使消费方自己的文件没有移动。判定读取的是字节而不是时间戳；记录中的输入未覆盖其打包载荷的成员每次运行都会重打，而不会被复用。

### 运行时文件筛选

Desktop 在本地打包工作区包，并通过目标捆绑的 Node 和 pnpm 安装外部依赖。[Desktop 文件策略](scripts/runtime-file-policy.ts)随后在签名和完整性封装前过滤不可变的 `resources/app.asar/dsh/node_modules` 副本。它排除 `.gitkeep` 空目录标记、TypeScript 声明、已识别的 JavaScript/CSS/TypeScript source map、TypeScript 构建缓存、Domino 测试目录、选定的原生编译器输出和其他平台的 node-pty 预构建文件。它保留运行时 JavaScript、原生模块及其 DLL/EXE 辅助文件、WASM、未知资源、许可证和 notices。依赖清单在完整性封装前经过 electron-builder 的元数据清理，确保归档保持已记录的字节。该策略不修改 npm tarball、捆绑的包管理器或用户安装的插件文件。

[Office 转换提供方](../../packages/document/office-to-pdf/README.zh.md)携带目标已声明的原生引擎；kit 未声明匹配原生目标时携带 WASM 引擎。准备阶段在打包前拒绝缺少目标引擎的情况。完整 Office 依赖（CLI、JavaScript 库和选定引擎的可执行文件、数据、许可证及 notices）解包到 `resources/app.asar.unpacked/dsh/node_modules/` 下。Desktop Host 将引擎清单解析到这些物理目录，并向加载的技能提供独立 Node 和解包后 CLI 的绝对路径。Node 位于 `resources/runtime/primary-runtime/dependencies/node/bin/`；CLI 位于解包后的 `@deepseek-ai/libreoffice-kit/lib/cli.js`。macOS 上的原生辅助程序获得 [LibreOffice UNO 桥](https://github.com/LibreOffice/core/blob/master/sysui/desktop/macosx/hardened_runtime.xcent.in)所需的 JIT entitlement。

[Host 冒烟检查](scripts/smoke-runtime.ts) 在隔离 home 中启动，等待 credentials Service 就绪但不提供凭据，并先挂载完整产品预设再转换输入，因此同时检查该预设的工具和随包技能。准备阶段必须读到 Agent 释放后的完成记录，不能仅凭 Host 就绪判定成功；启动 60 秒后仍未就绪即失败。运行时根清单提供预设发现所用的完整 CLI、Desktop Host 和源码插件依赖图。

打包应用运行编译后的 JavaScript 和预生成的 Typert 元数据，不编译 TypeScript 插件。源码级调试导航和编辑器声明仍可从开发包中获取。[复制规则测试](tests/runtime-file-policy.spec.ts)覆盖排除项和保留资源；[产物 smoke](tests/fixtures/runtime-payload-smoke.mjs) 在 Host smoke 和最终清单验证之前，使用内置 Node 执行。产物 smoke 解析搜索工具使用的 ripgrep 可执行文件，并验证文本搜索和文件枚举。Windows 签名构建在依赖签名后运行这些检查；其他构建在 `prepare:dsh` 中运行。 发布清单前，[Codex 检查](scripts/verify-codex-runtime.ts)要求源码固定的 provider、CLI 及声明的目标平台包全部位于产物内部，再使用内置 Node 在隔离主目录中执行 `--version`。可选下载缺失或可执行文件版本不符都会使准备失败。冻结的生产安装阶段为 pnpm 的完整 tarball 响应体设置有界的 30 分钟 `fetch-timeout`。锁文件元数据解析保留 pnpm 的默认截止时间和重试。构建者可将 `DSH_DESKTOP_FETCH_TIMEOUT_MS` 设为不超过 2,147,483,647 的正整数毫秒数；其他继承的 npm 配置仍被排除。[Host smoke](scripts/smoke-runtime.ts) 使用捆绑的 Python 创建 DOCX、XLSX 和 PPTX 输入，通过真实 Office 提供方逐一转换并检查 PDF 输出。每个组装后的应用（包括目录包和 Windows 未签名构建）都会针对 ASAR 重复产物和 Host 检查。归档完整性检查将归档内完整描述符与准备结果比对，并核对归档和解包目录中的文件内容与清单、归档内文件记录的执行标志，以及解包文件的物理权限。转换失败会在写入发布记录前终止打包；macOS DMG/ZIP 构建在公证前执行这些检查。

Windows 发布验收还需在 Desktop 构建后手动运行[目录和替换检查](scripts/smoke-windows.ps1)。将 `$Makensis`、`$SevenZip` 和 `$PluginDir` 分别设为锁定版本构建器的 NSIS 编译器、7-Zip 可执行文件和 x86-unicode NSIS 插件目录；通过 `-FrameLibrary` 传入已准备好的 `window-frame.dll`，即可同时覆盖原生解压路径及其失败报告。从仓库根目录运行以下命令。它验证 目录替换与回滚和两种文件占用替换方式；不属于单元测试通道。

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir -FrameLibrary apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll
```

Windows 安装器在启动时和选定目标目录后检查应用是否正在运行，通过检查后才将新版本解压到安装目录旁边。通过同卷目录改名替换前，安装器会再次检查。运行中的应用会阻止安装；更新启动允许等待应用退出，最长十秒。同路径升级在替换成功前保留旧目录；解压失败时旧版不变，替换失败时尝试恢复旧目录。安装器在启动前清理旧版备份。强制结束安装器或断电可能留下 `.new-*` 或 `.old-*` 目录；不同安装位置或安装范围迁移仍使用 electron-builder 的旧卸载器流程。

解压失败时，安装器会把 7-Zip 的结果和完整错误输出写入更新缓存目录 `%LOCALAPPDATA%\<按包名派生>-updater\installer-logs\extract-failure-<时间戳>.log`（当前为 `@deepseek-aidsh-desktop-updater`），并在弹窗中显示首条错误行和 **复制错误信息** 按钮；静默安装只写入报告。未签名的 Windows 构建（`DSH_DESKTOP_UNSIGNED=1`）将 `muse-med-<版本>-win-x64.exe` 写入该 target 的 `unsigned-artifacts/` 目录而非发布目录，因此未签名构建不会被误当作发布产物。

<a id="upload-updates"></a>

### 上传更新

打包会为所有目标记录 GitHub Releases 更新源（含未签名构建），因此打包不需要更新 origin。`DSH_DESKTOP_AUTO_UPDATE_ENV` 为签名目标的完成记录与后续 COS 上传选择 `test` 或 `production`；未设置时使用 `test`。签名目标打包必须通过 `DOWNLOAD_TEST_ORIGIN` 提供测试环境的 HTTPS origin，生产 origin 仍为 `https://download.deepseek.com`。上传还必须通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供所选环境的 COS bucket。目标路径为 `_/harness/desktop/stable/<target>/`，其中 `target` 为 `mac-arm64`、`mac-x64` 或 `win-x64`。

更新目标与上传凭据都与所选环境对应：

| 环境 | 公开 origin | COS bucket | COS 凭据 |
|---|---|---|---|
| `test` 或未设置 | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`、`DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`、`DOWNLOAD_PROD_COS_SECRET_KEY` |

每个测试发布批次用下方命令生成新 ID，将输出填入 `.env.macos` 或 `.env.windows` 的 `DOWNLOAD_TEST_RELEASE_ID`。这两个被 Git 忽略的平台文件管理该值，shell 变量不能覆盖它，dotenv 值也不会进行 shell 展开。打包、上传和重试必须沿用同一个 ID；上传会拒绝更新 URL 不一致的完成记录。需要验证跨版本升级时，后续版本沿用已安装客户端的 ID。生产环境不使用该字段。

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(16).toString('hex'))"
```

通过完整下载链接分发每个测试批次。已安装的测试客户端保留当前批次的清单地址，不会自动发现新 ID。格式校验无法判断随机性，请使用生成器的输出。随机路径降低被猜中的概率，不限制持有链接者访问；撤下批次需要删除其 COS 对象并清除对应 CDN 目录缓存。

在目标 `.env` 中配置更新地址与所选 COS bucket、SecretId、SecretKey，再打包并上传同一个目标：

```sh
pnpm run package:desktop:mac:arm64
pnpm run upload:mac:arm64
```

内测打包在目标 `.env` 中显式设置 `DSH_DESKTOP_AUTO_UPDATE_ENV=test` 和 `DOWNLOAD_TEST_ORIGIN=https://download-test.deepseek.com`；上传使用 `DOWNLOAD_TEST_COS_BUCKET=bj-toc-download-test-1320056602` 及独立测试凭据。test 和 production 都使用固定 Nightly 通道，部署选择不提供通道切换。

早期内测包使用 `test` 部署。仅为生产发布显式选择 `production`；更换上传凭据不会改变已有包的目标部署。打包不需要 COS 凭据，禁用 electron-builder 发布，并从子进程环境中剔除 COS 凭据；只有签名和公证成功后才写入完成记录。上传在读取凭据前校验该记录、部署、目标、共享版本、文件名、大小与 SHA-512。安装包与 blockmap 先于 YAML 上传；历史对象保留。每个 release 只发布一个通道文件，即其版本派生出的那个：nightly 版本为 `nightly.yml` 或 `nightly-mac.yml`，稳定版为 `latest.yml` 或 `latest-mac.yml`。发布的 YAML 使用绝对二进制 URL。上传器不设置 Cache-Control，包括 COS SDK 本会添加的空头：缓存策略归部署基础设施所有，feed 不缓存，二进制缓存可单独配置。按目标串行发布，并在发布资格确认前验证公开产物与 feed 内容。

打包后的更新器使用 `https://github.com/felir7at62co-wq/muse-med` 上的 GitHub Releases。每个已发布 release 都需要语义化版本 tag、安装包、blockmap 和通道 YAML；provider 的 feed 不包含 draft release。`verify:update-feed` 使用真实 provider 校验安装包哈希和元数据资产。COS 上传器记录另一份必需的 GitHub 发布计划，但不会发布 GitHub release。

`muse-product.json` 为 Muse beta 发布显式启用 `legacyRcDiscovery`。已安装的 `0.1.7-rc.7` 和 `0.1.7-rc.8` GitHub 客户端只选择 rc tag，因此发布计划要求两个入口：`v1.0.0-beta.1` 和仅用于发现的 `v1.0.0-rc.muse-beta.1`。两者包含完全相同的真实 Muse beta 二进制，以及版本仍为 `1.0.0-beta.1` 的 `beta.yml`、`rc.yml` 和 `latest.yml` 元数据；macOS 使用相应的 `-mac` 名称。COS 计划包含相同的 feed 别名。Provider 回放已验证发现和版本接受；实际发布两个 release、检查线上资产以及升级已安装的签名应用，仍需要发布验证。单独发布 beta 无法让旧 rc 客户端更新。

macOS 配置使用必填发布环境，不会接受钥匙串中最先发现的证书。空值、格式错误的 Team ID、包含 electron-builder 不支持的 `Developer ID Application:` 前缀的签名身份，以及不完整的公证凭据都会被拒绝。macOS 打包要求已配置的身份及其私钥可用。运行时准备会把该身份、安全时间戳与 hardened runtime 应用到每个内嵌 Mach-O 文件；应用签名完成后，深度严格检查会拒绝其他叶证书 Authority 或 Team ID，验证通过才生成发布产物。macOS 固定目标安装包命令为已签名应用创建独立副本，并发执行两条产物流。一路先公证 App 并钉票，再生成 ZIP 及其更新元数据。另一路把已签名 App 副本封装进签名 DMG，再公证 DMG、钉票并验证；其中的 App 不单独附加票据。只有两路均成功结束，产物才会移入最终目录并写入发布完成记录。仅生成目录的命令同样需要公证凭据，并等待 Apple 公证和 App 钉票完成。[并行公证决策](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md)负责副本隔离与容器票据语义。私钥可以来自登录钥匙串或 electron-builder 的标准 `CSC_LINK` 输入；环境中的 `CSC_NAME` 与证书发现顺序都不能选择发布所有者。公证凭据也可以使用 electron-builder 支持的完整 Apple ID 或钥匙串 profile 方式。手动执行 `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>` 重复应用检查时，也必须提供两个 macOS 身份变量。

macOS 签名遍历真实文件，不跟随 Framework 的软链接别名。PAK 资源保留全部随附语言，由外层 Framework 或应用签名记录完整性，不逐个签名。[发布策略](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责依赖补丁和验证要求。

macOS 运行时准备将已验证的单架构 Mach-O 签名缓存在 `.desktop-build/targets/<target>/signature-cache`。缓存键包含输入字节与权限、签名探针实际使用的叶证书、签名标识、entitlement 字节、macOS 版本，以及签名工具与策略。复用不取决于 Git 提交：未提交的字节变更会使对应文件失效。每次命中都验证缓存字节、严格签名、证书、标识、entitlements、安全时间戳和 hardened runtime，再替换未被并发修改的输入。通用二进制每次重新签名。运行时完整性与 smoke 检查、App 签名和 Apple 公证仍会执行。缓存要求受信任的本地构建存储。缓存损坏或不安全链接会令构建失败；停止打包后删除对应缓存目录再重试。成功的签名阶段会将完整缓存条目的内容总量裁剪至一 GiB；中断留下的临时条目需手动清理。并发淘汰可能使读取方安全失败。日志记录命中、未命中及未缓存数量。

Mac 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `apps/desktop/.desktop-build/packaging-runs/` 下的唯一目录。读取本地配置后，每次运行保留 `run.json`（发布版本、产品版本、Git 提交、工作区是否有改动、目标及 Node 版本）、`events.jsonl`（带时间戳的阶段、耗时、并行输出归属及代理恢复状态）、脱敏后的子进程 `stdout.log` / `stderr.log`，以及 `result.json`（整体结果、阶段结果和产物目录）。事件还记录打包并发数及各代理是否配置。失败和后续打包不会清除日志；没有自动删除流程。缺少 `result.json` 表示完成状态未经确认。已知凭据值会被遮盖；不记录环境变量全集或 notarytool 认证参数。运行时准备分别记录包暂存、安装、依赖树复制、签名、清单生成、smoke 检查、描述文件校验和清理。嵌套阶段的耗时存在重叠，不能直接相加。

App 和 DMG 公证分别记录 submission ID，以及独立的 `notarytool:upload:*` 和 `notarytool:wait:*` 耗时。上传使用 `submit --no-wait`，包含认证、本地校验、传输和服务端受理，并非纯传输时间。等待从该命令返回后开始，包含轮询及剩余的 Apple 处理时间；Apple 可能在上传提交命令返回前已开始处理。日志保留 Apple 状态与诊断信息，包括拒绝结果；签名检查、接受状态校验和 stapling 仍由 `@electron/notarize` 负责。仅生成目录的打包命令也使用同一条可计时的 App 公证路径。各子进程输出仍实时显示在终端，阶段失败及嵌套错误保留在事件日志中。两个平台均记录父进程打包失败，并在终端显示脱敏诊断，包括代理恢复操作指引。仅检查配置的 `check:package` 命令不创建运行日志。

Mac 打包从 `.env.macos` 读取三个调优字段：

| 设置 | 默认值 | 作用范围 |
|---|---|---|
| `DSH_DESKTOP_MACOS_PACK_CONCURRENCY` | `4` | 第一方与 vendor workspace tarball 的打包 worker 数；必须是正整数。 |
| `DSH_DESKTOP_MACOS_DOWNLOAD_PROXY` | 空 | Electron、运行时资源、pnpm 安装及 builder 下载使用的 HTTP/HTTPS 代理 origin。 |
| `DSH_DESKTOP_MACOS_NOTARIZATION_PROXY` | 空 | 通过临时系统代理设置供 Apple 工具使用的 HTTP 代理 origin。 |

两个代理字段互相独立，拒绝 URL 中的凭证、路径、查询参数和片段。空值沿用继承的网络设置。显式下载代理会替换子进程的代理变量，仅绕过本地主机；它不修改系统设置。Windows 与独立 `release:pack` 保持现有并发默认值。公司代理地址仅写入 Git 忽略的本地文件；具体地址参见内部文档。

Apple 工具使用 macOS 当前活动网络服务的 HTTP/HTTPS 代理。配置公证代理后，打包会检查代理可达性、保存该服务的设置，在两条产物任务期间启用代理，并在两条任务均结束后恢复原设置。对于原本关闭、服务器为空且端口为零的代理，恢复时仅关闭代理；临时服务器和端口可能保留，但不生效。仅生成目录的打包会在签名目录构建完成后的 App 公证期间启用代理。这会临时影响其他应用，并要求修改系统代理的权限；必须先禁用 PAC、自动发现、SOCKS 及需要认证的代理配置。打包和恢复在读取恢复记录或修改代理前获取同一个用户级 POSIX 文件锁；进程退出会释放锁的持有权，锁文件保留。该锁在首次使用时才加载 `@deepseek-ai/node-addon-system/flock`，而不是在脚本启动时加载，因此 `check:package` 和打包入口在未构建 `native/system` 的 checkout 上也能加载；加锁时若宿主 addon 二进制或入口的 JavaScript 缺失，加载器会先运行 `pnpm run build:native-system` 和 `pnpm --dir native/system run build:ts` 再加锁，因此恢复命令在这样的 checkout 上同样可用。这会阻止不同 checkout 的代理事务重叠；其他用户及网络设置工具不得同时修改这些设置。SIGINT/SIGTERM 会等待活动任务结束后恢复。强制终止或恢复失败后，先停止残留公证进程，再运行 `pnpm --dir apps/desktop run restore:mac-proxy`；保存的记录会保留到恢复成功。配置检查仅验证 URL 语法，不修改系统设置或连接代理。

### 未签名 Windows 测试安装包

muse-med 使用自己的 GitHub Releases 更新源，不接入 DSH 的强制更新服务。在 `.env.windows` 设置 `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG=false`，明确省略策略元数据并关闭策略请求；更新检查、下载和安装仍然启用。未作此显式选择时，缺失或无效的策略配置仍会使打包失败。

Windows 安装器支持英语和简体中文，默认使用专属的 `muse-med` 安装目录；不要直接安装到盘根目录。在 Windows x64 上，使用完整的未签名打包命令进行本地安装测试：

```sh
pnpm run package:desktop:win:x64:unsigned
```

该命令要求设置 `DSH_DESKTOP_APP_ID` 并具备常规构建依赖，包括编译原生模块所需的 Python 和 Visual C++ 构建工具。Python 不在 `PATH` 中时，将 `PYTHON` 设置为其可执行文件路径。命令将安装包写入 `.desktop-build/targets/win-x64/unsigned-artifacts/`，记录 GitHub Releases 更新源且不含 publisher name，清除签名凭据，且不生成发布完成记录。它不需要 EV 凭据或更新源地址。签名打包和上传命令仍遵循正式发布要求。

### Windows 安装界面

Windows 安装器将视频资源保留在主压缩载荷中。独立的预压缩文件收集已禁用，因为该遍历会跳过 `node_modules`，包括 `ending_effect.mp4` 等解包技能资源。

Windows 安装程序使用原生 NSIS 页面，提供亮暗配色、系统阴影、可编辑的安装目录，以及默认勾选立即启动的完成页。安装仅面向当前用户。点击安装或按 Enter 均校验当前路径；新安装位置必须为空，非空位置必须是已登记的安装目录。受影响安装路径中的程序运行时显示系统提示，并保持应用运行；其他目录中的同名应用不阻止安装。静默更新最多等待受影响应用退出十秒，若仍在运行则以退出码 2 结束。

主题在启动时跟随 Windows；可用 `/THEME=light`、`/THEME=dark` 和 `/THEME=auto` 显式选择配色。窗口在品牌控件准备完成后显示。欢迎页首次出现时，安装窗口会一次性移到普通窗口前方；若焦点在其他窗口，任务栏按钮会闪烁提示，但安装窗口不会始终置顶。进度读取锁定版本的 7-Zip 解压器百分比；目录替换、注册和清理仍使用有界估算。加权百分比不代表剩余时间。NSIS 报告成功后，进度条用 600 毫秒补满并短暂显示 100%，再显示完成页；切换目标时长为 750 毫秒。完成页保留窗口位置。点击完成后，安装程序先隐藏窗口，再启动已安装的可执行文件；启动失败会恢复页面以供重试。目录替换和失败恢复遵循上文描述的安装流程。首次启动的配置档案准备仍属于独立的 Desktop 操作。

Windows 打包使用 Visual C++ Build Tools 和 Windows SDK 编译 x86 Win32/GDI+ 辅助库；签名构建通过已配置的 Windows 签名器对该库签名。准备钩子在所有平台上均由 electron-builder 继续负责收集生产依赖。[安装界面决策](../../.agents/notes/implemented/architecture/2026-09-10-windows-native-installer-pages.zh.md)记录 NSIS 接入方式和发布验证要求。

在有交互式桌面的 Windows x64 上，从仓库根目录运行 `pnpm --dir apps/desktop run test:installer`，可将小型原生测试载荷接入正式安装配置并执行验证。每次运行使用独立产品身份，依次验证仅英文和仅中文的安装器变体，并根据实际显示的欢迎页按钮选择测试文案。两个变体均安装到私有目录并在测试后卸载；截图和结果保留在 `.desktop-build/installer-tests/` 下。检查包含末尾带分隔符的已登记路径升级，以及磁盘根目录拒绝。可选的 `--signed` 标志使用下文的 Windows EV 配置，在嵌入前对测试程序和辅助库签名；它不会启用更新源。

Windows 卸载程序会随应用一起删除 Electron 用户数据目录（`%APPDATA%` 下按包作用域嵌套的浏览器存储与缓存）、`%APPDATA%` 下的产品目录，以及 `%LOCALAPPDATA%` 下的更新下载缓存，随后移除 `%APPDATA%` 之下普通且已空的作用域目录。Harness 主目录（`~/.dsh` 或 `DSH_HOME`：会话、设置、凭据、插件）不会被触碰；以 Windows 环境变量发布的 `DSH_HOME` 还会保护所有与其重叠的目标。静默卸载删除相同的数据；以 `--updated` 或 `/KEEP_APP_DATA` 启动的卸载程序保留数据，electron-builder 在原地更新和从其他目录替换旧安装时正是这样启动它。删除通过原生辅助程序执行：它拒绝受保护的 Windows 目录以及与安装目录或主目录重叠的路径，要求固定的本地驱动器，链接的根目录或祖先目录原样保留，遇到重解析点只解除链接而不进入目标，清除只读属性，并在遇到被占用文件后继续删除其余兄弟项；残余不会中止卸载，也不会提示。安装时在 Windows 卸载注册项上记录 `InstallLocation` 作为标准的清单元数据；在 Windows 11 上，开始菜单右键菜单中的“卸载”对所有 Win32 应用都会打开已安装应用列表，只有 MSIX 包能从那里直接卸载。卸载程序声明 DPI 感知，中文使用微软雅黑 UI。此行为仅适用于 Windows。

使用 `node apps/desktop/scripts/test-windows-installer.mjs --uninstall-only --compile-only` 以每次运行唯一的带作用域包名编译独立的中英文夹具。省略 `--compile-only` 可对预置数据运行原生删除器回归，以及交互、静默、`--updated`、`/KEEP_APP_DATA` 和 `DSH_HOME` 位于 Electron 数据内的检查。编译本身不能证明已安装卸载行为。

### Windows EV 签名

运行时签名在当前 Windows 账户的各 worktree 间共享完整的已签名文件。`.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR` 指定固定本地磁盘上的绝对目录；默认值为 `%USERPROFILE%\.dsh-desktop-signing\signature-cache\v1`。缓存目录必须属于当前账户，访问权限不得向其他普通账户开放；带链接的路径会被拒绝。缓存项标识原始字节、公钥证书和签名工具链。每次恢复都检查摘要、Windows 信任状态、时间戳和证书，再替换未签名文件；缓存项无效会停止打包，不回退到硬件签名。不会仅因缓存较旧而重新签名。缓存信任同账户运行的程序，不防御管理员。[运行时签名缓存决策](../../.agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.zh.md)定义验收要求和设计限制。

预检、主要运行时签名、应用运行时签名和产物生成分别持有账户级签名阶段锁，直到受监督的子进程结束。其他构建进入这些阶段前等待；编译和准备步骤不持锁。运行时签名进程自行持锁，因此仅终止外层打包进程不会释放仍在访问缓存的阶段锁。迁移及维护获取同一把锁；旧版或外部签名命令不参与排队，应另行避免并发。阶段等待不计入预检期限。关闭阶段句柄会释放普通竞争锁，不删除独立的硬件尝试互锁；遗留硬件失败仍需操作人员恢复。

缓存命中的复制、摘要和逐文件信任检查使用 `.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY` 个工作任务（默认 `4`，整数 `1`–`8`）。所有恢复及后置验签完成后，未命中项才进入串行硬件签名。恢复或验签失败会停止派发新任务，并在释放阶段锁前等待在途工作结束；硬件签名、运行时 smoke 检查和最终完整性校验仍须执行。

每个运行时阶段向标准输出及打包日志写入 `SIGNATURE_CACHE_SUMMARY`，包含实际目录、策略标识、命中及未命中数、新发布及保留项数、签名请求数、省去的签名请求数和验证失败数。计时区分签名、恢复文件和新签名文件的信任验证及恢复；恢复耗时包含其信任检查和暂存清理。这些统计不包含预检、最终产物签名及外层运行时验签。阶段锁事件单独记录等待时间。 并发计时累加逐文件工作耗时，不代表阶段墙钟时间。

使用 `pnpm --dir apps/desktop run cache:windows-signatures --usage` 查看结构完整的缓存项字节数和数量，或用 `--from <absolute-old-cache>` 导入显式指定、属于同账户的旧缓存。迁移不修改源目录，跳过暂存名称，拒绝损坏项，并保留已有有效项，即使它们的时间戳字节不同。`--clear` 在阶段锁保护下显式删除完整缓存项；不执行自动容量淘汰。`--directory <absolute-cache>` 指定维护目标目录，无需加载发布凭据。不完整暂存项保持原状并单独计数；仅在所有构建停止后检查它们。这些命令绝不清除硬件失败证据。默认存储位于 AppData 之外，避免 MSIX 启动器虚拟化将账户缓存拆开；被重定向的覆盖目录会明确失败。

Windows 签名构建在编译或准备依赖前执行受监督的签名预检。静态配置、证书有效期、审计存储、编译器可用性及遗留签名锁的检查不访问 Token。本地 .NET Framework C# 编译器生成一个专用小探针，由正式签名器仅签名一次，随后必须验出配置的证书和时间戳才能继续构建。探针绝不执行。预检的整体 60 秒期限包含时间戳尝试；超时、硬件签名报错或验签失败都会停止本轮流程，不再次调用硬件。成功只证明当前签名路径可用，不证明 PIN 已独立认证：SafeNet 可能复用登录状态。不要为了验证 PIN 而注销或重复认证。`--check`、仅准备和 `--unsigned` 模式不执行此硬件预检；未签名产物仍不能发布上传。自动回归测试使用假签名器，真实硬件由发布操作人员单独验收。

Windows NSIS 上传要求安装包旁存在生成的非空 `.exe.blockmap`。blockmap 先于通道 YAML 上传；NSIS 安装包元数据不要求另一种 web-installer 格式使用的内嵌 `blockMapSize`。文件清单测试使用固定版本构建器的 blockmap 生成器，而不是手工编造内嵌映射字段。

签名 Windows 配置从同一份公开证书的 `CN`、`O` 和 `C` 属性生成 updater 的 `publisherName`。每个属性都必须存在、非空且只有一个值。这些身份属性允许证书续期，无需固定叶证书指纹。已安装应用的 `app-update.yml` 保存预期发布者，下载的清单不能选择该身份。未签名测试构建省略 updater 配置。真实文件验证及其限制见[签名验收记录](tests/README.zh.md)。

本项目使用的 SafeNet Token 出现 `SignTool Error: No private key is available.` 时，说明 PIN（密码）错误。立即停止所有签名尝试，等待用户处理 PIN 后再继续。PIN 输错达到五次会锁定 Token。遇到该错误后，不得重试打包或签名探针。签名器串行执行 Token 操作，首次失败后拒绝所有排队任务。

Windows 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `.desktop-build/packaging-runs/` 下的唯一目录。每次运行保留 `run.json`、带时间戳的 `events.jsonl`、脱敏后的 `stdout.log` 和 `stderr.log`，以及 `result.json`。签名失败还会写入 `fatal.json` 并通过 stderr 通知父进程；监督程序立即请求终止当前阶段的进程树并等待退出。失败阶段不能启动后续阶段或生成发布完成记录。日志写入失败也会停止运行。终止错误仍按失败处理，需要操作者检查；缺少最终记录表示尚未确认完成。

硬件签名必须属于受监督的打包运行。调用命令解释器前，签名器原子获取 `%USERPROFILE%/.dsh-desktop-signing/attempt.json` 并记录本次尝试。只有签名成功且配置证书的主签名通过验证后才释放该文件；随后完成时间戳，不再访问硬件。失败、中断、已有锁定文件或审计存储不可用都会阻止再次访问硬件，包括同一 Windows 账户下的另一个签名器实例、进程或代码检出目录。没有定时恢复或自动重试。管理员必须检查保留的证据及令牌状态，再明确授权恢复锁定状态；登录令牌或替换 PIN 文件不会清除它。记录区分签名意图、命令解释器 PID 和完成结果，不计量 CSP／令牌内部的认证次数。不记录命令参数、PIN 或凭据环境。其他 Windows 账户及无关签名程序不在此锁定机制的保护范围内。

Windows 打包将 7-Zip 过滤器固定为 `BCJ`，以兼容内置的 NSIS 解码器。这样可以保留 x64 安装包中由依赖携带的 ARM64 二进制文件；自动 ARM64 过滤会生成该解码器无法解压的条目。

NSIS 在安装阶段清理临时解压目录，完成后才显示完成页或自动启动应用。已安装的生产依赖保持为普通文件；启动时不会再次解压。安装仍会写入完整的应用目录树。

在 `.env.windows` 中填写 `DSH_DESKTOP_WINDOWS_CER_FILE`（公开 EV 叶证书）、`DSH_DESKTOP_WINDOWS_SIGNTOOL`（SafeNet 兼容的 SignTool）、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`（匹配的私钥容器）和 `DSH_DESKTOP_WINDOWS_TOKEN_PIN`（Token Password）。私钥仍保留在 USB Token；不要把证书或本地凭据文件提交到 Git。

```sh
pnpm run package:desktop:win:x64
```

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`和 SHA-256 文件摘要，不请求时间戳。随后钩子在隔离副本上完成 DigiCert SHA-256 RFC 3161 时间戳，不传递签名凭据。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

时间戳处理仅对正常退出但返回失败或警告的时间戳命令重试，最多尝试三次，间隔为一秒和两秒。每次均从同一份已验证的主签名开始。启动错误、终止状态不确定或验签失败会立即停止。SignTool 使用短的私有路径；发布时先把已验证字节复制到目标卷，再原子替换。最终必须通过 Windows 信任、证书、时间戳和规范化全文件相等检查。尝试耗尽后停止打包并保留证据，不再次调用硬件。参见[签名完成决策](../../.agents/notes/implemented/process/2026-09-17-windows-signature-completion.zh.md)。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向签名预检、独立的第一方运行时签名阶段与 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。本地 `.env.windows` 明文保存 PIN，应限制文件访问权限；CI 使用临时文件并在任务结束后删除。不要提交或分享文件内容，也不要把凭据写入日志。配置检查不会消耗 Token 的 PIN 尝试次数；签名仍在首次失败后停止整批任务。

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成正式构建与准备，避免使用陈旧的 dsh 包、运行时文件或 dsh 内容。

每条打包命令都会构建仓库，打包以 dsh 和私有 Desktop Host 为根的第一方生产依赖闭包，并准备目标专用的 Electron 分发包与 pnpm CLI。`prepare:dsh` 在构建时安装一次生产依赖图，准备物化包供 electron-builder 归档到 `app.asar/dsh`，移除包管理器元数据，并生成包含共享包版本和最终文件哈希的 `desktop-runtime.json`。在 macOS 上，它先签名并验证原生文件，再生成清单；electron-builder 不对已签名的此目录重复进行嵌套签名。资源映射明确包含默认根目录过滤器会忽略的 `dsh/node_modules`；准备完成的运行时清单在原生签名后检查。原生可执行文件及库解包到 ASAR 旁；Python、独立 Node 和 pnpm 保留在外部 runtime 资源中。Windows 打包逐项检查准备好的 PE，确认其 ASAR 条目已标记为解包，且磁盘副本字节一致；未签名构建也执行此检查。Builder glob 规则用单字符通配符匹配 PE 文件名中的花括号，因此同目录中名称匹配的文件也可能被解包。准备好的运行时 smoke 沿用已验证的目标描述符，不使用构建宿主的架构。普通 Node 校验 ASAR 原始字节；归档内的 Host smoke 在打包后的 Electron 可执行文件下运行，以支持对 ASAR 内 profile 的验证。签名安装包、公证、已安装应用升级和各目标原生模块的验收需要发布环境。

macOS 打包在组装 App 时、代码签名前写入 `Contents/Resources/app-update.yml`，供并行 ZIP 与 DMG 路线使用的目录构建也执行此操作。签名钩子验证准确的更新源和 updater 缓存目录。写入发布完成记录前，流程会再次检查两条路线的副本和最终移入的 App；配置缺失或不匹配会阻止移入产物，因而也会阻止上传。

未压缩产物包含 Electron、物化后的 dsh 生产依赖树、pnpm，以及壳应用。安装包大小与文件系统占用不同；发布验收需要测量两者，以及 profile 插件存储和首次启动耗时。此布局用更多应用内文件换取消除用户机器上的核心包安装过程。

## 更新

打包应用会在主窗口打开十秒后检查目标专用的发布流；本地化的 **检查更新…** 菜单项会手动触发同一检查。发现可用版本时，应用打开一个原生确认弹窗。用户确认后，应用等待正在进行的检查完成，下载 Desktop 安装包，在包内记录了 publisher name 时校验其 Authenticode 签名，停止 dsh 子进程，并把安装与重启交给 electron-updater。下次启动在显示本地加载页的同时校准版本绑定的运行时。

打包会把 GitHub Releases 更新源写入包内的 `app-update.yml`：`provider: github` 加本产品的 owner、仓库与更新频道。只有该文件存在时更新器才会检查更新，因此现在所有目标都会检查，未签名的 Windows 构建也一样。未签名的包不记录 `publisherName`，electron-updater 随后会接受下载到的安装包而不校验 Authenticode 签名；频道元数据里的 SHA-512 仍能拒绝损坏的下载，但没有任何环节确认发布者是谁。`upload:*` 命令仍为 `DSH_DESKTOP_AUTO_UPDATE_ENV` 选择的部署写入频道元数据。当频道元数据带有 `blockMapSize` 时，NSIS 差分包与 macOS ZIP 目标让 electron-updater 可以复用未变化的数据块；这里构建的 NSIS 辅助安装包把 block map 写到 `.exe.blockmap` 侧车文件，该模式不返回 `blockMapSize`，因此客户端会完整下载安装包而不用差分补丁。供手动安装的 DMG 经过公证，但不生成 blockmap，因为它不是 macOS updater 的载荷。运行时与桌面壳仍属于同一个签名 Desktop 发布。macOS 签名与公证凭据使用 electron-builder 的标准环境变量；Windows EV 签名使用上文所述的公开证书、已验证 SignTool、SafeNet 容器和 runner PIN。必填 Desktop 发布环境选择构建所验证的应用身份与平台签名身份。

## 底层开发覆盖项

未打包的 Electron 进程使用应用目录下的 `.desktop-build/development/project` 作为开发项目。`DSH_DESKTOP_PNPM_ENTRY` 和 `DSH_DESKTOP_DSH_DIR` 是带应用路径默认值的可选覆盖项。每次未打包启动都必须设置 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`：开发启动器（`dev:desktop`、`start:desktop` 及工作区更新验证运行器）会把它设置为自己已准备目标的 primary-runtime 目录；缺少该变量的启动会以致命启动对话框失败。启动器必须设置它，因为壳无法从 `process.arch` 推导该目录：构建目标将 Windows 固定为 x64，而宿主可能是 arm64。打包应用会忽略这些变量，从 `process.resourcesPath` 解析签名资源，并使用受管 Desktop profile。

## 已知限制

- MUSE 知识库和云端语音依赖已启用的网关接口及服务器管理的 ASR 额度。服务不可用时会报错；桌面版没有用户 ASR 凭据设置页，也不会自动回退到离线识别。

- 发布签名、公证、更新托管和跨上一版本的已安装产物验证需要生产发布环境。
- 依赖包含 lifecycle script 的桌面插件，只有其包名进入桌面项目经过评审的 `allowBuilds` 策略后才能安装。
- 独立产品不迁移现有 DSH 会话或凭据，用户在产品内配置自己的账号。显式把 `MUSE_MED_HOME` 指向已有 DSH home 会退出数据隔离，这不构成数据迁移。
- 在 Electron win32-arm64 宿主上，未打包启动现在可以成功，但载荷仍为 x64：`packages/skill/tool-workspace-dependencies/src/index.ts` 的架构校验会把载荷记录的架构与宿主 `process.arch` 比较，因此 `load_workspace_dependencies` 工具仍可能拒绝 primary runtime。

## 开发备注

上线前 CDN 与容量决策见[桌面更新提案](../../.agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.zh.md#cdn-and-capacity-qualification)。

共享技能 `wechat-shortdrama-harvest` 通过用户已登录的 Windows 微信获取小程序及受支持的视频号资源，随包提供 Python 辅助脚本、OpenCV 和 SciPy。配置与私有采集状态保存在项目内本次任务的 `SHORTDRAMA_WORK` 目录，转写前核对判集结果，不覆盖内容不同的已有视频。平台兼容性和可访问集数可能不同，须报告缺集。自动采集会先归档候选文件，再进行最终核对，文件数量不能单独证明全集完整。

小说与视频转剧本在起草前共用 `screenplay-format` 技能：集号与场次、人物表、▲动作段、对白、OS/VO，以及有来源依据的集尾钩子。剧本正文不带来源时间码；集数与篇幅沿用大纲阶段可修改的约定。

内置 `muse-llm-wiki` 技能沿用当前 Muse 登录，支持浏览目录、全文检索、读取原始资料，以及沿链接页和引用查找依据。经审核的笔记和剧本在私人或明确绑定的项目范围内保留不可变原文；Muse 主模型使用原文区间引用和版本检查写入派生页。共享资料需要管理员授权。工具与访问规则见 [Muse LLM Wiki](../../services/muse-accounts/README.zh.md#muse-llm-wiki)。

桌面 Office 组合提供 `screenplay_export_docx`：按给定顺序用内置 python-docx 将 Markdown 合成新的 Word 文件，设置分集分页、中文字体并核对段落正文。支持标题与加粗，其他 Markdown 语法原样保留，不覆盖已有文件。编辑模式保留 Markdown，按 `office-docx` 检查 Word 排版后交付 DOCX。

共享技能 `douyin-download` 接受抖音视频页、`modal_id` 页面和分享链接。内置并以 SHA-256 锁定的 yt-dlp Python 归档将目标视频下载到 `source/media/douyin/`，经 ffprobe 校验后连同来源记录发布。它不会自动导入浏览器凭据；需要时将用户提供的本地 Cookie 文件复制到私有临时目录使用，不覆盖已有媒体与记录。平台鉴权或提取器兼容性仍可能阻止下载，须报告实际结果后再请求其他来源。
