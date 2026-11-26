---
description: "无密钥验证制作来源发布与待审核素材的预备处理。"
kind: "reference"
---

# 制作来源清单交接

[English](README.md) | 中文

随包 Headless profile 通过普通 Loader 使用真实 `drama_shot`、`muse_production` 和 `drama_render` 工具。仅将外部剧变传输和对应凭证查询替换为受控测试数据；不访问模型或付费生成端点。

录制的四次调用依次初始化已配置的视频模型、应用本地保存方案、重复应用同一方案、预备所选素材。首次 apply 通过一次免费 POST 和一次免费 PUT 保存一张原生卡，真实回读所选图片身份，再发布 `episode_packages/01/package.json`。重复 apply 返回 `unchanged`，保留完全相同的清单字节，且不重复任何远端写入。

`workspace.expected/` 是独立编写的完整文件系统预期。它核对来源清单、原生回执、所选画面和原声、字幕副本、预备时间线、待审核记录及供应商写入次数。场景自己的预期副本仅展开两条来源路径，独立合成声明的静音 PCM，不提交大型 WAV。清单声明 `mode: advisory` 和 `media_acceptance: false`。

待审核素材允许进行预备处理。断言把真实预备来源绑定到已发布包的哈希，核对所选画面和字幕字节、三秒 48 kHz 单声道 PCM 采样，保留待审核状态并要求没有最终导出。已有渲染器边界测试覆盖正式交付时的严格拒绝。源片由 FFmpeg 的 `color` 和 `anullsrc` 合成，是三秒、144×256、24 fps 的 H.264 色卡，带静音 AAC 音轨；不包含用户媒体、对白或文字。测试进程 PATH 必须提供 FFmpeg 和 FFprobe。独立 PCM 预期使用同版本可执行文件生成容器头，不使用产品的主音轨函数，也不复制实际输出字节。

`session.v4.jsonl` 保持为回放输入；refresh 将真实结果写入 `writer.expected.jsonl` 及提示词、工具结构侧车文件，始终不重写独立工作区预期。此场景仅规范化返回清单路径的系统分隔符。测试插件卸载时恢复原始凭证解析器和 fetch 传输。

使用 `pnpm run test:snapshot:refresh snapshots/session/headless.snapshot.ts -t muse-production-delivery` 刷新此场景，逐项审查差异，再使用 `pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t muse-production-delivery` 回放。在 PowerShell 中先设置 `$env:DSH_SNAPSHOT='refresh'`，改用 `test:snapshot` 命令，回放前运行 `Remove-Item Env:DSH_SNAPSHOT`。受控供应商数据证明发布和预备行为，不代表媒体质量通过、源片已审核或已经完成交付。
