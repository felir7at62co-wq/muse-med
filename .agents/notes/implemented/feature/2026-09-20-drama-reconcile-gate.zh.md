# Agent Note: Refuse paid asset creation until the project's assets are reconciled

Status: implemented

[English](2026-09-20-drama-reconcile-gate.md) | 中文

## Problem

某个短剧项目里有一张流水线在 2026-08-28 生成的正式资产——asset 83840 / material 81426，`isUsed=1`、`hsAssetStatus: Active`，是男主角的高定西装版本——而 `assets_manifest.json` 里没有这条记录。写这一集的 agent 把清单当成项目库存，判定这个版本缺失，于是为两次失败的生成付了钱：0.12 元与 1.05 元。清单记录的是「这条流水线生成过什么」，不是「剧变项目里有什么」，所以只看清单的模型会重做一件已经存在的东西。

这个项目的工作区正好为这个缺口提供了只读对账（`_tools/asset_reconcile.py`）：它列出剧变远端「已选用且 Active」的资产，减掉清单里的 id，把结果写进 `_probe/asset-reconcile.json`，并给出一个 `ready` 判定——要求每条未登记资产要么已登记、要么被写明 note 后判为 ignored。但没有任何机制把「先跑它」变成花钱的前置条件。让模型去跑它的那段话写在 skill 正文里，而这正是本仓库用门禁回答的失败模式：决定要落在做这件事的操作里。

## Decision

`@deepseek-ai/dsh-guard-drama` 新增第五条规则，开关为 `reconcileFirst`（默认 `true`），只拒绝一个方法：`jubian_video` 的 `image_generate`。这个方法会新建计费资产，正是那场事故花掉的钱。其余剧变方法保持原有规则——`jubian_storyboard` 的 `generate` 仍由正式资产规则管，`erase_subtitle` 与 `upscale` 仍由幂等键规则管，`confirm_casting` 与 `remove` 各自不变，只读方法从不被拒。

规则定位候选项目根的方式与正式资产规则一致——显式 `projectRoot`，否则 `<sessionCwd|workspaceRoot>/<workshopDir>` 及其直接子目录——并读取每个根下的 `_probe/asset-reconcile.json`。只要任一候选带着可用证据，调用就放行。

「可用」就是流水线工具自己的 `evidence_state()` 判定，在这里复刻一份，因为门禁不能去运行那个工具：文件能解析成 JSON 对象；`ran_at` 能解析成时间戳，不带时区的戳按中国标准时间读；该时刻距今不超过 24 小时，且不比时钟超前 5 分钟以上；`blocking` 为空；`ignored_without_note` 为空；`ready` 恰好为 `true`。

其余每一种状态都会被拒绝，并写明不满足的是哪一条——没有证据文件、证据无法解析、时间戳无法解析、过期（附上原始戳）、时间戳在未来、未处置的未登记资产数量与 id、判为 ignored 却没写 note、或报告没有标记 ready——随后给出两条能清掉它的命令：`python _tools/asset_reconcile.py`，以及 `python _tools/asset_reconcile.py --dispose <asset_id> --status ignored --note "…"`，并说明这项检查为什么存在：清单记录生成过什么，不记录项目里有什么。

## Alternatives considered

**改成拦住付费分镜提交。** `jubian_storyboard` 的 `generate` 是另一个花钱的方法，而且已经有正式资产规则。资产远在提交分镜之前就生成了，所以拦提交是在钱花掉之后才拒绝——对这个失败来说拦错了流水线的一端。

**让门禁自己去跑对账。** 门禁读文件，不启动进程。一个会启动带凭证 Python 工具的 pre-execute 钩子，等于把一次缓慢、可能失败、依赖网络的操作塞进每一次命中的调用，而证据文件存在的意义正是把这件事挪出调度路径。

**让门禁自己去取远端资产并比对。** 那需要剧变 token、第二份比对实现，以及在调度路径上联网；工作区工具已经拥有这份比对与凭证。

**要求清单覆盖远端每一张资产。** 门禁从它可读的文件里看不到远端项目，所以这条要求在门禁内部无法验证——而且清单本身就是出错的那份产物，因此只查清单的检查恰好放过本规则要抓的那个状态。

**继续把它留在 skill 里，作为模型必须自己跑的 `--check`。** 这正是失败的状态：一段模型可以跳过的正文，而且就在它决定花钱的同一轮里。

**把拒绝写进 `jubian_video` 的提供方。** `packages/jubian/tool-jubian` 是传输适配层；它只懂远端 API，对工作间布局一无所知，而「在进入工具主体之前拒绝」正是 `tools/pre-execute` 的职责。

## Consequences

门禁现在复刻了一份本仓库之外的格式。`_tools/asset_reconcile.py` 位于生产工作区，它的 `evidence_state()` 是「什么算可用证据」的权威；`packages/guard/drama-gate/src/rules.ts` 里的 `reconcileState()` 与 `RECONCILE_*` 常量是 TypeScript 侧的副本。那个工具改了字段或窗口，两边都得跟着改，包 README 的开发备注写明了位置。

这项检查按工作间而非按项目：任何候选根都能满足它，证据里的 `script_id` 也从不与正在写入的项目比对。在存放多个项目的工作间里，一个项目的新鲜报告会让另一个项目也能新建资产。这与正式资产规则带的是同一个弱点，两者都记在包 README 的「已知限制」里，连同另一条边界：会话没有声明 cwd、部署也没有配置兜底根时，规则放行而不是拒绝。

对账本身仍在范围之外：本规则只覆盖「本项目清单 vs 剧变远端已选用资产」，不回答别的项目里现成资产能否复用。那是 asset-library 技能的检索，报告自带的 `cross_project_note` 在这里从不被读取。

代价是每次 `image_generate` 调用多读一个很小的本地文件，以及一种新的挡住正常工作的方式：超过一天的报告会一直拒绝调用，直到重新对账。拒绝文案带着那条命令，所以修复就是一次工具调用；而它的反面——为一张已经存在的图付 1.17 元——正是这条规则换来的结果。

## Testing

`packages/guard/drama-gate/tests/rules.spec.ts` 逐条钉住每个要求（证据缺失、JSON 无法解析、JSON 不是报告对象、`ran_at` 缺失/非字符串/无法解析、证据 25 小时前、证据超前 10 分钟、`blocking` 非空、`ignored_without_note` 非空、`ready: false`）以及放行侧（新鲜且已全部处置的证据、不带任何处置字段的最小报告、按 `+08:00` 读取的无时区戳、显式 `projectRoot`、邻近项目的报告、开关关闭，以及每个不受本规则约束的付费与只读方法）。`packages/guard/drama-gate/tests/drama-gate.spec.ts` 用按默认配置挂载的真实工具注册表调用 `jubian_video.image_generate`，证明拦截器在工具主体运行之前就拒绝了它。

在按包运行的 `vitest run --coverage` 里，新增函数没有未覆盖的语句、分支或函数。
