# Cookbook: syncing an upstream DSH release into the fork

[English](upstream-sync.md) | 中文

本检出是承载 muse-med 产品的 DeepSeek Harness fork，因此上游变动是一次刻意的操作，而不是后台的 `git pull`。演习与分诊两个脚本让这次操作可重复：前者回答一次合并会冲突在哪里，后者回答每个决定归谁。按节奏运行它们，而不是等一次发布把问题逼出来。

本流程要避免的失败是"在不知道规模的情况下开始合并"。撰写时被 pin 的基线落后 `origin/master` 2499 个提交，一次演习报告 **77 个冲突文件——63 个内容冲突、14 个改删冲突**。这个数字就是重点：它是一个上午的分诊量，而不是无界的集成。

## 1. Confirm the pin before reading any finding

```sh
pnpm exec tsx scripts/upstream-sync-rehearsal.ts
```

演习读取 [`upstream.json`](../../upstream.json)，用 `git merge-base HEAD <ref>` 重新推导基线，并在**记录与 Git 不一致时失败**，同时点出两个提交。过期的 pin 是演习报告"没人在做的那次变动"的唯一途径，所以要把这个失败当作流程的第一步，而不是障碍。`--ref` 用于演习另一个分支；`--out` 写出 JSON 报告。

## 2. Triage by owner

```sh
pnpm exec tsx scripts/upstream-sync-triage.ts --out .local/architecture/triage-record.json --markdown .local/architecture/triage-record.md
```

分诊按"决定归哪一侧"给每个冲突归类，依据是两侧各自持有什么，而不是文件名清单：

| Owner | Meaning | What to do |
|---|---|---|
| `product` | fork 保留了上游 ref 已删除的文件。 | 决定保留或丢弃，并说明理由。 |
| `upstream` | 上游 ref 保留了 fork 已删除的文件。 | 接受该删除，或有意地恢复该文件。 |
| `own` | 两侧都持有并改动了该路径。 | 合并这两种意图。 |
| `generated` | 该路径由某个已声明的生成器写出。 | 重新生成；绝不要靠编辑它来表达产品事实。 |

两个"删除"归属都是产品决定，而不是合并机制：Git 只报告方向，且只在 `product` 方向上把文件留在工作树里，所以那里列出的每条路径都需要人给出答案。

## 3. Keep generated outputs declared

[`scripts/upstream-sync-generated-paths.json`](../../scripts/upstream-sync-generated-paths.json) 列出由生成器拥有的路径，与读取它的脚本放在一起。新增生成器时要扩充它：没有任何机械规则能可靠识别生成文件，因为生成器通过局部变量、辅助函数和计算出的路径写出，所以这份声明是显式的、被直接读取的。清单缺失时表示没有任何声明；而清单指向不存在的文件、或把两个生成器放在同一路径上时会显式失败，而不是悄悄收窄生成集合。

## 4. Never edit an upstream-owned generated file to express a product fact

冲突的目录文件要重新生成，而不是合并。同一条规则也适用于同步之外：产品事实属于产品源码，随后由生成器把它带进生成文件。手工编辑 `docs/tool-catalog.md` 会在下一次重新生成时丢掉改动，并掩盖该事实真正的所在。

## 5. Verify

```sh
pnpm exec tsx scripts/upstream-sync-rehearsal.ts
pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts scripts/upstream-sync-triage.spec.ts --maxWorkers=1
```

两个脚本都断言工作树与 ref 集合在运行前后逐字节相同，并在该断言失败时抛错而不是报告：一次改动了仓库的演习属于演习自身的缺陷，而不是关于合并的发现。两个脚本都不写 ref、不改工作树文件，所以运行它们始终是安全的。

一次上游变动完成的标志是：[`upstream.json`](../../upstream.json) 里的 pin 指向新的基线，每条冲突路径都完成分诊，且产品仍能构建与打包。在接受新基线的同一次改动里记录它，这样下一次演习比对的是有人确认过的基线，而不是 Git 恰好推导出的那个。
