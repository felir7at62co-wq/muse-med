# Agent Note: 剧变转高清路由与未知写入

Status: implemented

[English](2026-09-21-jubian-upscale-route.md) | 中文

## Problem

推测出的 `/aigc/storyboard/upscale` 端点阻断了高清转换。失败请求仍属于未知写入，因此修复路由不能绕过其账本记录。

## Decision

转高清分派使用 `POST /aigc/storyboard/hdConversion`。公开前端的 [917c 模块](https://web.jubianai.net/static/js/chunk-7652bf40.378292fb.js) 将函数 `f` 导出为 `h`，该函数向此路由提交数据；[ScriptHDConversionDialog](https://web.jubianai.net/static/js/chunk-46be48c6.54967903.js) 通过此导出提交表单。表单使用任务类型 20 和 SeedVR2 选择字段，不含 `videoResolution`。已有时长保持不变；`Math.floor` 仅用于弹窗的备用时长。

现有构造器与账本保持不变。在错误路由上被记录为 unknown 的 key 仍直接重放，不发送任何请求。调用方考虑重新提交前必须核对提供方任务与费用；路由修复本身不构成提交授权。

分辨率提示不构成高清处理授权。`needs_upscale` 保留数值比较与可空布尔输出；工具指导不把它当作内容可用性判定或付费义务。SD2.5 默认使用原片，不提交或等待高清。任何模型的具体高清操作都需要用户明确要求或授权；用户要求时仍允许处理 SD2.5。导出尺寸与源分辨率分别报告，因为本地缩放不会恢复源画质。

## Alternatives considered

**自动换新 key 重试正确路由。** 路径不同不能证明首次尝试没有生效或计费；这样会绕过账本保护。

**增加分辨率字段或重写请求体。** 对未处理的源视频，公开表单与现有请求构造器已一致，无需添加猜测字段。

**为每个低于目标的结果自动购买高清，或全面禁止 SD2.5 高清。** 分辨率不是用户授权，而按模型全面禁止会拒绝用户的明确请求。离线输出测试覆盖指定与未指定目标、保持不变的 true/false/null 值，以及禁止自动付费的工具描述。

## Consequences

局部分派测试锁定路由、完整请求体、受理任务 ID，以及已受理和历史未知 key 的零网络重放。构造器与账本测试覆盖其现有校验。本次修复未通过计费请求验证；运行时加载和提供方对账仍由调用方负责。已处理源视频的选择不属于此次仅修路由的范围。
