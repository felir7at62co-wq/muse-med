# Agent Note: The drama gate binds evidence to the operation's own project

Status: implemented

[English](2026-09-22-drama-gate-binds-evidence-to-the-operation.md) | 中文

## Problem

短剧门禁的两条项目规则——付费分镜提交前必须有正式资产、新建计费资产前必须有新鲜对账——是通过扫描工作间里「任何合格的项目根」来找证据的。工作间里有两个项目时，项目 A 的 `assets_manifest.json` 或 A 的新鲜 `_probe/asset-reconcile.json` 因此能为属于项目 B 的付费调用背书；而一个根本没指名项目的调用，会被拿去和「恰好有证据的那个项目」比对。证据的含义与拒绝文案所说的不一致，而且拒绝文案会列出它考虑过的每个候选根，模型无从知道门禁究竟判定了哪个项目。

## Decision

`operationProject()` 解析一次操作唯一所属的项目，顺序是：插件配置注入的 `projectRoot`，其次是调用自己的 `project_dir`，再次是工作间里 `project_config.json` 声明了本次调用 `script_id` 的那个子项目。两条规则都只读那个项目下的证据，并且都会拒绝「放不到具体项目上」的付费调用，同时给出 `project_dir` 与 `script_id` 两种绑定方式。

解析放在规则里而不是靠参数补齐：`jubian_video.image_generate` 自己的 schema 本来就要求 `script_id`，`jubian_storyboard` 也本来就接受 `project_dir` 与 `script_id`，所以每条拒绝要的都是调用方能传的参数。

会话未给出工作目录、部署也没配置回退时，绑项目的付费调用现在会被拒绝而不是放行——没有根目录既无法相对解析 `project_dir`，也没有可搜索 `script_id` 的地方；内容规则仍然放行，因为一个门禁无法归类路径的 `write` 或 `edit` 本就没有可判定的产物。

## Alternatives considered

**把对账报告自己的 `script_id` 与正在写入的项目比对。** 报告确实带这个字段，但它的写出方是生产项目目录里的 `_tools/asset_reconcile.py`，不在本仓库，因此身份比对会拒绝来自「本门禁无法查看的写出方」的报告。这项改为记在包 README 的限制里。

**从工具自己的状态推导项目——分镜的 `scriptId`、任务行的项目 ID。** 两者都需要一次网络读取，而拦截器刻意是同步且只读的，不声明任何服务依赖；绑定必须来自调用本身。

**当工作间下只存在一个项目时，允许未绑定的调用。** 读起来很方便，而且一旦出现第二个项目就会静默出错——那正是这次改动要处理的场景。拒绝只花一个回合，并且把绑定方式教给模型。

**保留搜索，只在本项目有证据时优先。** 优先级顺序仍然会让兄弟项目的证据决定判定结果，模型也仍然不知道被判定的是哪个项目。

## Consequences

两条项目规则的放行侧现在都依赖调用携带 `project_dir`，或携带一个被工作间下某个 `project_config.json` 声明的 `script_id`；门禁测试把该配置建进夹具读取器，因此一个用例会同时声明调用指名的项目与它必须在那里找到的证据。

拒绝文案重新只指认一个项目，这正是模型区分「这个项目没有正式资产」与「门禁根本放不下这次调用」的依据。

残留限制有两条：门禁信任调用方自己的绑定——一个指名项目 A、但 `storyboard_id` 属于项目 B 的调用会被按 A 判定；以及它不拿对账报告与所在项目比对。两条都记在包 README 的限制中。
