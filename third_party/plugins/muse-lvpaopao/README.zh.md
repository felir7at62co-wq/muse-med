---
description: "为编导 Agent 提供共享绿泡泡 Windows 连接和作用域内工具。"
kind: "package-bundle"
---

# muse-lvpaopao

[English](README.md) | 中文

## 概述

Muse 编导 Agent 可通过单独配置的 Windows helper 搜索绿泡泡剧目、读取详情与实际集号，以及复制已授权首集。一个 Host provider 管理目标连接，每个 Agent 获得自己的工具贡献。此包不安装 Windows helper，也不提供账号凭证。未配置时服务仍可用，返回 `unconfigured`，不启动进程。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Desktop 组合在全局挂载 `muse-lvpaopao/bridge`，仅在统一编导 Agent 内挂载包根入口。内部预设 ID 保持 `short-drama`，不会增加用户可选模式。独立[包补丁](cordis.patch.yml) 只挂载 provider，不注册全局工具。Desktop 已提供该 provider，不会再次选择此独立 bundle。consumer 需要常规 Tools、Agents、subprocess 服务及该 provider。

```yaml
- insert:
    - id: muse-lvpaopao-bridge
      name: muse-lvpaopao/bridge
```

在目标 Agent 组合中挂载 consumer，不传连接参数：

```yaml
- id: muse-lvpaopao
  name: muse-lvpaopao
```

provider 默认读取 `<Muse home>/lvpaopao/connection.json` 私有连接文件。在该文件配置固定 SSH alias、本机进程目录、Windows Python/helper 绝对路径及准确 helper SHA256，再重启或重新组合 provider 以载入变更。helper 另行验证完整 imports manifest 和本机进程 attestation。不要把密钥、现场证明、播放地址或账号数据放进 profile、源码树或模型参数。文件缺失属于预期的未配置状态，已存在但格式错误则是配置错误。

| Provider 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `connectionFile` | Muse home `lvpaopao/connection.json` | 私有连接设置，模型不能控制此路径。 |
| `maxQueuedRequests` | `8` | Agent 共享的等待请求上限，不含正在执行的请求。 |

| Consumer 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxQueryChars` | `80` | 标题查询的最大 Unicode 码点数。 |
| `maxEpisodeCount` | `20` | 每次调用请求的最大集数。 |
| `maxResultItems` | `50` | 结果中保留的最大搜索候选数。 |

`lvpaopao` 工具提供 `status`、`search`、`detail`、`episodes`、`download_first_episode`。普通剧目 ID 保留为最多 128 个允许 ASCII 字符的不透明字符串，下载使用更窄的 64 字符字母/数字/下划线/连字符形式。分集结果保留实际返回的集号与 partial 标记，空响应或部分结果不代表目录完整。可选诊断仅保留固定分类和数值或 null 的原生错误码，不输出原始错误或签名 URL。

下载要求私有连接中 `downloadEnabled:true`，并有实际发起请求的 Session。默认写入该 Session 工作区下的 `downloads/lvpaopao`；显式工具参数 `outputDir` 遵循其 sandbox/文件策略。transport 文件中的目标目录不能覆盖 Session。获取媒体或启动复制前先执行文件校验。成功要求本机精确字节数与 SHA256 匹配 helper 已解码的文件，返回路径不会自动调用 `present` 或发送聊天附件。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>连接所有权与清理</summary>

Host 串行访问一个目标，并负责释放连接。关闭某个 Agent 只取消它自己的排队/原生请求/复制工作。取消已确认且 transport 仍存活时保留共享 SSH；清理未确认或 transport 终止错误会关闭该代际。原生取消仍可能使目标租约失效，需在完成清理后通过后续显式 `status` 重建。失败或结果未知的业务请求从不自动重放。provider 懒创建 transport，原请求或所拥有进程未结束前，取消不会宣称完成。

当前 helper 生命周期上限为十分钟，包括等待目标启动的时间。状态可以提示操作者重开选定目标。清理要求 helper 的 disposal/unload/detach/server-closed 全部确认，并且受管进程正常退出。原生插桩可能留下应用对象改动，直至对象销毁或目标重启；移除 hook 不承诺完整回滚。

</details>

<a id="further-exploration"></a>
## 进一步探索

[插件构建概览](../README.zh.md) 说明 Desktop 包交付。[provider](src/bridge.ts) 管理连接生命周期，[consumer](src/index.ts) 管理已记录工具结果和 Session 作用域的文件目标目录。

<a id="model-experience"></a>
## 模型体验

### 作用域内工具

#### 模型看到什么

编导 Agent 看到一个 `lvpaopao` 工具，其内容为业务参数、就绪状态、实际目录结果和已验证本机文件元数据。未配置或失败的操作返回明确的安全结果。单独 provider 不贡献工具 schema，也不新增系统提示词段落。

#### Token 影响

consumer 作用域内有一份工具声明，每次调用通过常规已记录工具历史追加有界规范结果。

#### KV Cache 影响

结果追加到对话。挂载或修改 consumer schema 可以改变后续工具声明；包不保证模型供应商缓存复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

真实验收仅覆盖固定 Windows x64 微信 4.1.13.65 / WMPF 25560 构建和一次保存回执的首集复制，包括完整解码及本机哈希回读。复用没有新请求播放地址。安全取消确认由离线测试覆盖，原生任务主动取消后继续业务尚未真机验收。其他目标版本、通过适配器获取新地址、其他剧目及整剧媒体下载尚未验收。技术可达不赋予内容再利用权。

npm 包包含独立拥有的 adapter 代码，不含 helper、微信二进制、提取的目标源码、凭证、私有 attestation 或媒体。仓库的 `native/` 目录包含版本化 helper 源码，需在固定 Windows 构建上单独部署，不提供自动安装。每个 Windows 部署都需在封存前取得自己真实的进程身份与证明。把源码接入本地 main，不代表运行中的应用或已发布安装器已更新。helper 仍为单独受控的本机 beta。

### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
