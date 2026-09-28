# Agent Note: 给 muse-med 自己的 Electron 身份

Status: implemented

[English](2026-09-28-muse-med-shared-electron-identity.md) | 中文

## Problem

已安装的 `muse-med` 0.1.6-alpha.3 能报出版本号，却无法启动：双击或从命令行启动后，进程在八秒内自行消失，退出码 0、没有任何输出、也没有向任何 home 写入文件。同一台机器上还跑着八个 `DeepSeek Harness` 进程，而 `%APPDATA%\@deepseek-ai\dsh-desktop` —— 上游产品的 userData 目录 —— 仍在被写入。

两个产品都从同一个打包包名 `@deepseek-ai/dsh-desktop` 推导出该目录。[`electron-builder.config.mjs`](../../../../apps/desktop/electron-builder.config.mjs) 里的 `productName` 和 `executableName` 改的是可执行文件与产物的名字，改不了 Electron 用于 `userData` 的应用身份。Electron 按应用名推导 `userData`，并把 `app.requestSingleInstanceLock()` 背后的 `SingletonLock`、`SingletonCookie`、`SingletonSocket` 文件放在同一个目录里，因此正在运行的 DeepSeek Harness 已经占住了唯一的实例锁：[`claimDesktopSingleInstance`](../../../../apps/desktop/src/single-instance.ts) 读到 `requestSingleInstanceLock() === false`，调用 `application.quit()`，桌面壳便自行退出。`apps/desktop/src/main.ts` 及任何随包模块都没有在该次抢占之前设置应用名或 userData 路径。共用该目录还意味着 Chromium 缓存、更新器状态以及此后每一个窗口状态文件都与上游产品共用。

## Decision

[`applyDesktopProductIdentity`](../../../../apps/desktop/src/product-identity.ts) 是 `apps/desktop/src/main.ts` 的第一条语句，早于产品 home、任何路径读取以及实例锁抢占。它先调用 `app.setName('muse-med')`，再调用 `app.setPath('userData', join(app.getPath('appData'), 'muse-med'))` —— Windows 上即 `%APPDATA%\muse-med`，目录名不含 `@`，也不含路径分隔符。它先创建该目录，因为 `app.setPath` 的文档写明目录不存在会抛错，而单实例文件就创建在该目录内。

已经收到 `--user-data-dir` 的启动保留该目录：开发启动器会传这个参数，Chromium 会用它对 `app.getPath('userData')` 生效，覆盖它则会把开发存储挪进已安装产品的目录。`sessionData` 在未单独设置时跟随 `userData`，所以这一次调用也覆盖了 Chromium 存储。

打包身份不变。electron-builder 的 `appId`、macOS bundle 身份、更新地址与协议仍来自发布环境，与[独立产品决策](../architecture/2026-09-23-muse-med-independent-desktop.zh.md)所记录的一致；该决策没有覆盖的运行时身份，现在也归本产品所有。

旧的共用目录原样保留，不从中迁移任何东西。其中的 Chromium 缓存、`Preferences`、cookies、local storage 和已下载的更新包要么可再生，要么属于上游产品；其中唯一承载状态的 `Singleton*` 文件绝不能复制，因为复制过去的锁会让新目录以同样的方式启动失败。产品自身状态不受影响：会话、设置和凭据位于 `~/.muse`，或位于 `MUSE_MED_HOME`，与 Electron 的 userData 是不同路径。没有丢弃任何用户数据，因为该产品从未单独向旧目录写入过用户数据。

## Testing

`apps/desktop/tests/product-identity.spec.ts` 驱动可注入的 application 桩：userData 路径为 `join(appData, 'muse-med')`，绝不为 `join(appData, '@deepseek-ai', 'dsh-desktop')`；调用后该目录存在；记录的调用顺序为 `setName` → `getPath('appData')` → `setPath('userData')` → `requestSingleInstanceLock`；而 `commandLine.hasSwitch('user-data-dir')` 为 true 的桩只记录到 `setName`。`apps/desktop/tests/main-startup.spec.ts` 在 `main.ts` 的真实调用点断言同一顺序，并从 `apps/desktop/package.json` 的包名推导上游目录，因此改回该包名会让测试失败。`apps/desktop/tests/single-instance.spec.ts` 保留既有行为：第二个进程直接退出且不注册生命周期工作，后续启动聚焦主进程而不是再开一个窗口。

上述 Electron 事实已在本机用 Electron 44 实测：`--user-data-dir` 无论放在应用路径前还是后都会覆盖 `app.getPath('userData')`；`app.setPath` 接受了不存在的目录，因此这里选择按文档先创建目录，而不依赖两种行为中的任何一种。

## Alternatives considered

**复用 `resolveDesktopAppId` 生成 userData 目录名。** 它解析打包用的 `DSH_DESKTOP_APP_ID` 并校验 reverse-DNS 标识符；它位于 `apps/desktop/scripts/desktop-release-environment.mjs`，而随包 `files` 列表排除了该文件，所以已打包进程无法 import 它，打包环境里也没有这个变量。让 userData 依赖它还会一并改变 macOS bundle 身份、更新器身份和 Windows 应用 ID，那属于发布线决策，而不是启动修复。目录名以 `src` 中的产品名为唯一出处，并与 `productName`、`executableName` 保持一致。

**迁移旧 userData 目录。** 该目录属于已安装的 DeepSeek Harness，且仍被它写入；其中的内容无法归属到任一方。复制它会把上游产品的渲染器状态和 `Singleton*` 文件一起带过来，而后者会直接破坏新的实例锁。

**保留共用目录并去掉单实例锁。** 去掉锁会让两个进程写同一份 Chromium profile 和同一份产品 profile，而且共用数据的缺陷依然存在。

## Consequences

已安装的 Muse 与已安装的 DeepSeek Harness 可以同时运行：各自拥有自己的应用名、userData 目录与进程锁。已经装过 `muse-med` 的机器，首次运行新构建时 Electron 存储是空的 —— Chromium 缓存、`Preferences`、cookies 和 local storage 都会重新生成，下载到旧共用目录里的更新包会重新下载。产品数据不受影响。

[独立产品决策](../architecture/2026-09-23-muse-med-independent-desktop.zh.md)与[内置运行时决策](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责产品 home、预设名册与包生命周期；两篇均未被取代。两个产品都已安装的机器上真实双进程启动未在此验证：它需要下一个已安装构建，打包仍归发布线。
