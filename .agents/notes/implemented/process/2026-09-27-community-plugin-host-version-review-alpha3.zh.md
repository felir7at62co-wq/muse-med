# Agent Note: 接受 0.1.6-alpha.3 用于钉住的社区插件

Status: implemented

[English](2026-09-27-community-plugin-host-version-review-alpha3.md) | 中文

## Problem

`release(dsh): 0.1.6-alpha.3` 把 305 个 manifest 全部移出了这些社区插件补丁当初被复核时的 Host 版本，于是 [`build.mjs`](../../../../third_party/plugins/build.mjs) 在 `pnpm run package:desktop:win:x64:unsigned` 的 S6 步以 `community plugins: host 0.1.6-alpha.3 needs a new compatibility review` 停下，这次运行没有产出安装包。这个停下正是 [alpha.2 那轮复核](2026-09-26-community-plugin-host-version-review.zh.md)设计的机制：闸门没有覆盖开关，而「已复核版本」在补丁到达的每一处产物上各写一次。在针对 `0.1.6-alpha.3` 复核完这五份钉住的源码之前，打包无法恢复。

## Decision

`0.1.6-alpha.3` 是已复核版本，写在 alpha.2 那轮确立的同样五处：[`build.mjs`](../../../../third_party/plugins/build.mjs) 里的闸门、[`checks/codex-subagent.mjs`](../../../../third_party/plugins/checks/codex-subagent.mjs) 里的 `approvedVersion` 与过期版本列表、[`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) 里的 peer 后缀与补丁期望，以及 [`README.zh.md`](../../../../third_party/plugins/README.zh.md) 及其 `README.md` 配对、[`dsh-ponytail/README.md`](../../../../third_party/plugins/dsh-ponytail/README.md) 中的版本陈述。过期版本列表新增 `0.1.6-alpha.2`，并保留 `0.1.6-alpha.1`；该列表写的是暂存运行时必须拒绝的版本，所以已批准的版本不会出现在里面。上游固定项一律不动：[`sources.json`](../../../../third_party/plugins/sources.json)、[`upstream.json`](../../../../upstream.json)（其 `pinnedVersion` 是上游合并基线，不是产品版本），以及上游保留的 `compatibility.json`。

## The review that accepted 0.1.6-alpha.3

闸门本身就是这五处之一，而且它在任何检查开始之前就拒绝构建，所以复核从移动它开始。只移动闸门时，`node --test third_party/plugins/build.test.mjs` 以 exit 1 结束，涉及一份源码与两条断言：暂存运行时现在报 `0.1.6-alpha.3`，而复制过来的 Codex 检查仍期望 `0.1.6-alpha.2`，于是 `reads the unpacked CLI manifest before composing its physical wrapper path` 以 `Codex subtask runtime is not prepared` 失败，`runtime preparation targets the same exact approved product provider` 以 `actual '0.1.6-alpha.3'` 对 `expected '0.1.6-alpha.2'` 失败。这两条断言都归 `approvedVersion` 所有。没有任何补丁在上游源码文本上失败，也没有别的源码失败。

把其余四处也移动之后，同一条命令 exit 0：三个用例全过，暂存的 Codex 运行时 32 项检查全过（26 项保留的上游检查，加 6 项认证传输与 CLI 检查），FFmpeg 源码 89 项全过。随后每份源码单独构建：

```sh
pnpm exec node third_party/plugins/build.mjs --only <name> --out <dir>
```

`dshmarket`、`dsh-codex-subscription`、`dsh-ponytail`、`dsh-lark-bridge`、`dsh-ffmpeg` 各自 exit 0，而 `build.test.mjs` 内部的可复现比较在两个同深度的暂存目录之间复现出五个逐字节一致的压缩包。

## Testing

`node --test third_party/plugins/build.test.mjs` 就是整套复核，它必须在打包恢复之前 exit 0；闸门加上 Codex 与 FFmpeg 的用例数就是通过判据。它读取 `npm_execpath`，所以要在 pnpm 生命周期脚本里跑，或把该变量设成 pnpm 的入口文件。上述五次单源码构建则是逐个插件的证据，证明打包步骤消费的压缩包是针对这个 Host 编译出来的。

## Alternatives considered

**把这五处常量改动本身当作整套复核。** 只移动版本号就打包，等于断言一次从未发生的复核；编译与保留用例是「补丁仍能套在未变的上游文本上」的唯一证据，而 Codex 允许列表那条断言正是用来报出「该插件不支持的 Host」的。

**让期望版本由 family 版本推导，或提供一个受控的「接受本版本」入口。** `build.mjs` 里的闸门本可以把 checkout 的 Host 版本与发布工具链已解析出的版本相比，并把复核结果记在发布流程读取的位置，而不是把版本号重复写在五个文件里、只能靠构建失败才发现。升两次版本已经各付过这笔成本，而仓库里没有任何地方为下一次列出这五处。本轮不做：已复核版本必须仍是一次可评审的代码改动，[alpha.2 那轮复核](2026-09-26-community-plugin-host-version-review.zh.md)既否决了环境变量覆盖，也否决了在 Codex 检查内部推导该值（那条检查必须仍能报出不受支持的 Host），而本轮的任务是接受一个版本，不是重新设计闸门。

**只复核 `dsh-codex-subscription` 这一份失败的源码。** 闸门不动就会拦住每一份源码，另外四份在 `SOURCE.json` 与构建重写的 peer 候选里带着同一个 Host 版本，而「没有变化」只有构建过才可观测。

## Consequences

打包恢复了，安装包带着的插件补丁是针对 `0.1.6-alpha.3` 编译的。反复出现的成本没有变：每次升 Host 版本手改五处版本陈述、没有清单可查、过期版本列表每轮多一个产品版本。上面草拟的推导方案就是本轮主张的改进；本轮没有实现它。

机制——闸门、一次复核要覆盖什么、以及同深度的字节比较——仍由 [alpha.2 那轮复核](2026-09-26-community-plugin-host-version-review.zh.md)拥有。本篇记录接受 `0.1.6-alpha.3` 的这一轮，并取代那篇中的版本陈述；那篇把 `0.1.6-alpha.2` 记为它那一轮的已复核版本。
