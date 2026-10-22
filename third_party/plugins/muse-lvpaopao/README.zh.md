---
description: "在已验证的本机微信运行时按剧名搜索绿泡泡，并按实际目录恢复分集下载。"
kind: "package-bundle"
---

# muse-lvpaopao

[English](README.md) | 中文

## 概述

Muse 编导 Agent 可按剧名查找绿泡泡剧目、读取实际分集目录，并在可恢复的本机任务中逐集保存账号可播放的内容。此实验源码仅供开发使用，不进入 Desktop 发布输入和默认组合；独立 bundle 只添加连接 provider。本机准备流程从自有资源生成私有 helper，显式 SSH 配置则保留旧远程路径。Windows 和单独准备的 Mac 隔离副本均已通过原生下载 36 集的测试；Mac 公开工具还能核对并交付这些文件，无需重新获取播放地址。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

开发构建必须显式在全局挂载 `muse-lvpaopao/bridge`，并在目标 Agent 内挂载包根入口。独立[包补丁](cordis.patch.yml) 只插入 provider，不注册全局工具。consumer 需要 Tools、Agents、subprocess 及共享 provider。发布清单不构建或安装此包。

```yaml
- insert:
    - id: muse-lvpaopao-bridge
      name: muse-lvpaopao/bridge
```

在目标 Agent 组合中挂载 consumer，不传连接凭证：

```yaml
- id: muse-lvpaopao
  name: muse-lvpaopao
```

### 本机准备与显式连接

没有显式连接文件时，`autoSetup:true` 会在首次原生请求时启动本机准备。Host 选定的 Python 必须已具备 [Windows 依赖文件](native/requirements-windows-25560.lock) 或 [Mac arm64 依赖文件](native/requirements-macos-arm64-269602.lock) 中锁定的依赖，FFmpeg/FFprobe 需通过 Host 媒体路径或可执行文件查找可用。bootstrap 验证支持的微信运行时及当前进程身份，将自有 helper 源码复制到 `<Muse home>/lvpaopao/runtime`，并封存 imports manifest 与本机进程 attestation。它不安装微信、不获取凭证，也不代用户登录。Mac 要求已有单独准备的隔离微信副本和私有 home；此流程不会创建、重新签名或启动该副本，也不修改原版微信。请在已登录且已验证的微信中打开绿泡泡；状态返回 `waiting-target` 时重新打开。

Mac 未运行合格副本时，准备流程立即返回 `mac-isolated-wechat-required`，不再等待通用超时；构建不受支持或私有 home 不匹配也会返回独立的固定错误。修正运行时后显式调用一次 `status`，失败的查询不会自动重放准备流程。验收通过的 `status-returned` 包含 `ready:true`；`hostLoginState` 是小程序辅助业务状态，不代表桌面微信登录状态，也不是查询前提。

provider 首先读取 `<Muse home>/lvpaopao/connection.json`。已存在的有效文件优先于自动准备。本机连接使用 `transport:local`、`localPython`/`localHelper` 绝对路径、`cwd` 和准确的 `helperSha256`；旧 SSH 连接使用 `transport:ssh`、`sshHostAlias`、Windows `remotePython`/`remoteHelper` 绝对路径、`cwd` 和哈希。省略 `transport` 的现有显式文件保留旧的 `ssh` 默认值，自动准备从不回退到 SSH。修改私有文件后，重启或重新组合 provider；已存在但配置无效会导致激活失败。不要把凭证、进程 attestation 或播放地址放进 profile、源码或模型参数。

| Provider 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `connectionFile` | Muse home `lvpaopao/connection.json` | 仅所有者可访问的 transport 设置，模型不能控制此路径。 |
| `maxQueuedRequests` | `8` | 共享等待请求数，不含正在执行的请求。 |
| `autoSetup` | `true` | 连接文件缺失时准备已验证的本机 helper。 |
| `pythonExecutable` | 依次取 `MUSE_LVPAOPAO_PYTHON_PATH`、`MUSE_DOUYIN_PYTHON_PATH`，否则为空 | Host 选定的 Python；缺少准备条件时返回 `setup-required`。 |
| `resourcesDirectory` | 包内 `native/` 目录 | 本机准备用到的自有 helper 资源。 |
| `setupTimeoutMs` | `120000` | 准备及等待目标就绪的时间，最大 `600000` ms。 |
| `setupShutdownTimeoutMs` | `10000` | 等待准备进程清理的时间，最大 `60000` ms。 |
| `helperLifetimeMs` | `3600000` | 受管连接生命周期：默认一小时，最多四小时（`14400000` ms），包含等待目标的时间。 |
| `helperMaxCallbacks` | `4096` | 每次连接可接受的已验证回调数上限，最大 `16384`。 |

| Consumer 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxQueryChars` | `80` | 标题查询的最大 Unicode 码点数。 |
| `maxEpisodeCount` | `20` | 请求分集目录的最大分页宽度。 |
| `maxResultItems` | `50` | 结果中保留的最大搜索候选数。 |
| `maxSeriesEpisodes` | `400` | 声明的整剧集数上限，最多可配置为 `10000`。 |
| `maxAttempts` | `3` | 每次启动或恢复调用中，每集的最大尝试次数。 |
| `retryDelayMs` | `1000` | 已归类为可安全重试的失败之间的等待时间。 |
| `seriesLockWaitMs` | `5000` | 报告任务占用前等待私有任务锁的时间。 |
| `copyChunkBytes` | `1048576` | 已验证本机文件复制的分块大小。 |

### Read rankings

调用 `rankings`，省略分页字段即可读取口碑榜首页。结果包含平台返回的榜单名称、原始名次、剧名和来源 ID，以及 `total` 和 `hasMore`。其他 `boardType` 从返回的 `boards` 中选择；后续翻页复用相同的 `count` 和返回的 `coldStartTime`，递增从零开始的 `pageIndex`。无效条目保留名次缺口并标记 `partial:true`，不会把后面的排名前移。榜单来自实时服务，不同调用之间可能变化。选中的来源身份可继续用于详情或全集下载。

### 下载与恢复全集

让编导 Agent 下载指定剧目，或给 `download_series` 传入 `query`。只有搜索完整且规范化后的剧名精确匹配唯一候选时，工具才自动选定来源。否则返回候选及 `selection-required`；选定 `srcAppId` 和 `originDramaId`，再以 `srcAppId` 和 `dramaId` 传入。来源未明确时不开始获取媒体。工具读取详情并分页查询目录，保留实际返回的集号，报告缺失或部分覆盖，不编造集数。

下载要求已解析的 transport 中有 `downloadEnabled:true`，并有实际请求 Session 的文件权限。自动准备会设置此 transport 标记，显式连接需自行配置。默认目标是该 Session 工作区内的 `downloads/lvpaopao`。相对 `outputDir` 限于工作区内，外部目标需完整文件访问权限。transport 中的目标目录不会覆盖 Session，原生目录或媒体请求前先检查权限。

保存的任务目录包含 `manifest.json`、逐集文件及其回执。以相同的已选来源和目标目录再次调用 `download_series` 即可恢复，已完成文件在复用前会重新检查。每集在重试、取消和作用域替换后都保留原始持久请求 key。目录暂时缺少某集时，已保存的请求 key 和状态仍会保留；目录覆盖不完整时，整剧不会算作完成。已确认的传输失败按 `maxAttempts` 重试；获取结果未知时，必须先用同一个 key 调用 `download_status`，才能再次尝试。下载器仅在前缀已验证且 HTTP 范围校验标识匹配时恢复部分传输，不会拼接已变化资源的字节。

给 `series_status` 传入已选来源 ID 和同一目标目录，可读取已保存进度并验证已完成文件，无需启动 helper 或发出原生请求。结果区分已完成、待处理、进行中、失败、拒绝、未知和缺失的集。只有目录覆盖每一集且所有已保存文件通过验证，整剧才算完成。取消工具调用时，外层运行时可能返回中止结果；之后读取 `series_status` 确认已保存进度。目录响应或单集成功都不代表整剧交付完成。

`status`、`search`、`detail` 和 `episodes` 仍可用于检查。`download_episode` 与 `download_status` 接收实际集号及原始 64 位小写十六进制 key。本机 `download_first_episode` 兼容入口使用同一分集下载和状态查询路径以及稳定首集 key，不使用 SCP。下载剧目 ID 使用 64 字符的字母/数字/下划线/连字符形式，`detail` 和 `episodes` 保留更宽的不透明 ID 校验。返回文件路径不会自动展示视频或发送聊天附件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>连接所有权与持久任务</summary>

[provider](src/bridge.ts) 管理一个懒创建的本机或显式 SSH 连接，并串行处理 Agent 共享的原生请求。释放 Agent 会等待其拥有的请求和复制结束，不会释放 Host provider。取消已确认时保留仍存活的 transport。`target-not-ready` 结果，或 worker 清理已确认后的 `transfer-failed`，也会保留健康连接；终止错误或清理未确认会关闭该代际。清理确认后，可用显式 `status` 恢复。provider 不会自动重放失败的业务请求。

[整剧引擎](src/series.ts) 为每个来源与目标目录对应的任务加锁，在获取媒体前保存集状态。[分集复制](src/episode-download.ts) 发布回执前会检查来源身份、原始 key、可播放集授权、已解码文件元数据及准确的本机字节。本机复制和原生传输会保留已验证的部分状态以便恢复。[目录解析](src/catalog.ts) 管理剧名选择及实际目录覆盖，工具投影提供有界元数据，不输出签名播放地址或任意 helper 错误。

helper 清理要求 disposal、脚本卸载、detach、服务关闭及受管进程退出全部确认。临时目标对象改动可能持续到对象销毁或目标重启；卸载 hook 不承诺完整回滚。[bootstrap](native/boot.py) 验证准确的受支持运行时，不会仅凭版本名称接受其他版本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[插件构建概览](../README.zh.md) 说明 Desktop 包交付。[Provider 设置](src/bridge.ts) 和 [transport 设置](src/config.ts) 各自定义可接受的配置字段。[原生资源清单](scripts/native-resources.mjs) 标明为打包暂存的自有文件。

-----

<a id="model-experience"></a>
## 模型体验

### 作用域内工具

#### 模型看到什么

编导 Agent 看到一个 `lvpaopao` 声明，用于目录检查、按剧名下载全集、逐集结果核对及已保存进度查询。结果包含有界的就绪状态、候选身份、实际集数覆盖、持久任务路径及已验证本机文件元数据。缺少准备条件或下载不完整都有明确结果，provider 和 consumer 都不增加系统提示词段落。

#### Token 影响

consumer 贡献一份工具声明，每次调用通过常规已记录工具历史追加有界规范结果；完整的逐集 manifest 保留在磁盘，不进入每次结果。

#### KV Cache 影响

结果追加到对话。挂载或修改 consumer schema 可以改变后续工具声明；此包不保证模型供应商缓存复用。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

当前验证及部署限制如下：

- Windows x64 微信 4.1.15.56 / WMPF 25799 已实际通过本地 helper 准备、剧名搜索、完整目录、榜单及条目详情回读、36 集下载与整剧工具交付、完整解码和哈希校验、原请求键恢复，以及从同一保存地址继续 1 MiB 中断传输的测试。验收使用已准备的测试环境，不代表新电脑安装验收通过。
- Mac arm64 微信 4.1.13 / 269602 使用绑定准确哈希及私有 home 的隔离副本验收。搜索、完整目录、榜单、36 集原生下载、完整解码和哈希检查、1 MiB 中断续传均通过。真实 Session 与共享插件连接核对了全部原请求键、交付整剧，重复调用未新增获取请求。原版签名 Mac 微信、新电脑安装、其他构建及主动取消后继续原生业务，仍未验收。
- 下载要求账号可播放对应集；插件不购买剧集、不观看广告、不解锁权限。被拒绝或结果未明确的集会使整剧保持未完成。技术可达不赋予内容再利用权。
- 包清单包含用于资源暂存交付的自有原生源码和锁定依赖文件，不包含微信二进制、提取的目标源码、凭证、私有 attestation 或媒体。本次修订未打包、未发布，安装后的资源交付尚未验收。准备仍要求可用的 Python 依赖、媒体工具、真实的受支持运行时及用户登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
