# Agent Note: 打包产物默认不带情感运行时，只有显式点名才带

Status: implemented

[English](2026-09-26-media-payload-bgm-opt-in.md) | 中文

## Problem

规范的那条 Windows 打包命令跑不完。它在 [`package-target.ts`](../../../../apps/desktop/scripts/package-target.ts) 里的 media 步骤无条件传了 `--bgm-cache`，而点名这个缓存正是让 [`prepare-media-runtime.ts`](../../../../apps/desktop/scripts/prepare-media-runtime.ts) 把情感运行时加进载荷的开关。磁盘上已有的载荷、以及已发布安装包所带的载荷，都不含情感运行时，于是复用校验以 `media reuse: BGM descriptor changed` 拒绝了这次构建，并在打包之前停下。要装出任何东西，只能跑一个跳过 media 步骤的本地续跑脚本——也就是说，这条命令自己的承诺「一条命令产出安装包」是假的。

分歧发生在一个脚本和产品其余部分之间。仓库里每一份 `media-runtime.json` 都没有 `bgm` 键、没有 `bgm/` 目录、清单里也没有任何 `bgm*` 成员。没有情感运行时的部署会把 `perception-bgm` 解析成只用目录，[`desktop-bgm-config.spec.ts`](../../../../apps/desktop/tests/desktop-bgm-config.spec.ts) 把这一点钉住：任何东西都不得把这个插件指向安装包并不携带的模型路径。两边不一致时却没有任何东西失败，因为没有测试断言默认调用到底给 media 步骤传了什么。

## Decision

`--with-bgm` 是请求情感运行时的唯一方式。[`parseDesktopPackageInvocation()`](../../../../apps/desktop/scripts/package-target.ts) 读取它，并在非 `win-x64` 目标上拒绝它，与 `--unsigned` 的规则对称；解析出的调用对象携带 `withBgm`。

[`desktopPrepareMediaRuntimeArguments()`](../../../../apps/desktop/scripts/package-target.ts) 拥有 media 步骤的参数。对没有 media 步骤的目标它返回 `undefined`；对 `win-x64` 它只返回 `--output` 与 `--cache`，只有显式点名的那次调用才追加 `--bgm-cache <downloads>/bgm`。因此默认构建复用已发布的无 BGM 载荷，而不是与它相矛盾。

[`missingBgmRuntimeInputs()`](../../../../apps/desktop/scripts/package-target.ts) 会点名一次 opt-in 仍然缺少的情感运行时 lock 与情感模型下载缓存。打包入口在第一个耗时步骤之前就检查它们，所以缺输入的 `--with-bgm` 会在几秒内失败，而不是等整轮构建跑完。

[`apps/desktop/package.json`](../../../../apps/desktop/package.json) 里的 `package:win:x64:unsigned` 仍是规范的无 BGM 命令，`package:win:x64:unsigned:bgm` 是显式变体。仓库根上那条规范命令的脚本转发到 desktop 包，所以这个开关只定义一处。

`prepare-media-runtime.ts` 的复用校验没有改动。它的拒绝是正确的——它存在的意义就是拦住「请求的载荷与磁盘上的载荷相矛盾」的构建——而默认路径不再与它矛盾。

## Alternatives considered

**用环境变量选择载荷。** 那么 shell profile 就能改变安装包里装什么，而命令行与构建日志都不会说，某个载荷由哪个开关产出也无法复原。这类选择在本仓库已经由命令行承载：`--dir`、`--prepare-only`、`--unsigned`。

**丢弃现有载荷、连情感运行时一起重建。** 那会扔掉已校验的解释器、FFmpeg 与 Visual C++ 运行库并重新下载。在这台机器上，带情感运行时的载荷连它自己的冒烟测试都没过，所以命令会在更晚的地方失败并什么都不留下，而产品的已发布组合会因为修一个构建中断而被顺手改掉。

**放宽复用校验，而不是改调用方。** 那道拒绝正是防止「载荷记录的成分」与「构建请求的成分」分叉的机制。放宽它，后来的一次默认值改动就能用不同的字节覆盖一份已校验的载荷。

**保留内联的参数列表，只把开关删掉。** 那正是藏住这个缺陷的状态：media 参数没有导出的所有者，也没有任何关于默认调用的断言可供失败。这个解析函数的存在就是为了让默认值能被测试钉住。

**把 opt-in 放进打包配置文件。** 「这个安装包里有什么」的答案会被拆到文件和命令行两处，而打包目标本来就从参数解析其它所有构建选择。

## Consequences

规范命令现在能跑完，并产出产品本来就已发布的组合：没有情感运行时，只做目录匹配。情感运行时只有点名才可达，缺 lock 或缓存会在构建开始前而不是在 media 步骤报出来。

代价是多一个开关和两个导出的辅助函数，且想要情感运行时的包必须先准备好它的缓存与 lock。在这台机器上，构建那份载荷从未通过它自己的冒烟测试——那是一个独立的、仍未解决的产品问题，opt-in 只是把它暴露出来，而不是修好它。

[`package-target.spec.ts`](../../../../apps/desktop/tests/package-target.spec.ts) 钉住默认 media 参数不含 `--bgm-cache`、显式 opt-in 含它、非 `win-x64` 被拒绝、以及缺输入的检查。`prepare-media-runtime.spec.ts` 的载荷用例继续钉住本次修复所保留的那道拒绝，包括 `media reuse: BGM descriptor changed` 这一条。
