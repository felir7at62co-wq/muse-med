# Agent Note：把付费生成前的资产对账做成工具

Status: implemented

[English](2026-09-20-drama-asset-reconcile-tool.md) | 中文

## 问题

拒绝付费创建资产的钩子早就有了：`packages/guard/drama-gate` 里的 `reconcileFirst` 会读 `_probe/asset-reconcile.json`，只有在证据新鲜、ready 且每条都已处置时才放行 `jubian_video` 的 `image_generate`。产出这份证据的却是生产工作间里的 Python 脚本 `_tools/asset_reconcile.py`，由技能正文叫模型跑 `python _tools/asset_reconcile.py`。这带来两件事。用户机器上必须装 Python、还必须有那个工作间，这项检查才可能存在——对一个以 Node 应用交付的产品来说，这是错的前提；而钩子依赖的那次比对，活在本仓库并不拥有的文件里，它的规则无法在这里评审、测试或修改。

证据文件的格式是真契约，不是输出。还有两个程序读它：工作间自己的 `_tools/asset_reconcile_report.py` 与上面那个钩子。移植时改掉一个字段名、一种类型或一层语义，就是弄坏一项专门用来拦住静默失败的检查——当初清单式的盘点漏掉了剧变远端早就存在的资产，代价是 1.17 元。

## 决定

`drama/` 组新增第三个包 `@deepseek-ai/dsh-tool-drama-assets`，注册一个模型可见的工具 `drama_assets`，两个方法。

`reconcile` 同时读两边——剧变远端的 `/aigc/asset/list` 与 `/aigc/material/list`（走共享的剧变传输层），以及项目自己的 `assets_manifest.json`——并用临时文件加改名写出 `<project_dir>/_probe/asset-reconcile.json`。三条判定都是流水线自己的，逐字段移植：资产行的 `delFlag == "0"` 才算存活；材质行带 `isUsed == 1` 且 `hsAssetStatus == "Active"` 才算已选用；已选用但资产行已被删除的不算资产，所以只有存活的行参与比对。`unregistered` 是远端已选用而清单没有的，`dangling` 是清单里有而远端没有的，其余算 `matched`。处置表从上一份证据继承，每条未登记资产补一个 `pending`，清单现在记录了的资产一律变成 `registered` 并保留原 note。`blocking` 与 `ignored_without_note` 由处置重算，`ready` 是两者之合，`ran_at` 是流水线自己报告写的、带 `+08:00` 偏移的 ISO 秒级时间，`policy` 带上钩子读的那五个值。

`dispose` 记录某人对某条资产的一个决定——`registered`，或带非空原因的 `ignored`——并重算那三个判定字段。它什么都不发：那次比对在写证据时就已经做完，重跑它等于为一个人已经做出的决定花一次网络往返。

这个工具绝不调用剧变的任何写方法、绝不买任何东西，且只写一个文件。token 是凭据引用 `JUBIANAI_ADMIN_TOKEN`，每次读取都经凭据库解析，并沿用 `packages/jubian/tool-jubian` 已有的工作间密钥回退——本包不再引入第三个 token 解析器。

两个细节是刻意的。证据文件保持流水线自己的写法：提供方没给的字段是 JSON `null`；而工具结果把同一件事写成空串或 `0`，因为参数 DSL 没有可空标量，且 `0` 不是提供方会发出的类别号。`readAssetList` / `readMaterialList` 仍然是「一页是什么」的权威，而本包从它们接受的行里读 `delFlag`、`createTime` 与两种名字拼写——映射不带这些字段，而证据 schema 需要它们。

结果里的 `ready` 只看处置，与 `evidence_state()` 一致，并补上这个处置状态所隐含的 `next` 一句话。钩子额外要求的新鲜 `ran_at` 不折进 `ready`：在一个没有任何证据的项目上 `dispose`，写出的文件确实不可用，而钩子本来就会拒绝它。

## 考虑过的替代方案

**留着 Python 脚本再包一层。** 一个去启动 `python _tools/asset_reconcile.py` 的工具能保住一份实现并立刻交付。它同时也会保住产品的 Python 前提，把比对规则留在一个本仓库并不拥有的文件里，并把证据格式变成「某个脚本恰好输出成那样」，而不是「两个读者依赖的东西」。

**让钩子自己去读远端。** 钩子读文件，不发网络请求。给它 token、再加第二份比对实现，等于把一次带凭据、依赖网络的操作放进每次 `image_generate` 的派发路径——而那正是证据文件存在的意义：把这份工作挡在派发之外。

**让工具在 `dispose` 时也跑一遍比对。** 每次处置都重跑 `reconcile`，会让每个决定都变成一次新的远端读取。它还会让一个不需要任何远端事实的决定在网络不通时失败——并且会改写 `ran_at`，让一份过期报告看起来新鲜，而没有人重新看过这个项目。

**把证据字段做成可空，让文件与结果共用一个类型。** 参数 DSL 没有可空标量，而且这两种写法本来就不同：文件由两个程序读，契约是 Python 工具的输出；结果由模型读。在同一个接缝上把同一件事写两遍，比造一个两个读者都解析不了的 schema 便宜。

**把 `ready_reason` 写进文件。** Python 工具在判定之后会写它，而它是文件里已有字段推导出来的。本包改为在工具结果里返回同一句话，文件只留钩子真正读的那四个字段，这样文件不会在「为什么没 ready」这件事上自相矛盾。

## 后果

这次比对在本仓库里有了唯一的可执行归属，并且带上针对判定规则与证据文档的单元测试。用户机器需要 Node 而不是 Python，钩子依赖的格式由与钩子同树的测试钉住。

代价是过渡期有两份实现，以及一个有两位权威的格式。`_tools/asset_reconcile.py` 在会话迁过去之前仍是生产工作间自己的工具；它仍是文件字节布局的参照，本包 README 的 Dev Note 写明了这次移植唯一不写的字段。格式在任一侧变了，另一侧就得跟上——这与 `reconcileFirst` 钩子本来承担的义务是同一条。

三条限制是刻意的，记在包 README 里：`dispose` 不重新比对，所以上次 `reconcile` 之后才被选用的资产不在它编辑的那份证据里；在没有任何证据的项目上 `dispose` 产出的文件会被钩子拒绝；清单里 `jubian_asset_id` 写成字符串而不是整数的行，对两张清单都不可见，因为 Python 参照只认整数 ID。

本包在调用之间不持有状态，也不发布 invariant 伴生模块：每个答案都是它读到的文件与两次远端列表的函数，没有任何独立变化的观测可查。

## 测试

`packages/drama/tool-drama-assets/tests/` 覆盖这次比对、证据文档与已注册的工具。`reconcile.spec.ts` 逐条钉住每个判定：两端一致、清单漏掉的已选用资产、被删除的资产两张清单都不进、材质不同时满足已选用与 `Active`、材质行先于资产行作答、两行都没有的字段写 `null`、两种名字拼写、没有 stable_id 与名字的悬空记录、ID 升序、处置继承（含自动 `registered`）、判 ignored 却没写 note、翻页与按声明总数停止，以及清单与证据的每一种解析失败。`disposeAsset` 钉住两种状态、空 note 拒绝、未知状态、不可用 ID、没有证据的项目，以及它不动哪些字段。`tool.spec.ts` 挂载插件、把参数名与接口自己的名字对齐、用替换掉的传输层端到端驱动已注册的 executor，并把两种结果都按工具自己声明的 schema 校验。`npx vitest run packages/drama/tool-drama-assets --coverage` 报五个源文件逐文件 100% statements、branches、functions 与 lines。
