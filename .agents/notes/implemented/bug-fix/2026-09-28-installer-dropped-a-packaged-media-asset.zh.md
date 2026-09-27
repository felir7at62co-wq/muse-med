# Agent Note: the Windows installer shipped without one packaged media asset

Status: implemented

[English](2026-09-28-installer-dropped-a-packaged-media-asset.md) | 中文

## Problem

2026-09-28 的会话复盘发现渲染被一个缺失输入阻断：每一份已安装的 `muse-med` 里都有 `…\dsh-drama-skills\skills\tweet-drama-background-render\assets\ending_audio.mp3`（83,432 字节），却没有与它同目录的 `ending_effect.mp4`（904,502 字节，SHA-256 `49308bce…0010`），全盘搜索也找不到该特效的字节。仓库包两份都在、`packages/drama/skills/package.json#files` 两条都列名，而 `drama_render` 缺任何一份都拒绝出片（[bundle-the-renderer-ending-media](../architecture/2026-09-22-bundle-the-renderer-ending-media.zh.md)、[ending-plays-at-its-own-speed](2026-09-26-ending-plays-at-its-own-speed.zh.md)），所以丢失发生在"包是对的"与"安装包可发"之间。这已是第三次"资源没进包"，因此修法必须包含一个会点名缺失素材的闸门，而不是再让某次会话去发现它。

## Decision

`apps/desktop/electron-builder.config.mjs` 设置 `nsis.preCompressedFileExtensions: []`，并由 `apps/desktop/tests/nsis-payload-assets.spec.ts` 钉住该值。

成因在上游 app-builder-lib 26.15.3 的 `out/targets/nsis/NsisTarget.js`：其 NSIS 选项把 `preCompressedFileExtensions` 默认为九个媒体扩展名（`.avi .mov .m4v .mp4 .m4p .qt .mkv .webm .vmdk`，`:44`），这些扩展名变成 `excluded: ['*.mp4', …]`（`:84`），再变成对 `app-64.7z` 载荷执行的 `7z -xr!*.mp4`（`targets/archive.js:125-131`）。这些文件本应作为单独的安装器条目补回，但补回遍历（`:666-688`）从 `resources/` 往下走时会剪掉路径以 `node_modules` 结尾的每个目录（`:672-676`）。随运行时包分发的媒体素材正落在 `resources/app.asar.unpacked/dsh/node_modules/…`，于是既被排除出归档、又永远不会被补回：任何一份安装副本都拿不到它。`ending_audio.mp3`、`template.json` 以及其余 4,180 个载荷文件不受影响，因为它们的扩展名不在该列表里；而 electron-builder 早已把该 `.mp4` 复制进 `app.asar.unpacked`（其 asar 头记录 `unpacked=true, size=904502`），所以此前每一个只读 `app.asar` 的检查都看到了一份安装器并不携带的文件。把该列表清空即归档整个应用目录，这本就是载荷的用途。

渲染器现在区分"片尾文件缺失"的两种成因，且**不放宽**字节判据。`requireEndingAssetFile()`（[render.ts](../../../../packages/drama/tool-episode-render/src/render.ts) 为两个片尾输入调用它）同时判定所给路径与它的同目录兄弟文件：两份随包片尾素材共用一个目录，因此兄弟文件字节正确就证明目录已到达、缺的只是这一份，该文案据此给出"安装损坏"及其修法；而两者都不在的目录则判为路径写错，并重申随包路径与 SHA-256。`requireShippedEndingAsset()` 依旧拒绝任何不是随包字节的文件，且仍在第一条媒体命令之前。

安装包验收改为按**钉住的随包素材清单**核对——`dsh-drama-skills/**/assets/**` 下全部三份的文件名、字节数与 SHA-256——对照安装器自己的 `app-64.7z` 成员，并在以下情况失败：缺一份或字节不符、载荷携带了清单未钉住的素材、asar 成员标为 `unpacked` 而载荷里没有它。执行者是 `.local/verify-installer.mjs`，记录写在 `.local/release/install-verification-checklist.md`；两者都在 gitignore 的 `.local/` 下，所以**提交进仓库**的守卫是配置值及其 spec。

## Alternatives considered

**把片尾素材移出 `node_modules`。** 直接复制进 `resources/`（或经由 `extraResources`）可以绕开剪枝，但被否决：工具自身的契约、技能文本与 `delivery.ts` 都按 `dsh-drama-skills` 内的路径点名这两份素材，搬走会让"随包路径"变成第二条只存在于安装态的路径。

**保留默认列表，再用 `extraFiles` 补一份 `ending_effect.mp4`。** 这会把同一份文件复制到工具从不读取的路径下，指向随包技能目录的调用方依旧被拒绝，而且下一个随包媒体素材还要再手工复制一遍。

**只从 `preCompressedFileExtensions` 里删掉 `.mp4`。** 这样能给其余八个扩展名保留一项安装包体积优化，但被否决：当前载荷里 `node_modules` 之外没有任何文件使用其中任一扩展名，这条列表今天不产生收益，而重新列出它只会让未来的默认值变化悄悄漂移。

**安装后修复。** 任何事后写入该素材的步骤照样得把字节放进安装包，而且会留下一段"已安装产品缺少交付前置"的窗口。

## Consequences

Windows 安装包现在归档此前以单独 NSIS 条目存放的媒体，因此这些字节在 `app-64.7z` 里按 LZMA2 压缩；已压缩媒体收益很小，代价是现有媒体带来的构建时间，而不是正确性。清空该列表是正确的取舍，因为载荷的契约就是完整性。

这条规则住在传递依赖里，所以提交进仓库的 spec 钉的是我们的配置而非上游行为：只有当 app-builder-lib 升级改变了 `preCompressedFileExtensions: []` 的含义时，被排除的扩展名才会变化；而无论如何，安装包闸门都会在载荷上失败。该闸门需要一份已构建的安装器，因此它在发布验收时运行，而不是在 CI 里。

## Verification

`pnpm vitest run apps/desktop/tests/nsis-payload-assets.spec.ts` 通过，electron-builder 配置的其它消费方（`apps/desktop/tests/macos-signature.spec.ts`）不受影响。

`node .local/verify-installer.mjs <installer> <workDir>` 在已构建的 `muse-med-0.1.6-alpha.2-win-x64.exe` 上以 exit 1 结束，唯一失败项是 `ending_effect.mp4: unpacked in app.asar but absent from the installer payload`，另两份素材均 PASS；其对照表为 `PASS ending_audio.mp3`、`ABSENT ending_effect.mp4`、`PASS template.json`。

复现这两个步骤（对已构建的运行时树执行 `7z a -xr!*.mp4`，再对 `resources/` 跑一遍补回遍历）：默认列表下归档里没有 `ending_effect.mp4`，清空列表后两份素材都在，且补回遍历收集到 0 个文件——与出厂载荷的内容一致。
