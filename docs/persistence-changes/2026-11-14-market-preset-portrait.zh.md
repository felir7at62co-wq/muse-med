---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-market-preset-portrait

[English](2026-11-14-market-preset-portrait.md) | 中文

## 概述

在市场 Session 绑定记录的清单中保留可选的 presetPortrait 资源标识。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-market-preset-portrait
baseline: false
changes:
  - root: "event:muse-market/bound"
    previous: "2026-11-09-market-session-binding"
    after: "40e3ad89ce197a959664a6b2bf0d3de17f76d285b1187e0a778474b856f24552"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含该字段的已有绑定保持原有含义。当前和先前的绑定投影均保留此可选展示值，不改变记录的归档 SHA、Skill 路径、调用设置或版本选择。先前的云端解析器会拒绝含形象字段的元数据，而不会改装其他版本；其清单编解码器会省略该字段，因此严格的本地归档比较可拒绝由此产生的不一致。此变更不重写已提交的 Session 代际，也不改变 Session 头或信封。

作者元数据接纳同一个可选字段。为未绑定形象的包准备上传时会创建独立的不可变归档；已有归档、已绑定 Session 和激活默认值保持原选择。将该字段移至共享元数据接口不会改变其存储在清单中的表示。

<a id="verification"></a>
## 验证

cloud-values、cloud-transport 和 package 测试组共 70 项通过，覆盖已发布形象元数据、无效资源标识、未知云端字段和原始归档往返。binding-projection 测试组四项通过，覆盖 fork、冷恢复和不一致绑定的拒绝。实际执行的当前与先前读取器对比确认：两种投影都保留含形象字段的绑定，当前云端解析器接纳、先前云端解析器拒绝，且先前编解码器省略该可选字段。

本地 service 和 package 测试组共 37 项通过，覆盖作者元数据保留、不可变上传准备、资源字节保留、重复请求、默认值不变、无效标识和已修改来源的拒绝。聚焦的生成 Remote 测试通过，覆盖上传准备请求和返回的形象元数据。

<a id="dev-note"></a>
## 开发备注

无。
