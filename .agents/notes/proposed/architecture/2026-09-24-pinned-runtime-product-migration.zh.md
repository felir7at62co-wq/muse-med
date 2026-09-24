# Agent Note: Pin the DSH runtime and give the product its own version

Status: proposed

[English](2026-09-24-pinned-runtime-product-migration.md) | 中文

## Problem

本检出是整个 harness 的一个 fork，承载 muse-med 桌面产品。它没有自己的本地提交：产品工作直接落在一个比 `origin/master` 落后 2499 个提交的合并基线上，与该基线相比有 1214 个文件不同——1073 个 fork 新增文件（+170,771 行），以及对既有上游文件的 141 处改动（+5376 / −357）。产品自身的规模是 926 个受跟踪文件、162,162 行文本，而 `packages/drama`、`packages/jubian`、`packages/perception` 与 `third_party/plugins` 在上游根本不存在。

有两个事实使当前格局不稳定。其一，发布身份是单值的：`package.json` 持有 `0.1.6-alpha.1`，而有 23 处断言或推导同一个值，既把它当作产品版本又当作 DSH 版本，其中包括 `apps/desktop/src/runtime-tree.ts:173`，它要求共享的 `@deepseek-ai/dsh` 包恰好携带该发布版本。因此产品无法在不宣称一个 DSH 版本的情况下发布。其二，依赖解析走 workspace 协议：产品包持有 130 处 `workspace:` 引用，其中 68 处指向上游拥有的包，所以产品只能在整棵 harness 树内构建。

代价在下一次上游变动时支付。一次只读演练（`git merge-tree --write-tree --name-only HEAD origin/master`）报告 77 个冲突文件——63 个内容冲突与 14 个修改/删除冲突，其中 38 个位于 `apps/desktop` 之下——因为上游删除了 fork 曾修改过的若干文件，包括 `apps/desktop/renderer/plugin-manager.{js,css,html}`、`apps/desktop/src/preload.ts`，以及 `packages/llm/llm-deepseek/src/protocols/chat-completions/*.ts` 这三个模块。产品依赖着任何发布都不提供的接口：`apps/desktop/scripts/prepare-package-set.ts:25-26` 导入了 `scripts/release/process.ts` 与 `scripts/release/tarball.ts`，它们只存在于仓库内部。

## Proposal

产品继续在本仓库内构建并交付整个应用，而 harness 从基线变为一项输入。仓库根目录下新增受跟踪的 [`upstream.json`](../../../../upstream.json)，记录目标 DSH 发布——提交与版本——作为该 pin 唯一的所在。[`scripts/upstream-sync-rehearsal.ts`](../../../../scripts/upstream-sync-rehearsal.ts) 拥有该记录：它从 Git 重新推导基线，在记录与 Git 不一致时拒绝继续，并在不做合并的前提下报告一次合并会产生的冲突。产品自身的版本是 `apps/desktop/package.json`，可以与它不同。运行时描述符在 `release.version` 之外新增 `release.dshVersion`，于是 `runtime-tree.ts:173` 用被 pin 的 DSH 版本比对共享包，而产物命名与更新元数据继续使用产品版本。

产品对上游拥有包的 68 处 workspace 引用改为 pin 的版本范围，必须可发布的产品包则离开上游的 `@deepseek-ai` scope——产品无法在该 scope 下发布。桌面外壳保持产品自有：产品拥有 24,743 行外壳与构建脚本、安装器以及媒体载荷，而作为参考的第三方桌面客户端也是同样的关系——产品自有外壳依赖被 pin 的运行时。外壳所依赖的两处非公开接口或被替换、或被显式拥有：仓库构建脚本的导入被移植进产品，而 `apps/desktop-host/src/native-preset.ts` 中的 loader 内部访问通过在 `vendor/loader` 里 vendored 的 `@deepseek-ai/cordis-plugin-loader` 保持受产品控制。

[独立产品决策](../../implemented/architecture/2026-09-23-muse-med-independent-desktop.zh.md)继续拥有产品主目录、预设名册、媒体环境与凭证隔离，[打包运行时决策](../../implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续拥有包共享与插件生命周期。两者都未被取代；本记录改变的是 harness 从何而来，而不是产品是什么。

## What is deliberately not yet done

阶段 0 已落地：三个文件。`upstream.json` 记录 pin；`scripts/upstream-sync-rehearsal.ts` 读取它，用 `git merge-base HEAD <ref>` 推导基线，运行 `git merge-tree --write-tree --name-only`，把每个冲突归类为内容冲突或改删冲突，并断言工作树与 ref 集合在演习前后逐字节不变；`scripts/upstream-sync-rehearsal.spec.ts` 用一个临时仓库验证它，该仓库自行造出分叉、上游前进、双方改同一文件，以及每一侧各删除一个文件。`pnpm exec tsx scripts/upstream-sync-rehearsal.ts` 报告 77 个冲突文件——63 个内容冲突、14 个改删冲突——而 `pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts --maxWorkers=1` 的 14 个用例全部通过。pin 不会静默通过：无法解析的 ref、没有共同祖先的 ref、与 Git 不一致的 pin，以及未知参数，都会在失败时点名原因。

把提交 ID 写进受跟踪文件，需要在 [`verify-repository-references`](../../../../scripts/verify-repository-references.ts) 上加一处例外——该门禁的规则本意是阻止正文与文档携带会失效的哈希引用，而 pin 记录里的提交 ID 是该文件的主体，不是对它的引用。例外仅限仓库根那一个精确路径 `upstream.json`：该文件内的组织 URL 仍被拒绝，任何目录下的同名文件仍被拒绝，其余文件一律照旧。

阶段 0 之后的一切都未实现，带验收检查与回滚的分阶段方案存放于 `.local/architecture/pinned-runtime-migration.md`，位于仓库受跟踪文档之外。没有任何版本点被改动，没有任何依赖离开 workspace 协议，也没有任何包被改名；23 处版本点、指向上游拥有包的 68 条 workspace 边、scope 决策，以及 `## Risks` 中命名的两处非公开上游导入，全都仍然开放。产品将要针对的那个 DSH 发布也尚未选定——`apps/desktop/package.json` 与 `package.json` 仍然都写着 `0.1.6-alpha.1`。

vendoring 问题同样被有意地留在与参考项目相反的方向上。参考桌面客户端在三个 pin 上 vendored 了 891 个 tarball（占其 82.6 MB 检出的 48 MB），每次升级改写 618 条 `resolutions`。其当前 pin 的全部 309 个包、以及本次会话探测的 120 个，都已在该版本发布到 npm，所以对这个产品运行时所需的 36 个包而言，registry 解析是可用的。vendoring 被推迟到某个具体包必须打补丁的情形；今天没有任何包被打补丁。

## Alternatives considered

**继续做 fork，靠同步纪律维持。** 演练把代价限制在 77 个文件而非 1214 个，所以这是可以承受的。它之所以落选，是因为代价随每一个被跳过的发布增长，38 个冲突位于产品正在积极编辑的外壳里，而让 fork 不稳定的那两个事实——单值发布身份与 workspace 协议解析——不会被任何程度的纪律触及。

**照搬参考项目的完整机制。** vendoring 运行时会密封地 pin 住 DSH 包，并使离线构建变得简单。它在实测代价上落选：要在产品仓库里维护 891 个 tarball 与 618 条 resolutions，还要为每个版本最多给 19 个上游包打补丁，而本产品只需要 36 个包且一个都不打补丁。它还会让 DSH 版本再次与产品版本不可分离，而那正是要解决的问题。

**用薄插件替代桌面外壳，架在被 pin 的运行时之上。** 参考项目自身的措辞在这里会误导：它的外壳本身就是产品包。把 90 个脚本文件与 14,287 行代码、渲染层、安装器以及媒体暂存移植成新形态，没有任何测试能在移植过程中捕获回归，而且它买不到阶段 2 与阶段 3 尚未买到的东西。

**保留 `@deepseek-ai` scope，什么都不发布。** 在每个产品包都保持 `private: true` 并随应用一起交付时可行。只有当某个包必须独立发布时它才落选，所以 scope 决策被推迟到该需求出现时，而不是现在就做。

## Risks

pin 的好坏取决于它所命名的那个发布。如果某个 DSH 发布删掉或改名了产品消费的包，故障会在安装时以解析错误的形式出现，而不是编译错误，所以 pin 必须由真实的包安装与 Host 启动来验证，而不是靠读版本号。

有两处非公开接口在这次改变中存续下来。`apps/desktop/scripts/windows-sign.mjs:8` 对 `app-builder-lib/out/vm/WineVm.js` 的深层导入仍然耦合于某个第三方工具的内部布局，而 `apps/desktop-host/src/native-preset.ts` 访问着没有任何发布文档化的 Cordis loader entry 与 tree 内部。vendored loader 让第二处留在产品控制之内；第一处不会消失。

把产品版本从 DSH 版本上移开会改变 `desktop-upload-plan.ts` 推导出的更新元数据文件名。在这两个阶段之间切出的发布会发布运行中的应用读不了的元数据。

## Acceptance criteria

阶段 0 的验收已达成：只有在 `upstream.json` 与 `git merge-base HEAD origin/master` 相符时，`pnpm exec tsx scripts/upstream-sync-rehearsal.ts` 才成功退出，并报告 77 个冲突文件——63 个内容冲突、14 个改删冲突——且不改动工作树与 ref 集合；`pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts --maxWorkers=1` 在无远端的夹具仓库上通过 14 个用例。

其余阶段达成的标志是：当 pin 所命名的 DSH 发布与实际安装的 DSH 包不一致时，`pnpm run prepare:desktop` 失败；一致时成功；`apps/desktop/package.json` 携带一个独立于被 pin DSH 版本的版本，而产物名、更新元数据与运行时描述符保持自洽；没有任何产品包通过 `workspace:` 解析到上游拥有的包；打包构建能启动 Host 并挂载全部三个产品预设，且 DSH 包只来自该 pin。
