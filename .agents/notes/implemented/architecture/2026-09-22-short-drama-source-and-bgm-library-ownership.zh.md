# Agent Note: 短剧运行源码与 BGM 音频由维护包拥有

Status: implemented

[English](2026-09-22-short-drama-source-and-bgm-library-ownership.md) | 中文

## Problem

短剧流水线此前跑在一个独立的开发根目录下：技能放在本机 `.dsh/skills` 安装目录，BGM 情绪插件放在无关的 git worktree，分析用的 Python 环境和模型权重放在那个项目里，60 首曲库只以单机文件形式存在。本仓库没有任何包拥有其中任何一项，因此干净检出无法复现该流水线，音乐在别处也完全取不到。同样的割裂让打包缺陷得以存活：插件的 npm 白名单漏掉了 `lib/index.js` 运行时导入的 `lib/worker.js` 与 `lib/config.js`，Python worker 还把和弦与调性中间文件写进自己的安装目录。

## Decision

BGM 情绪插件的维护源码位于 [`packages/perception/perception-bgm`](../../../../packages/perception/perception-bgm/README.zh.md)。它的 npm 白名单现在列出每个运行时文件，worker 把中间文件写入私有临时目录，两个 Hugging Face 加载器都冻结 MERT revision。云端配置可选且默认关闭：未设 `catalogUrl` 时仍读本地索引，`match` 从不下载。`download` 是唯一抓取音频的方法，发布缓存条目前校验大小与 SHA-256。

[`packages/drama/skills`](../../../../packages/drama/skills/README.zh.md) 以 `@deepseek-ai/dsh-drama-skills` 拥有短剧技能资源。它只带当前技能使用的源码、参考文档和静态资源；GUI 前端、已退役应用的辅助模块及其独立状态链、可执行文件、逐项目媒体、凭据和缓存都不进入，`maintenance/excluded-sources.json` 逐条记录每项排除及原因。清单逐文件列出分发内容，当技能文件存在而清单缺项时打包检查会失败。渲染器需要的两份片尾素材是唯一的媒体例外（[片尾素材](2026-09-22-bundle-the-renderer-ending-media.zh.md)）。

操作者授权公开分发的 60 首曲目是同一 bucket origin 下的内容寻址对象，索引位于 `/bgm/index.json`。发布先按索引校验每个本地源文件再上传，只创建缺失对象，对每个公开下载核对大小与 SHA-256，最后才写索引。凭据只来自一条 DSH 托管凭证记录，不进入源码或发布输入；已存在但字节不同的对象会被拒绝而不是覆盖。

## Alternatives considered

**把技能留在本机安装目录。** 它们本来就在那里维护，也不需要改仓库。但这样它们没有离线回归、没有可审查的白名单，也无法区分个人改动与维护源码。

**整树搬入本机技能目录。** 整体复制会带进凭据文件、浏览器登录态、缓存、可执行文件和用户媒体，并保留那些导入本仓库并不存在的应用状态链的退役辅助模块。

**音乐留在本地、只提交索引。** 索引很小，音频不是，而把所有消费者指向单机磁盘会让流水线无法复现。发布音频还需要明确的分发答复，操作者已对这些曲目给出，但该答复不延伸到模型。

**把 Python 分析栈一起打进插件。** Torch 与模型权重有数百 MB，MERT 骨干是非商业许可，而日常匹配两者都不需要。默认打包会把这份体积和这份许可强加给每一次安装。

## Consequences

匹配与音频下载是纯 Node 工作：不需要 Python、不需要模型权重、也不涉及非商业依赖，且无需上传密钥即可访问。情绪分析仍是显式可选路径，仍需要装有固定 CPU 依赖的 Python 环境，插件提供源码而不提供解释器。

`SOURCES.md` 分别记录三项许可事实：适配层与 Music2Emotion 源码是 MIT，现有副本无法确定其上游 revision；m-a-p/MERT-v1-95M 骨干是 CC-BY-NC-4.0，仅限非商业用途；已发布曲目是操作者确认可公开分发的音频。三者互不重新授权。

本地开发根目录仍是操作者自有数据的归处 —— 项目、历史资产库和用于对照的依赖版本 —— 但已不再是这些包的运行时依赖。[独立产品决策](2026-09-23-muse-med-independent-desktop.zh.md)负责 Desktop 账号隔离及其生产预设。
