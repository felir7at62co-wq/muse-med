# Agent Note: 在桌面壳中分离内置清单与可安装插件

Status: implemented

[English](2026-09-24-desktop-plugin-catalog-and-transactions.md) | 中文

## Problem

桌面 profile 随包携带由固定源码构建的社区包，而 profile 的插件列表描述不了它们：它们不是 profile 依赖，因此在那里没有已记录版本、启用标记或卸载操作。市场包本身也无法挂载，因为它的 Web 界面把 HTTP 路由注册到一个无端口桌面组合已禁用的服务上。用户仍需要看到随包携带了什么、profile 是否挂载它，以及哪些社区插件可以安装 —— 即使这台机器没有网络。

## Decision

内置包从运行时根目录自身的 package manifest 清点，`mounted` 取自 profile 的 `dsh.profile.bundles` 列表。它们不是 profile 依赖，而包事务只增删 profile 依赖，因此已安装列表永远不会显示它们：`dshmarket` 随包携带但不挂载，其余四个社区包位于固定的内置 bundle 前缀中。[插件目录](../../../../apps/desktop/src/plugin-catalog.ts)在不发网络请求的情况下读取该清单，并且绝不与 profile 的插件记录混合，因此内置包不会被提供安装、更新或卸载。

市场包 `dshmarket` 1.47.0 的源码（MIT，上游提交 a8401c46fb45d9d18a76b918fab6b56ab3c32ab1）只作为库使用：产品构建在生成的 manifest 中加入 `./catalog`，指向 `types: ./lib/types/registry.d.ts` 与 `default: ./lib/registry.js`，并在压缩包的 `SOURCE.json` 中记为 `compatibilityOverlay.catalogExport`，打包前先导入它、要求存在 `loadRegistry` 函数。固定的上游 manifest 没有这个导出，它的插件行也不在产品 bundle 列表中，因此产品运行的只是该包里的目录加载器。

受信的插件管理窗口拥有发现流程：它从本地读取渲染内置清单与已安装插件，在用户要求时执行一次在线目录加载，在窗口内本地过滤已加载条目，并且自己不安装任何东西。用户确认的 npm 条目会作为普通 npm spec 交给既有的桌面包事务：它停止后端、以禁用脚本的方式安装、改写 profile，然后重启后端。

远程目录是不可信输入，壳会校验它显示或安装的每一个叶字段：条目标题、HTTPS `github.com` 仓库地址、各语言描述字符串，以及解析为包名的 npm spec。条目会被重建为壳自己的对象，因此上游未知字段 —— 包括上游的 `install` 命令 —— 不会进入窗口。没有 npm spec 的条目仍带仓库链接列出，且没有安装操作；profile 记录的是精确的 registry 版本，因此仓库或 tarball 地址无法成为 profile 依赖。

每个读取或修改包的 IPC 通道都断言发送方 frame 是桌面壳自己的文档，后端应用文档（`dsh-app://app`）被拒绝。开发模式下包变更是只读的：窗口说明这些变更需要打包应用，已安装列表为空，每个变更通道都抛错。

目录加载失败会在窗口中报告，并保留内置清单。内置加载器没有快照回退，因此失败表现为一条消息和一次重试，而不是陈旧列表；在用户确认某个 spec 之前不会下载任何东西。

## Alternatives considered

**在桌面 profile 中挂载市场 bundle。** 它的插件注入 Web 服务器服务并在那里注册自己的界面路由；桌面组合禁用了该行，因此挂载副本只会贡献第二个无法工作的界面，而产品依旧拿不到目录元数据。

**另写一个桌面目录客户端。** 这会重复维护中的目录抓取、它的区域路由与条目字段，并随每个上游发布与市场漂移。消费固定的加载器让目录内容只有一个归属者。

**按仓库链接安装条目。** 事务接受的是 npm spec，profile 存的是精确 registry 版本；从外部 URL 合成依赖，会为市场本身只按源码分发的条目放宽这两者。

**在渲染器中校验目录响应。** 响应是网络数据，而渲染器唯一的权限就是 preload 桥；在主进程解析能让每个未校验字段都进不了窗口。

## Consequences

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责包事务、共享包身份与插件生命周期；[独立产品决策](2026-09-23-muse-med-independent-desktop.zh.md)负责产品 home 与组合；[社区源码提案](../../proposed/process/2026-09-23-muse-med-community-plugin-source.zh.md)负责保留固定的上游源码。三者均未被完全取代。

单元测试覆盖离线清单及其 `mounted` 标记、五个内置包名、畸形目录条目与不安全仓库地址的拒绝、一次请求只做一次显式发现的离线优先渲染、本地搜索、确认后安装的交接、加载失败后内置项仍然可见，以及开发模式的只读路径。未做过真实的外部插件安装，也未在打包重建中运行过目录窗口，壳尚未从打包应用加载过线上市场；这些路径仍未验证。
