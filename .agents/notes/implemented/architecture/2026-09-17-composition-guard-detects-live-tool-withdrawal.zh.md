# Agent Note: 检测一次热加载撤走的工具，而不是重新组装它们

Status: implemented

[English](2026-09-17-composition-guard-detects-live-tool-withdrawal.md) | 中文

## Problem

在运行中的宿主之下改动 Host 平面组装，可能撤走一个已发布 agent 通过其作用域链解析到的工具。框架不会在进程内重新组装一个常驻挂载，因此对那个会话而言这次撤走是永久的：之后重启宿主也治不好它，因为该 agent 的工具视图通过那个已发布 agent 已经持有的作用域链解析。会话一旦跑过回合，重新选择它的预设就会被拒绝（`agent-preset/locked`，`session "<id>" has already started; its agent preset is fixed`）。

该缺陷及其实测证据记录在[移植陷阱 Agent Note](2026-09-17-product-capability-plane-and-port-traps.zh.md)中，那里也写明了如今可用的恢复方式：冷重启，或新建会话。那篇以这样一句收尾：持久修复——为已经物化的 agent 重新注册被撤走的 Host 平面配置行——属于 harness 核心，且没有承诺的负责人。

它留下未答的，是从撤走发生到有人察觉之间的那段空白。从受影响会话自身看，这个失败是静默的：模型只是不再拥有那些工具，而第一份证据通常是会话做不了某个请求。一个正在任务中途的用户既没有任何信号表明发生了什么变化，也无从把它与自己的失误区分开，更得不到一句"该怎么办"。

## Decision

**一个 Host 平面守卫包检测这次撤走，并用平实的话把它说出来。** 它以 [`packages/guard/composition-guard`](../../../../packages/guard/composition-guard) 交付，在 Host 组装里挂载一次：

```yaml
- name: '@deepseek-ai/dsh-composition-guard'
```

守卫不做任何修复，包 README 在说别的之前先说了这一点。

### 插入 profile 的配置行必须能从该 profile 的 `node_modules` 解析到

挂载配置行只是安装本包的一半。`dsh_plugin_packages`——由 [`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../../../../packages/llm/plugin-package-inventory-deepseek) 贡献的工具，在基础组合包（[packages/bundle/base/cordis.patch.yml](../../../../packages/bundle/base/cordis.patch.yml)）中默认启用，因此每个 DeepSeek 请求都会运行——通过 `PackageIdentityResolver.resolve()` → `barePackageManifest(packageName, anchors, this.packages)` 解析**每一个**已激活 Loader 条目所属的包，而后者会遍历 `createRequire(parentURL).resolve.paths()`。这次遍历的起点是 **profile 目录的 `node_modules`**（`$DSH_HOME/profiles/node_modules`），而不是 checkout。

一行被 profile patch 插入、却无法从该 `node_modules` 抵达的配置行会解析为 `undefined`，解析器随即抛出 `plugin-package-inventory-deepseek: cannot resolve active package "<name>"`——模型请求就此失败。加载时没有任何警告：以源码方式启动（`tsx`）时，Loader 是通过它本来就带的 `tsconfig.base.json` paths 映射解析同一行的，于是该行正常激活，而插件包清单看不到它，失败只在一次失败的轮次里浮出水面。

把 `@deepseek-ai/dsh-composition-guard` 插入 `C:\Users\EDY\.dsh\profiles\web\cordis.patch.yml` 复现了这个失败。创建 junction `C:\Users\EDY\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard` → `E:\deepseek-harness\packages\guard\composition-guard` 修好了它，而用解析器自己的函数做的 A/B 检查显示：修复前恰好那一个包是 MISSING，修复后每个包都是 FOUND——该 profile 组装共 164 行，没有别的行失败。

因此安装本守卫，与把任何包插入 profile patch 完全一样，是两步：挂载配置行，并让该包能从那个 profile 的 `node_modules` 解析到。对 workspace 包而言，这份可达性就是一条指向正在开发的 checkout 的 junction：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-composition-guard" `
  -Target "E:\deepseek-harness\packages\guard\composition-guard"
```

### 客户端真实的加载错误需要包裹后的 `window.__ModuleLoader__.load`

Cordis 的客户端模块加载器会吞掉插件真实的错误，浏览器只报告 `Failed to load plugins: <id>`——只有症状，没有原因。通过 CDP 包裹 `window.__ModuleLoader__.load`，并对目标模块的 `exports.apply` 做 try/catch，一次运行就暴露了真正的错误。

外壳会原地改写那个对象，因此只在 setter 里装一次的包裹器在下一次加载前就已消失：getter 必须**每次访问都返回一个新的 Proxy**。

### 基线来自观测，而运行中的宿主在激活时被观测

每个 agent 的基线，是它的作用域解析到的工具名集合——通过注册表对某个作用域的文档化枚举读取（`ctx.tools.schemas(scopeOf(agent.ctx))`，参数是 `ScopeKey` 而不是 Agent）——外加该 agent 在那一刻组装到的预设（`ctx.agentPresets.composedPreset(agent.ctx)`，以可选方式读取，因此无 roster 的部署也照常工作）。

有两条路径会记录基线。`agent/created` 在发布时记录一条，此时工厂的 setup 已经组装完该 agent 而尚无东西启动它。激活时会为**每一个已经存活的 agent** 记录一条，因为守卫的整个用例就是加入一个已经在运行的宿主：一个只为后来的创建记录基线的守卫，恰恰会对那个已经丢掉工具的长期会话视而不见。

被收养的基线就是守卫对该 agent 的第一次观测，因此守卫到达时就已经不完整的组装会被如实记录而**不予播报**。没有更早的观测可以称之为回归，而每次启动都触发的通知比沉默更糟。改为重建一份持久预期——会话日志记录了实际发出的请求头——这件事被推迟，而不是靠猜。

### 比对发生在重载被调停之处，且在它之后

触发点是 `ctx.on('internal/update', …)`：某个 fiber 的配置被应用、其插件在背后重启时，`dsh-app-boot` 与 Loader 所观察的那条瀑布。该监听器以 global 注册，因为被改动的行不必是守卫的祖先；并且它**不** prepend：位于 Cordis 自己的 `internal/update` 链式驱动器下游，意味着 `next()` 返回这次更新所驱动的重启，因此比对看到的是重载之后的状态，而不是重载即将替换掉的状态。两种结果都会扫描，因为失败的重载留下同样被撤走的行，适用的恢复方式也一样。

### 只报告无法解释的损失，且只报告一次

一个名字消失，只有在所组装预设未变时才算发现；预设变了是合法的重新组装，守卫改为重建基线。每条记录带着"当前这次回归已经播报过的名字"：一次没发现缺失的比对会重新武装它，因此之后再发生回归仍是新消息，而重复一次已播报的回归则保持沉默。只有在某个渠道接受之后才标记为已报告，因此一条谁也没收到的播报会被重试，而不是被当作已送达。

### 两条渠道，因为受影响的读者是人

一次回归写下一行日志，写明会话、它的预设，以及缺失的工具名；并向受影响的对话注入一条插件来源的通知，用这个人所读的语言写明缺少什么以及恢复方式。该通知由本包署名（`{ kind: 'plugin', plugin: 'composition-guard', form: 'notice' }`），因此它渲染为一条带署名的插件消息，而不是一条来路不明的用户提示。

通知文本刻意使用中文，包 README 记录了原因：仓库的客户端文案归 locale 所有，而这是一条发给某个人的、进入其自己对话的宿主侧消息。

### 一个会失败的守卫绝不能比缺陷更糟

每次检查都被包裹，而被包裹的失败对每个 agent 至多记一次，而不是每次更新都记。一个会抛错的 logger 是一条失败的渠道，而不是一次失败的播报。整份记录集由守卫自己的 context effect 持有，因此卸载该行——包括整树拆除——会把它丢掉。

### 不变式伴生检查那条让守卫有用的关系

一个瞎掉的守卫比没有守卫更糟，而它的盲区就是覆盖率。因此本包的 [`./invariant`](../../../../packages/guard/composition-guard/src/invariant.ts) 伴生在 `system-prompt/assemble` 上断言：一个正在面向模型组装的 agent，必须是已组装的守卫握有基线的那个。触发点与预设 roster 的伴生相同，理由也相同——正在组装的 agent 已经发布，其创建派发也已结算。当该运行时没有组装守卫时它什么都不报告：这条关系属于守卫，而只挂伴生、不挂守卫的部署并不欠它什么。

## Alternatives considered

**在 harness 核心修好重载路径。** 这是持久修复，也仍然是对的方向；但它不是本次改动。它是一处没有承诺负责人的核心补丁，而它留下的那段空白正是守卫要补上的。如果它落地，守卫的检测就从一个唯一信号变成一个范围更窄的兜底——这正是为什么守卫只报告而不修复，也是为什么本包里没有任何东西依赖于这个缺陷继续存在。

**把检测做成动态 Cordis 插件。** 否决理由已由移植陷阱那篇记录：动态插件只存在于运行中的进程里，无法随部署被评审、版本化、发布或回滚，并且会在重启后消失——对一个全部职责就是活过一次运行的守卫而言，这恰恰是最错的形状。

**把比对触发在 `tools/change` 上。** 注册表自己关于"某作用域可见集合变了"的通知，恰好会在本守卫关心的那些撤走上触发。否决原因是它也会为每一次作用域内注册、restriction 与遮蔽而触发，因此比对会远比"必须被解释的那次更新"跑得频繁。如果某条重载路径不再发出 `internal/update`，它仍是文档化的备选触发点。

**从会话日志记录的请求头取基线。** 持久日志保存着模型实际收到的工具 schema，因此它能告诉一个被收养的 agent 它曾经拥有什么，从而让已经残缺的组装变得可报告。此事被推迟：它让守卫的第一步变成一次有自己的失败模式的历史重建（被截断或被压缩的日志、跨多个回合的多份请求头），而一次错误的重建会在每次启动时产生误报。记录下来的限制陈述了这个缺口，而不是承诺一个只能靠猜的检查。

**报告每一个消失的名字，包括换了预设的情况。** 作为噪声被否决：重新组装是受支持的操作，报告它的工具集差值只会训练读者忽略那条唯一重要的消息。

**只写日志，不向会话内发通知。** 它被保留为配置项（`announceInSession: false`），但被否决为默认。日志能到达读宿主日志的人；而刚刚丢掉工具的那个人就在对话里，也正是能重启宿主的人。

**要求每个部署显式选择加入一行。** 否决：这个缺陷在构造上就是静默的，因此还没被咬过的部署没有理由选择加入，守卫就会恰好在第一次需要它的时候缺席。本包是组合刻意添加的一行 Host 平面配置，与随附守卫已有的位置相同。

## Consequences

一次过去要很晚才被发现的撤走，现在在它发生的地方被说出来：宿主日志里一行，受影响对话里一条，写明缺少哪些工具以及恢复方式。会话仍然无法在进程内被修复，守卫也不假装可以——包 README 在概述之后的第一句话就是：它检测，而不修复。

代价是一行常驻 Host 平面配置和少量逐 agent 状态：每个存活 agent 一份基线，在重新组装时刷新、在销毁时丢弃，外加每次 loader 更新、每个 agent 一次 map 查找。在并发会话很多的部署里，`maxAgentsPerUpdate`（默认 64）这个上限约束了这份工作量。安装它还要在挂载配置行之外多一步：按上面的安装规则，该 profile 的 `node_modules` 必须能解析到这个包。

两条限制被记录而不是被解决。只比较工具名，因此一次从被冻结 agent 撤走提示词段落、skill 或 projection 的重载依然静默；而当守卫激活时就已经不完整的组装不会被播报，因为守卫不会对它没有观测过的历史作猜。两者都写在包 README 的限制一节里，后者还点明了它所推迟的持久重建。

守卫自身的覆盖率如今是一条被强制执行、而非寄希望于运气的契约：不变式伴生会让"某个 agent 组装了模型输入、而已组装守卫对它没有基线"成为失败，因此一个坏掉的创建监听器或一次漏掉的收养是一声响亮的门禁失败，而不是一个静静看着一切的守卫。
