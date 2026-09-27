# Agent Note：从不说明收到什么的读取层，与把清单键读成"没有资产"的对账

Status: implemented

[English](2026-09-27-silent-envelope-and-manifest-key-failures.md) | 中文

## Problem

组员在 alpha.3 构建上撞到的两个失败，都是"给出了结论、却扣下了能定位它的事实"。

**读取层抛的是裸错误码。** `Jubian response did not match the expected envelope` 在组员会话里出现 36 次，从 `13:41:10` 一直到 `17:30:42`——整整一个工作日，而且就发生在下文那个修复已经ship的构建上——横跨 `jubian_storyboard`、`jubian_video`、`jubian_media`、`jubian_catalog` 与 `jubian_model`。这 36 条报文一模一样，而该会话里 `DSH_JUBIAN_DEBUG_DUMP` 出现 0 次，因为没有任何一句话提到过它。[324eadaa34](2026-09-28-jubian-unreadable-response-diagnostics.zh.md) 已经给传输层加了脱敏结构摘要，但传输层只管信封：它把 `data` 交给 reader，而 `@deepseek-ai/dsh-jubian-api` 里每个 reader 抛的都是不带 detail 的 `new JubianError('CONTRACT_CHANGED')`。十一个 reader 模块各自声明了一个无参数的 `invalid()`，于是"传输层接受了、reader 用不了"的载荷只会产出那一句既不点名端点、也不点名字段的话。

**对账侧把缺失的数组键读成了空数组。** `drama_assets reconcile` 三次把 `"对账里还有 222 条未处置的未登记资产"` 与 `"manifest":{"items":0}` 摆在一起（L963、L2814、L3340），而清单其实是把这些资产声明在另一个键下；组员随后写下"清单用的是 assets 不是 items"（L3462），改名后 L3470 立刻 `ready:true`。`manifest.ts` 的 `rowsAt()` 对 `undefined` 返回 `[]`，于是资产数组拼成 `assets` 的清单被读成"一条资产都没有"，远端本来已经持有的资产全部被判成未登记。`jubian_organize` 早就改成了缺 `items` 就报错（[organize.ts:160](../../../../packages/jubian/tool-jubian/src/organize.ts)），但对账侧自 09-22 起没有再动过。

两者是同一种缺陷形状：一个以"阻止静默失败"为唯一职责的检查，产出了它本该阻止的失败，而它写下的产物看起来还很权威。

## Decision

**一个摘要函数，两层都从它这里拒绝。** [`describeRejection(value)`](../../../../packages/jubian/jubian/src/diagnostic.ts) 组合三件事：[`describePayload`](../../../../packages/jubian/jubian/src/diagnostic.ts) 本来就在报告的结构、信封 `code` 与允许集合（`0 / 200`）的对比、以及 `DSH_JUBIAN_DEBUG_DUMP` 那一句及其用法。`describeBodyRejection` 是同一句话在"响应体从未解析成功"时的版本。传输层拒绝读不懂的信封走它们，每个 reader 也走它们，因此两层不可能把同一份响应体说成两个样子。

**每个载荷 reader 都通过 [`readPayload`](../../../../packages/jubian/jubian-api/src/reading.ts) 读取。** reader 自己的 `CONTRACT_CHANGED` 会被改写为点名 reader 并带上摘要；reader 自己写的 detail 会被保留、摘要追加在后面，因为 detail 是 reader 的结论、摘要是实际到达的东西。已经点名取证开关的 detail 原样通过，因此被包两次的 reader——`withGenerationEnabled` 会调用 `readStoryboard`——对同一份载荷只摘要一次。

**清单的资产数组只有一个拼法。** `readManifest` 只读 `items`，其余一律用 `jubian_organize` 已经在用的那句话拒绝，点名缺哪个键、实际有哪些顶层键、以及修法。`lead_readonly_records` 仍然可以缺席，因为它确实可能没有；资产数组不行，因为把它读成缺席正是 222 条已登记资产变成 222 条未登记的路径。

## Alternatives considered

**让每个 reader 保留自己的 `invalid()`、各写一套摘要。** 否决：那正是本记录要防的漂移，而且它覆盖不到从 `rows()`、`object()` 这类共享 helper 抛出的拒绝——而多数 reader 拒绝恰恰从那里产生。

**让缺失的 `items` 回退到 `assets`，与 `jubian_organize` 和分镜脚本 reader 保持一致。** 本次对账否决。把另一种拼法读成"没有行"正是被修掉的失败，而回退会让同一个事实在这个"只负责敲定该事实"的文件里保留两种拼法。让调用失败，在"有 assets"与"两者都缺"两种情况下都会用同一句话点名该键。

## Verification

- `packages/jubian/jubian-api/tests/reader-rejection-summary.spec.ts` 把同一份坏响应分别喂给传输层与一个 reader：两条报文都带结构、`code=500`、`accepted envelope codes: 0 / 200` 与 `DSH_JUBIAN_DEBUG_DUMP`；两条都不带响应体里的 access token 与其签名 URL；`null`、`undefined`、数组、字符串、数字与布尔值都是被描述、而不是被拒绝。
- `packages/jubian/jubian/tests/envelope-layout.spec.ts` 保留传输层用例，包括未映射 code 的编号与 `accessToken` 的脱敏。
- `packages/drama/tool-drama-assets/tests/reconcile.spec.ts` 覆盖"资产数组拼成 `assets`"、"两个键都有"、"两个键都缺"三种清单；两次拒绝只在所列结构上不同。
