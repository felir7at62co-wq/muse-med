# Agent Note: 把产品能力放在正确的平面上，以及移植途中踩到的坑

Status: implemented

[English](2026-09-17-product-capability-plane-and-port-traps.md) | 中文

## Problem

一个要替换文件系统、spill、roster 与浏览器外壳行为的产品，最初被做成一串挂载在运行中会话里的临时动态 Cordis 插件。这种做法无法交付。用户直接否决了它，移植因此改为：由 workspace 包承载，并经由 profile 配置行组装。

重写本身也让这次移植在同类陷阱上花掉数小时：能力写在了它无法生效的平面上；一次 live patch 重载让已经物化的会话搁浅；一个逐 agent 边界是按会话后来离开的那个 preset 只算了一次；以及构建或解析设置静默失败而不是响亮报错。以下每个坑都记录了识别它的证据与清除它的恢复方式。

## Decision

**产品能力以持久包加配置行的形式交付，绝不以临时动态插件的形式交付。** 动态插件（本 harness 中的 `cordis_define` 与 `cordis_run`）只存在于运行中的进程里：它无法随产品被评审、版本化、发布或回滚，并且会在重启后消失。它可以用于某个会话内的一次性实验，绝不能用于部署所依赖的任何东西。

本次移植把产品交付为 [packages/bundle/muse-product](../../../../packages/bundle/muse-product)（Host 配置行、preset、工具面）与 [packages/client/muse-browser](../../../../packages/client/muse-browser)（浏览器半边），由 profile 的 `bundles` 列表与组合包自身的 `cordis.patch.yml` 组装，并把决策记录为 Agent Note、把契约记录为包规格。需要触达另一个实时会话的修复属于 harness 核心的补丁，而不属于插件。

### 服务属于 Host 平面；preset 只贡献逐会话能力

发布服务的配置行属于 Host 组装，或者当某个 preset 确实拥有该服务时，属于一个 `isolate` realm。agent preset 只贡献逐会话能力：工具、提示词段落、skill，以及经由 agent 作用域链解析的 projection。

各 preset 之间不继承彼此的配置行。每个 preset 只挂载一次，形成自己的常驻组装（[`AgentPresets.mount`](../../../../packages/preset/agent-presets/src/index.ts)），而一个 agent 把自己的作用域键挂到该挂载的键上，从而恰好加入其中一个。子 agent 加入其父方已有的那一代（[`composeFrom`](../../../../packages/preset/agent-presets/src/index.ts)，另见[子 agent 加入其父方的 preset](../bug-fix/2026-08-10-child-agents-join-their-parent-preset.zh.md)）；它绝不会去组装第二个 preset 的配置行。

因此，必须*替换* Host 服务的产品只能从组合包的补丁层做到这一点。preset 配置行根本无法发布根 realm 服务：[`mountPreset`](../../../../packages/preset/agent-presets/src/mount.ts) 会审计所挂载的子树并以 `row(s) published process-global service(s) [names]; a preset service must sit behind an isolate realm or move to the host composition` 拒绝它。当一次接管式移植需要自己的 `fs`、`spill`、preset registry 或整个浏览器外壳时，替换用的配置行放在组合包的 `cordis.patch.yml` 中，而产品的逐会话能力放在它的 preset 中。归属判据见[当 preset 拥有 agent 平面之后，什么留在 Host 平面](2026-08-10-host-plane-ownership-after-presets.zh.md)。

### 一次 live 的 Host 平面 patch 重载可能让运行中的会话搁浅

`dsh.profile.patchReload: live` 把 Host 平面 patch 应用到已经运行中的 Host；`startup` 只在启动时应用一次（[apps/cli/reference/README.zh.md](../../../../apps/cli/reference/README.zh.md)、[packages/boot/app-boot/src/profile.ts](../../../../packages/boot/app-boot/src/profile.ts)）。随附的 `web` profile 默认就是 `live`，自定义 profile 省略该值也保持 `live`。

在运行中的会话之下改动 Host 平面配置行，可能让该会话留下一个被抽走一半的工具组装：preset 提供的工具消失，而 Host 平面的工具留下，因为该 agent 的组装早已物化，其作用域父级不再抵达一个仍然存活的组装。之后重启 Host 也无法治愈该会话：它的工具视图通过那个已发布 agent 所持有的作用域链解析，而重启不会重新组装任何正在运行的会话。`AgentPresets.select` 出于同样理由陈述了同一条规则：已经开始过的会话保留其历史被产出时所用的组装。

由此得出两条规则。组合变更优先做冷重启。切勿在你自己所依赖的会话正在运行时编辑 live profile patch。

### 无需插件的恢复方式

一个在其加入尚可解析时加入过 preset 的会话，可以通过重新链接该 agent 的作用域父级来重新加入，而这正是 preset registry 的 `recompose` 所做的事：它通过 roster 保留下来的 binding 重新链接、确保常驻挂载存在，并发布 `tools/change`，让 agent 自有的 overlay 与新祖先关系重新对齐。

有两条受支持的路径可以走到这一步。在 GUI 中为该会话选择另一个 preset 会调用 `AgentPresets.select`，它会重新组装该 agent 并记录这次选择；而再次选择该会话自己的 preset 在客户端是空操作，因为[席位存储](../../../../packages/client/ui-agent-preset/src/client/seat-store.ts)在待选 id 已等于该会话 id 时提前返回。更宽的那条路径是新建会话，它在创建时重新组装自己的 preset。

两条路径都要求该会话尚未产出任何内容：`select` 先读取会话的轮次边界，并以 `agent-preset/locked`（`session "<id>" has already started; its agent preset is fixed`）拒绝一个已经开始的对话。因此，已经在进行中的对话没有原地恢复的办法；它的能力会在新会话中回来。至于底层缺陷的持久修复——live 重载撤走了 Host 平面的配置行，却没有为已经物化的 agent 重新注册它们——属于 harness 核心针对重载路径的补丁。

### 只在 agent 创建时算出的边界撑不过一次 preset 切换

一个只按 agent 创建时所用 preset 推导一次的逐 agent 边界，在该 agent 运行另一个 preset 的那一刻就已经过期。会话可以先按部署默认 preset 创建，之后再切到目标 preset：`AgentPresets.select` 会重新挂上该 agent 的作用域键、确保目标常驻挂载存在，并发出 `tools/change`（[packages/preset/agent-presets/src/index.ts](../../../../packages/preset/agent-presets/src/index.ts)）。它不会重新发出 `agent/created`，因此只挂在创建事件上的监听器永远不会重新求值。

实测后果：一个被切进产品 preset 的会话，其 schema 视图里仍然列着 `write` 与 `edit`，并且经由它的一次 `write` 调用成功了。该边界是按会话创建时所用的 preset 算出来的。

请从*当前*组装出的 preset 推导逐 agent 权限，在组装变化时重新求值，并在装入新限制的同时退役上一条。受支持的形状是一个由 `tools/change` 驱动的对账函数，按 agent 各持一条限制：

```ts
// One restriction per agent, recomputed from what the agent composes NOW.
const masks = new Map<Agent, () => void>()
const reconcile = (): void => {
  for (const agent of ctx.agents.list()) {
    const composed = ctx.agentPresets.composedPreset(agent.ctx)
    const candidates = ctx.tools.schemas(agent.ctx).map(tool => tool.name)
    masks.get(agent)?.()          // retire the previous mask before installing the next
    masks.set(agent, ctx.tools.restrict({ deny: denyFor(composed, candidates) }))
  }
}
ctx.on('tools/change', reconcile)
```

`tools.restrict()` 的掩码取交集，并返回只解除它自己的那个精确 disposer，因此一条留在原地的过期掩码会继续拒绝新组装所允许的东西（[packages/core/tools/src/index.ts](../../../../packages/core/tools/src/index.ts)）。在收到通知时重新计算，树内先例是 [browser-use-runtime](../../../../packages/experimental/browser-use-runtime/src/mcp.ts)：它按 agent 持有一个掩码作用域，在 `refreshBlockedMasks` 里按该 agent 当前视图重新算出被拒绝的名字，并从 `ctx.on('tools/change', …)` 重新运行它。

### 带提前返回的表查找是一个静默的边界漏洞

移植把它的守卫写成「拿会话的 preset 去产品自有的 preset 表里查；表里没有条目就什么都不做」。于是表里没提到的每一个 preset 都是无守卫的，而部署默认 preset 永远是其中之一，所以产品的限制恰好没有作用在它尚未枚举的那些会话上。「凡不是我们的一律拒绝」这条规则必须显式写出这一情形，并且必须失败关闭。只要守卫用表查找解析某个东西并把缺失当作「无事可做」，同一形状的漏洞就会出现：缺失意味着无守卫，而不是在别处已被允许。

### 组合包与配置行

列在 `dsh.profile.bundles` 中的包贡献它的补丁层。把同一个包作为配置行插入时，挂载该插件却*不带*那一层（[packages/util/package-manifest/src/types.ts](../../../../packages/util/package-manifest/src/types.ts)，以及 [profile.ts](../../../../packages/boot/app-boot/src/profile.ts) 中的层应用逻辑）。组合包通过 `dsh.bundle.patch` 声明该层，而这一层可以禁用、重配置与插入配置行，因此一个包能同时服务接管式部署与合并式部署。正是这一区别让 [muse-product/cordis.patch.yml](../../../../packages/bundle/muse-product/cordis.patch.yml) 既禁用 `agent-presets`、`fs-sandbox` 与 `spill-local`，又把 `muse-agent-presets` 作为 Host 配置行、把 `@deepseek-ai/dsh-client-muse-browser` 作为客户端配置行插入；而合并式部署则一次只挂载它想要的那些配置行。

### `./typert` 导出必须在聚合 tsconfig 中登记

Typert 生成器通过遍历 `tsconfig.host.json` 与 `tsconfig.client.json` 的项目引用发现候选包：[`WorkspaceAnalyzer.loadRegistrations`](../../../../packages/typert/generator/src/analyzer.ts) 读取 `aggregate.parsed.projectReferences`，只保留 `packages/` 下的条目，并忽略这些列表之外的每一个包。因此，一个导出 `./typert` 却没有登记为被引用项目的包什么都不会生成，而构建仍然报告成功，其 manifest 所声明的 `lib/typert.host.js` 从未存在。请在同一次改动中把该包项目加入聚合 solution（[tsconfig.host.json](../../../../tsconfig.host.json) 中的 `{ "path": "./packages/bundle/muse-product" }`）。

当前 DSH 中的 codec 字段是 `create`。由更早的 fork 生成、产出 `schema` 的产物会在加载时以 `parameter codec has no create() factory` 失败（[packages/typert/loader/src/index.ts](../../../../packages/typert/loader/src/index.ts)、[packages/typert/registry/src/service.ts](../../../../packages/typert/registry/src/service.ts)）；生成器那条路径报告同一原因是 `has no create() factory`。

### profile 解析可能加载另一个 checkout

`$DSH_HOME/profiles/<name>/node_modules` 在解析上优先于 checkout，而它的条目是 junction；一个陈旧条目完全可能指向另一个 checkout。于是 profile 自有的那份副本会静默地取代你刚编辑过的包被加载，之后每一次观察描述的都是错误的目录树。在排查任何其他东西之前，先打印实际被加载模块的解析路径：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai" |
  ForEach-Object { "$($_.Name) -> $((Get-Item $_.FullName -Force).Target)" }
```

这也正是移植会刻意利用的机制：profile 的 junction 可以指向正在开发的 checkout，本地构建的产品包就是靠它抵达运行中的 profile，而不必发布。

### 请求期清单解析不到的配置行失败在轮次上，而不是挂载上

`dsh_plugin_packages`——由 [`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../../../../packages/llm/plugin-package-inventory-deepseek) 贡献的工具，在基础组合包（[packages/bundle/base/cordis.patch.yml](../../../../packages/bundle/base/cordis.patch.yml)）中默认启用，因此每个 DeepSeek 请求都会运行——通过 `PackageIdentityResolver.resolve()` → `barePackageManifest(packageName, anchors, this.packages)` 解析**每一个**已激活 Loader 条目所属的包，而后者会从 **profile 目录的 `node_modules`**（`$DSH_HOME/profiles/node_modules`）开始遍历 `createRequire(parentURL).resolve.paths()`。激活该行的 Loader 走的却是另一条路径：因为应用是以源码方式启动的（`tsx`），它用的是 `tsconfig.base.json` paths 映射；两条路径一声不响地互相矛盾，于是插入 profile patch 的配置行正常挂载，而插件包清单看不到它。

症状不是挂载错误，而是一次失败的模型请求：`plugin-package-inventory-deepseek: cannot resolve active package "<name>"`。实测案例把 `@deepseek-ai/dsh-composition-guard` 插入 `C:\Users\EDY\.dsh\profiles\web\cordis.patch.yml`；用解析器自己的函数做的 A/B 检查显示，恰好那一个包是 MISSING，而在 junction `C:\Users\EDY\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard` → `E:\deepseek-harness\packages\guard\composition-guard` 存在之后每个包都是 FOUND（该 profile 组装共 164 行；只有那一行失败）。任何被 profile patch 插入的包都必须能从该 profile 的 `node_modules` 解析到；[组合守卫 Agent Note](2026-09-17-composition-guard-detects-live-tool-withdrawal.zh.md) 记有安装规则、确切命令，以及找回客户端半边的那次诊断——Cordis 的客户端模块加载器会吞掉插件真实的错误，因此浏览器只报告 `Failed to load plugins: <id>`，只有通过 CDP 包裹 `window.__ModuleLoader__.load` 才拿回了真正的错误。

### 构建顺序与逐包构建

Host 构建是 `tsc -b tsconfig.host.json`，随后是 `tsdown --env.DSH_BUILD_FACE host`（[package.json](../../../../package.json)），而 tsdown 的 entry 是 `lib/types/{index,invariant,startup}.js`（[tsdown.config.ts](../../../../tsdown.config.ts)）。必须先跑 tsc：改完源码只跑 `tsdown` 打包的是上一次编译的产物，静默地什么都没改变。

客户端包的 bundle 配置名为 `<package>/client`（[packages/client/tsdown.client.ts](../../../../packages/client/tsdown.client.ts)），因此按包名过滤只构建它的 node 半边。node 半边还必须逐包重述，因为包级 `tsdown.config.ts` 会替换根 workspace 布局。客户端包请使用仓库的完整构建，或显式加上 client face。

绝不要透过陈旧构建去调试插件。移植对权限边界的第一次探测读到的 `lib/index.js` 是 15:14 的，而 `src/index.ts` 在 15:32 已被编辑；这份陈旧产物给出了一个自信但错误的机制，纠正它的代价超过了那次重建本要花的代价。请把产物的修改时间与大小记录在任何探测证据旁边，并在得出结论之前重建：

```powershell
Get-Item packages/bundle/muse-product/src/index.ts, packages/bundle/muse-product/lib/index.js |
  Select-Object FullName, LastWriteTime, Length
pnpm run build:lib:host    # tsc -b tsconfig.host.json, then tsdown --env.DSH_BUILD_FACE host
pnpm run build:lib:client  # tsc -b tsconfig.client.json, then the client face
```

### 一览表

| 陷阱 | 证据 | 规避 |
|---|---|---|
| 能力写在错误的平面上 | `mountPreset` 拒绝根 realm 服务；preset 之间从不继承配置行 | 服务放在 Host 组装或 `isolate` realm；替换 Host 配置行用组合包补丁层 |
| live 重载让运行中的会话搁浅 | `patchReload: live`；已物化的 agent 组装 | 组合变更做冷重启；切勿编辑会话所依赖的 live patch |
| 边界只在 agent 创建时算出 | `select` 重新挂上作用域并发出 `tools/change`，从不发出 `agent/created`；切换后一次 `write` 调用成功了 | 从当前组装出的 preset 推导，并在 `tools/change` 上对账，同时退役上一条限制 |
| 守卫的表查找提前返回 | 部署默认 preset 不在产品的 preset 表里 | 把「凡不是我们的一律拒绝」显式写出，并失败关闭 |
| 用陈旧产物得出结论 | 探测读到 15:14 的 `lib/index.js`，而 `src/index.ts` 在 15:32 被编辑 | 探测证据旁记录产物 mtime 与大小；先重建 |
| 作为配置行挂载时缺少组合包补丁层 | `dsh.profile.bundles` 映射到 `dsh.bundle.patch` | 需要该层时就把包列为组合包 |
| `./typert` 产物从未生成 | `loadRegistrations` 遍历聚合引用 | 把该包项目登记进聚合 tsconfig |
| 由旧 fork 生成的 codec 加载失败 | `codec has no create() factory` | 用当前生成器重新构建产物 |
| 陈旧的 profile junction 加载了另一个 checkout | `$DSH_HOME/profiles/<name>/node_modules` 在解析中优先 | 排查前先检查解析路径 |
| 请求期清单解析不到的 profile 配置行 | Loader 经 `tsconfig.base.json` paths 挂载，而 `dsh_plugin_packages` 走 `$DSH_HOME/profiles/node_modules`；`cannot resolve active package "<name>"` | 让插入的每个包都能从该 profile 的 `node_modules` 解析到（junction 指向 checkout） |

## Alternatives considered

**把修复作为临时动态 Cordis 插件交付。** 被用户否决，而其理由是结构性的而非风格性的：动态插件只存在于运行中的进程里，因此无法随产品被评审、版本化、发布或回滚，并且会在重启后消失。它还挂载进组合而非挂载它的那个会话，这让一个会话自有的修复即使在能用的时候也是错误形状的修复。

**把产品的逐会话能力留在 Host 组装中，使接管式部署不需要补丁层。** 否决，因为它颠倒了 preset 所确立的归属规则：面向模型的能力属于 agent 平面，由 preset 决定它的会话能做什么；同一批工具在 Host 平面的副本会对进程中每个会话可见。

**只记录 live 重载的风险，而不改动重载路径。** 只作为过渡状态接受。上面的恢复方式是用户今天能做的事，而持久修复是核心改动：为已经物化的 agent 重新注册被撤走的 Host 平面配置行；记录它只是一份注记，不是修复。

**让 `tools.get` 在类型层面拒绝 Agent。** 有吸引力但超出范围。`ScopeKey` 是刻意不透明的，堵上这个洞会改变 `schemas`、`get` 与 `presentAs` 的所有调用方共享的公开签名。把 Agent 传进本该是作用域键的位置确实是真实风险，但它并不是这次移植权限缺口的原因：实测的边界是按错误的 preset 算出来的，而那条限制本身拒掉了 11 个具名工具中的 10 个。类型层面的问题仍然开放且彼此独立。

**把权限缺口解释成空拒绝列表。** 记录它，是因为它先被相信、后被证伪：作用域解析取不到东西从而静默清空了过滤器的说法经不起测量，而一份把貌似合理的机制置于实测机制之上的 Agent Note，会教下一个人去相信错误的信号。此处记录的成因是探测所支持的那一个，而探测所用的构建也被一并记录，出于同样的理由。

## Consequences

平面规则要移植多付一次包拆分的代价。替换 Host 行为的产品需要一个带补丁层的组合包和一个承载浏览器半边的客户端包，而只有它的逐会话能力可以留在自己的 preset 中；回报是同一个包同时服务接管式部署与合并式部署，并且每一行都留在仓库中可被评审。

动态插件仍是一次性会话实验、以及对运行中进程做旁路观察的正确工具。它们不是交付通道，而用户对其中一个的否决把这条边界从惯例变成了明文。

上述这些坑现在只花分钟而不是小时，而其中四个静默失败的坑——按会话后来离开的 preset 算出的边界、表查找提前返回的守卫、`./typert` 包未登记进聚合 solution，以及请求期清单解析不到的 profile 配置行——都记录了识别它们的证据或确切字符串，好让下一个人立刻认出它们。权限缺口那个被误信的成因与实测成因记录在一起，因为一个自信的错误机制比没有机制代价更高。live 重载缺陷仍留在核心中且没有承诺的归属者；在它被修复之前，失去组装的会话只能在仍为空会话时通过重选 preset 恢复，或者通过新建会话恢复。
