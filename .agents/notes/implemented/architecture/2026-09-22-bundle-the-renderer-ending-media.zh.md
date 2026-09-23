# Agent Note: Bundle the renderer's ending media with the drama skills package

Status: implemented

[English](2026-09-22-bundle-the-renderer-ending-media.md) | 中文

## Problem

每一集成片的结尾都是：最后一镜定格，叠加片尾特效视频，再把片尾音延迟到正片结束处。后台合成技能要求显式给出这两条路径，`drama_render` 缺任何一个都不渲染；工具自己的参数说明已经写明它们是**技能的** `assets/ending_effect.mp4` 与 `assets/ending_audio.mp3`。维护包此前一个都不带，于是从本仓库加载技能的一次会话，只能去已退役的 `<DSH_HOME>/skills` 安装里把这两个文件翻出来，并在每次渲染调用里传绝对路径。`maintenance/excluded-sources.json` 把这项排除记成权利决定，让调用方自带路径，而工具文案却承诺技能自带这两个文件。

## Decision

`packages/drama/skills` 现在带这两份素材：`skills/tweet-drama-background-render/assets/ending_effect.mp4`（1.02 秒，1080×1920，H.264，无音轨）与 `ending_audio.mp3`（3.47 秒，192 kbps），并在 `package.json#files` 里逐条列名。调用方把这两个路径传给 `--ending-audio` 与 `--ending-effect`；没有任何代码解析默认值，文件缺失仍然让渲染失败，不会替换成别的素材。

操作者确认这两个文件是自己的素材，并授权把它们留在技能旁供本机使用。本包保持 `private: true` 与 `UNLICENSED`，README 明确写出这两份随包素材不构成公开再分发授权。`maintenance/excluded-sources.json` 不再把它们列为排除项。

## Alternatives considered

**继续从已退役的本机安装读这两个文件。** 它们现在就在那里，也不需要改仓库。代价是维护包在干净检出上根本渲染不出一集，而且工具的参数说明会一直描述一个只存在于一台机器上的路径。

**在 `drama_render` 里给这两个路径设默认值。** 设默认值可以让调用方不必指名，但工具没有可用来解析技能根目录的服务，而把包的绝对路径写死在 TypeScript 里，工作区一动就失效。显式传路径把「定默认值」这一步留在真正知道目录布局的地方——技能正文与读它的模型。

**只打包特效视频。** 特效是片尾里可见的那一半，也是更难复现的那份文件，但同一次渲染调用同时需要音频，只带一半仍然会因为同样的原因渲染失败。

## Consequences

本包的一次检出，现在不再依赖工作区之外的本机媒体，就能渲染出含片尾的完整一集。本包第一次再分发操作者提供的媒体，因此权利声明改为逐一点名这两份素材，而不再声称所有用户媒体都不进包；打包检查仍然逐文件列名，这也是这项例外可被复核的原因。
