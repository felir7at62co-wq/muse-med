# Agent Note: 根 tsdown entry 是工作区默认入口，工作区成员按目录而非 manifest 判定

Status: implemented

[English](2026-09-28-tsdown-workspace-entry-and-manifest-membership.md) | 中文

## Problem

一个同步过的工作树跑 `pnpm run build:lib` 失败：

```
Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
```

而 `main` 上同一条命令通过，两条线都没有根 `src/`。这条消息读起来像是[根 tsdown entry](../../../../tsdown.config.ts) 的缺陷：根 package 索要无人能产出的产物，于是顺理成章的修法就是让它什么都不要。这个读法两半都错——根 package 根本不是构建目标，那个 entry 也不是根自己的。

## Decision

`entry: ['lib/types/{index,invariant,startup}.js']` 是**工作区级默认入口**。tsdown 把根配置合并进每个工作区成员的配置，每个成员按自己的目录解析这个 glob，因此它的含义是「打包 `tsc -b` 输出到该包 `lib/types` 的东西」。被枚举的 312 个目录里有 196 个没有自己的 `tsdown.config.ts`，依赖这个默认值。Client 面的 `''` 是同一个选项不携带默认值：`resolveConfig` 会丢掉每个没有自己声明 entry 的成员。

根 package 从不参与构建。`workspace.include` 只枚举 `vendor/*`、`packages/*/*` 和三个应用目录；根不在其中，根 `tsconfig.host.json` 是覆盖测试与脚本的 `noEmit` 聚合，根 manifest 是 `private` 且没有任何入口。

## Membership is directory-based

`workspace.include` 以 `onlyDirectories: true` 解析，从不查 manifest。`packages/*/*` 或 `vendor/*` 下没有自己的 `package.json` 的目录——残留或只搭了一半的包目录——依然会成为构建目标；被继承的 entry 在它内部解析不到任何东西，`resolveEntry` 于是失败。标签来自 `readPackageJson(cwd)`，它会向上走到仓库的 manifest，因此失败会点名 `@deepseek-ai/dsh-root`，而这个根 package 对此毫无贡献。

[`tsdown-workspace.spec.ts`](../../../../scripts/tsdown-workspace.spec.ts) 断言通配成员枚举出的每个目录都持有 manifest，否则点名出问题的目录。

## Alternatives considered

**让 Host 面像 Client 面一样用空 entry。** 看起来是对称的修法，但它会删掉 196 个目录所依赖的默认值：entry 为假值时根配置不再接纳继承它的成员，这些包会直接退出构建，而不是改用别的 entry 构建。

**加一个根 `src/`。** 根 package 不发布任何东西，这棵树只为满足一个 glob 而存在，而该 entry 打包出来的产物没有消费者。

**给 Host 面跳过 tsdown 或 Typert 让命令变绿。** Host 这一趟负责产出每个成员的 bundle，以及 Client 面消费的 Typert 产物；跳过只是把失败挪进 client 构建，并没有消除它。

## Consequences

残留目录依然会让构建停下，而且这条防线只随测试套件运行，`build:official` → `build:lib` 并不跑它。变化在于：失败现在记录在 entry 所在之处，跑测试的开发者被告知的是哪个目录没有 manifest，而不是被指向根 package。
