# Agent Note: Desktop 更新器把安装包缓存在本产品自己的目录

Status: implemented

[English](2026-09-28-desktop-updater-cache-directory-per-product.md) | 中文

## Problem

打包没有设置更新器缓存目录，于是沿用了 electron-builder 的派生默认值，而该默认值把本产品与官方 DeepSeek Harness 放到了同一个目录：Windows 上是 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater`，macOS 上是 `~/Library/Caches` 下对应的路径。electron-updater 用固定文件名把下载来的安装包存在其中（`CURRENT_APP_INSTALLER_FILE_NAME` 就是 `installer.exe`），所以这个目录是唯一一个槽位：两个产品的更新器都可能写入它，也都可能执行里面的文件。

这不是假设。某台机器的 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater` 曾被读到存放官方产品的安装包（860,747,005 字节，VersionInfo 0.1.7-rc.2），之后对同一路径的另一次读取读到的是本产品自己的安装包（861,634,377 字节，VersionInfo 0.1.6-alpha.3，产品名 `muse-med`）——这个槽位已经跨产品被覆盖过。`E:\muse-med` 上已安装的 `0.1.6-alpha.3` 在其包内 `resources/app-update.yml` 里把这个共享目录记录为自己的目录，因此它的更新流程读写的是一个别的已安装产品同样拥有的目录。一次把 A 产品的安装包交给 B 产品的更新，就会装错程序。

该值由打包后的 `package.json` `name` 派生，既不由 `appId` 派生，也不来自任何配置字段。`app-builder-lib` 26.15.3 的 `AppInfo.updaterCacheDirName` 返回 `sanitizeFileName(name).toLowerCase() + '-updater'`；`sanitizeFileName('@deepseek-ai/dsh-desktop')` 丢掉 `/`、保留 `@`，得到 `@deepseek-aidsh-desktop`，这正是已安装 `app-update.yml` 记录的值。因此每个包内 manifest 仍带该上游名字的产品都共用同一个缓存目录——app id 在其中不起作用，同机上无关的 `@pi-desktop/desktop` 派生出的 `@pi-desktopdesktop-updater` 目录复现了这一点。

## Decision

包内 manifest 重述本产品的名字，于是派生出的目录只属于本产品：[electron-builder.config.mjs](../../../../apps/desktop/electron-builder.config.mjs) 中的 `extraMetadata: { name: 'muse-med' }` 得到 `muse-med-updater`。该名字既不含 `@` 也不含 `/`，其中任何部分都不会被当作路径或作用域读取。

electron-builder 26 没有为这个值提供配置字段。`updaterCacheDirName` 只声明在 app-builder-lib 生成的 `scheme.json` 的发布 provider 选项中（`GithubOptions` 及其同类），在 `out/configuration.d.ts` 的 `Configuration` 中并不存在；`PublishManager.getAppUpdatePublishConfiguration` 按 `{ ...publishConfigs[0], updaterCacheDirName: packager.appInfo.updaterCacheDirName }` 组装写出的 `app-update.yml`，因此在 `github` 发布条目上提供的值会在写盘前被覆盖，包内 `package.json` 的 `name` 是唯一可达的输入。在 `extraMetadata` 中重述名字，正是让派生值属于本产品的手段。

同一个 getter 也供安装器一侧使用，所以安装器与更新器认的是同一个目录。`NsisTarget` 把 `APP_PACKAGE_STORE_FILE` 与 `APP_INSTALLER_STORE_FILE` 定义为 `${appInfo.updaterCacheDirName}\<固定文件名>`，而 `templates/nsis/include/installer.nsh` 会把正在运行的安装器移动到 `$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}` 供后续复用。若在应用内做运行时覆盖，这些 define 会指向与更新器写入位置不同的目录。

## Consequences

包内 `package.json` 的 `name` 变为 `muse-med`，而这正是本产品启动时已为 Electron 声明的名字：[`applyDesktopProductIdentity`](../../../../apps/desktop/src/product-identity.ts) 在抢占单实例锁之前调用 `app.setName('muse-med')` 并把 userData 固定为 `%APPDATA%\muse-med`，这正是[共享 Electron 身份笔记](2026-09-28-muse-med-shared-electron-identity.zh.md)的决定。本次改动不移动任何 userData 目录；它消除的是 manifest 与运行时身份之间的分歧——由 manifest 派生的 Electron 默认值如今落在启动时显式设置的那个目录上。旧的共享目录 `%APPDATA%\@deepseek-ai\dsh-desktop` 以及保持原样的决定仍归那篇笔记所有。本产品自身状态不受两者影响，因为会话、设置与凭据存放在 [`~/.muse`](../../../../apps/desktop/src/product-home.ts)，或在 `MUSE_MED_HOME`，都位于 `app.getPath('userData')` 之外。

**那篇笔记的 manifest 事实已成为历史。** 它的 Problem 段与 `applyDesktopProductIdentity` 的 JSDoc 都写着包内 manifest 保留 `@deepseek-ai/dsh-desktop` 并由它派生共享目录；本次改动之后的构建携带的是 `muse-med`。它的运行时身份决定、userData 决定与单实例锁推理均未改变，那些事实仍由它拥有。

安装器身份不随名字移动。卸载注册表键与 NSIS 应用 GUID 由 `appInfo.id` 派生（`NsisTarget` 中的 `UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)`），因此已安装的 `0.1.6-alpha.3` 仍会被识别并原地升级，而不会并行另装一份；卸载器的 `$APPDATA\<APP_PACKAGE_NAME>` 清理跟随新名字，而新构建实际使用的正是该目录。快捷方式、其 AppUserModelID、安装目录、产物名、macOS bundle identifier 以及随包 dsh 运行时的 `package.json` 都不受影响——`extraMetadata` 只重写 asar 内的应用 manifest，且没有任何工作区 manifest 按名字解析 `@deepseek-ai/dsh-desktop`。Linux 会顺带得到一个以产品命名的二进制，因为 `linuxPackager` 在该处回退到 `appInfo.sanitizedName`。

**已安装的 `0.1.6-alpha.3` 在被替换之前一直使用共享目录。** 本次改动改变的是打包写入的内容，因此无法影响机器上已安装的 `app-update.yml`：该修复从下一次安装或更新起生效，只有此后的构建才会记录并使用 `muse-med-updater`。

## Alternatives considered

**把 `updaterCacheDirName` 写成配置。** electron-builder 26.15.3 不提供该字段，运行时也没有任何代码为它读取配置。写在 `github` 发布条目上的值会被那个负责写出 `app-update.yml` 的序列化步骤丢弃，看起来像修复，实际什么也没改。

**重命名 `apps/desktop/package.json`。** 不采用：这会重命名一个被所有 manifest 与工具解析的工作区包，而 `extraMetadata` 把重命名限定在 electron-builder 读取该值的包内 manifest 上。

**在更新协调器里覆盖缓存目录。** 不采用：electron-updater 会写到 NSIS define 未指定的目录，失去那些 define 存在的安装器缓存复用，而包内 `app-update.yml` 对其它读取方仍记录共享值。

**在上游名字前加本产品标识。** 不采用：包内 manifest 仍会带上游产品的包名，而本产品正在与之分离的正是这一身份，派生目录也会继续读作那个产品的。

## Verification

`pnpm exec vitest run apps/desktop/tests/updater-cache-directory.spec.ts apps/desktop/tests/nsis-payload-assets.spec.ts apps/desktop/tests/macos-signature.spec.ts apps/desktop/tests/desktop-build-paths.spec.ts` 通过，四个文件共 17 个测试，退出码 0。[`updater-cache-directory.spec.ts`](../../../../apps/desktop/tests/updater-cache-directory.spec.ts) 钉住包内 manifest 名与由它派生的 `muse-med-updater` 目录，并拒绝 `@deepseek-aidsh-desktop-updater`，使共享值无法在无人注意的情况下回归。

此处未验证：打包后 `resources/app-update.yml` 里的 `updaterCacheDirName` 行。派生式、固定的安装器文件名与写入位置均读自已安装的 `0.1.6-alpha.3` 包与 app-builder-lib 26.15.3，但只有一次打包才会产出该文件；本次改动未做打包。

[Desktop 打包与更新记录](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 拥有该目录所服务的发布流。
