# Agent Note: 每次升 Host 版本都要重新复核钉住的社区插件

Status: implemented

[English](2026-09-26-community-plugin-host-version-review.md) | 中文

## Problem

只要 checkout 的 Host 版本与这些补丁当初被复核时的版本不一致，[`build.mjs`](../../../../third_party/plugins/build.mjs) 就拒绝编译这五个钉住的社区插件，而且不提供任何覆盖开关。`release(dsh): 0.1.6-alpha.2` 这次升版本把 305 个 manifest 全部移出了那个版本，于是 `pnpm run package:desktop:win:x64:unsigned` 的 S6 步以 `community plugins: host 0.1.6-alpha.2 needs a new compatibility review` 停下，没有产出任何安装包。这个拒绝是对的——各补丁会把 Host 版本写进 Codex 运行时的允许列表、写进 peer 候选，也写进 `SOURCE.json`——但仓库里没有任何地方说明「一次复核」到底要覆盖什么，所以这次发布既走不下去，也拿不出这五个插件能在 `0.1.6-alpha.2` 上工作的证据。

## Decision

闸门现在把 `0.1.6-alpha.2` 记为已复核版本，而这个版本在它到达的每一处产物上各写一次：[`build.mjs`](../../../../third_party/plugins/build.mjs) 里的闸门、[`checks/codex-subagent.mjs`](../../../../third_party/plugins/checks/codex-subagent.mjs) 里的 `approvedVersion` 与过期版本列表、[`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) 里的 peer 后缀与补丁期望，以及 [`README.zh.md`](../../../../third_party/plugins/README.zh.md)（及其 `README.md` 英文侧）、[`dsh-ponytail/README.md`](../../../../third_party/plugins/dsh-ponytail/README.md) 中的版本陈述。上游固定项一律不动：[`sources.json`](../../../../third_party/plugins/sources.json)、[`upstream.json`](../../../../third_party/plugins/upstream.json)（其 `pinnedVersion` 是上游合并基线，不是产品版本），以及上游保留的 `compatibility.json`（它本来就把 `0.1.6-alpha.2` 列为 preview）。此外，[`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) 还补上了它自己的可复现比较后来暴露出的两条要求：两次构建的目录深度必须相同，以及按摘要先行比较字节。

今后每次升 Host 版本，都在打包之前重跑同一套复核；有一项检查失败就停下这次发布，而不是放宽期望。闸门保持硬相等：升版本不能把从未针对该 Host 编译过的插件发出去。

## The review that accepted 0.1.6-alpha.2

每个钉住的插件都用 `node third_party/plugins/build.mjs --only <name> --out <dir>` 单独构建：`dshmarket`、`dsh-ponytail`、`dsh-lark-bridge`、`dsh-ffmpeg` 未经改动即 exit 0；`dsh-codex-subscription` 第一次 exit 1，且只挂在三条断言上，三条全部由 `approvedVersion` 拥有（`inspectSubagentRuntime` 的拒绝列表、fixture 的 manifest 版本、以及被断言的安装目标）——这正是复核要移动的那个常量。

随后暂存的 Codex 运行时跑了它的副本检查加三套保留的上游用例——共 32 个用例，含 26 项上游检查与 6 项认证传输及 CLI 检查——FFmpeg 源码跑了 89 项保留检查。

### 可复现比较栽在它自己的目录布局上

[`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) 随后把五个插件各再构建一次，逐字节比较每一对压缩包。这个比较失败了，而失败原因**不是**插件不兼容：测试把第二份构建放进 `<第一份输出>/repeat`，比第一份深了一级。`build.mjs` 每次构建都在 `--out` 之内新建一个 `.source-build-*` 暂存目录，并用 junction 把工具链链进去；rolldown 会把每个源文件的路径按相对于产物文件的形式记进 `//#region` 注释，而经 junction 解析后这条路径变成相对于暂存目录，于是更深的 `--out` 让每条注释都多出一个 `../`。在这个布局下，任何两次构建都不可能逐字节一致，与 Host 版本无关。改成两个同级的 `mkdtempSync` 目录——深度相同——五个插件都复现出逐字节一致的压缩包，连测三次皆然。

### 失败的断言把自己的真因埋掉了

这次复核最先报出的错误是 `RangeError: Array buffer allocation failed`，而不是字节差异：`assert.deepEqual` 比较两个约 295 KB 的 Buffer，一旦不同就会渲染完整 diff，而先失败的正是这段 diff 的分配；FFmpeg 那个用例随后在同一个耗尽的内存上以 `status=null (3221226505)` 崩溃。现在比较改成先算摘要：先比长度，再比 SHA-256，并把两个摘要都写进失败信息。失败的断言本身就是一种报告机制，而它报出的是分配错误，不是它抓到的缺陷；比较大体积产物时，报告必须用报告者承担得起的形式给出结论。

## Testing

`node --test third_party/plugins/build.test.mjs` 就是这五份钉住源码的全部复核；闸门加上 Codex 与 FFmpeg 的用例数就是它的通过判据，必须在打包恢复之前 exit 0。构建脚本读取 `npm_execpath`，所以要在 pnpm 生命周期脚本里跑，或把该变量设成 pnpm 的入口文件——单独用 `pnpm exec` 不会导出它，此时每个子构建都会在任何检查开始之前以 `invoke through pnpm exec node third_party/plugins/build.mjs` 失败。真实的失败与坏掉的测试装置都表现为非零退出，所以红的时候要先诊断，再怪插件：这一次插件全部编译通过、保留检查全绿，反倒是读取它们产物的那个比较本身不可用。

## Alternatives considered

**用环境变量覆盖期望版本。** 这样发布可以在一个插件检查都没跑的情况下过闸门，而且仓库里不会留下任何「复核过哪个版本」的记录。已复核版本必须是一次可评审的改动，不能是发布期的一个设置。

**接受任意 `0.1.6-alpha.*` 的 Host 版本。** 补丁把 `SUBAGENT_RUNTIME_VERSION` 与 `SUPPORTED_RUNTIME_VERSIONS` 钉在它被编译时的 Host 版本上，所以相邻版本恰恰是这条相等检查存在要拒绝的情况。

**在检查里从 Host 版本推导已批准版本。** 那样检查就是拿暂存运行时跟自己比，永远报不出「某个 Host 不受支持」，而这正是 Codex 插件自己的允许列表所依赖的唯一失败信号。

**只改常量、不重跑插件检查。** 编译与保留用例是「补丁仍能套在未变的上游文本上」的唯一证据；跳过之后，闸门断言的是一次从未发生的复核。

**把闸门放宽成警告。** 打包就会静默发出一个未经复核的运行时允许列表，而失败只会在用户装完之后才浮现。

**保留嵌套的输出目录，改成比较压缩包内容。** 解包后比较成员清单在两种布局下都能过，但它不再证明构建可复现，而这正是这个比较存在的意义；有缺陷的是布局，不是字节比较。同深度的同级目录既保住了原断言，也保住了它的强度。

**保留 `assert.deepEqual`，只把堆上限调大。** 那样断言只有在内存够用时才会报出 295 KB 这一对的 diff，诊断能力就取决于机器了；而且把字节差异换成分配错误的，正是内存耗尽本身，不是上限。

## Consequences

升一次 Host 版本现在是一次会阻塞打包、直到整套复核通过的代码改动，这正是应有的代价：另一种结果是安装包带着没人编译过的插件与运行时组合发出去。下一次升版本——例如上游 `0.1.7-rc.2` 合并落地之后——重跑这套流程，针对新的 Host 重跑 `node --test third_party/plugins/build.test.mjs`，并改写同样的五处。

这套复核证明的是钉住的源码仍能在该 Host 上编译、通过各自的保留检查，并且两次干净构建逐字节一致；它不证明某个插件在打包后的桌面 Profile 里被激活——那仍是打包冒烟与已安装应用的职责，[源码快照提案](../../../proposed/process/2026-09-23-muse-med-community-plugin-source.md)对此已有记录。
