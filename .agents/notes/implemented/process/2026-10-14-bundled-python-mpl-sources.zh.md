# Agent Note: 随包分发 Python MPL 源码

Status: implemented

[English](2026-10-14-bundled-python-mpl-sources.md) | 中文

## Problem

离线 RapidOCR 的依赖包括使用文件级 copyleft 条款的证书数据和进度工具。若把这些条款归为宽松许可，就会让无关依赖在没有审查再分发义务的情况下通过检查。

## Decision

Python 声明检查仅接受采用 `MPL-2.0` 的 `certifi 2026.7.22` 和采用 `MPL-2.0 AND MIT` 的 `tqdm 4.70.1`。此例外属于随包 Python 检查；npm 运行时检查仍拒绝这些标识和条款。名称、版本或许可变化均需重新审查。

解包经过哈希验证的 wheel 时，不修改其中的 Python 源码、证书数据、版权声明或许可文件。共享运行时在 `dependencies/python-packages` 中保留这些源码和分发元数据。接收者直接获得受许可约束的源码文件，以及原有条款和[第三方声明](../../../../THIRD_PARTY_NOTICES.md)中的源码项目链接。原生运行时 smoke 检查这些材料仍然存在。[Mozilla 分发说明](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)解释了源码和声明义务。

此决定不取代独立的 [LibreOffice 分发决定](../architecture/2026-09-14-independent-libreoffice-kit.zh.md)；后者的例外适用于不同的软件包和源码载体。

## Alternatives considered

**把 MPL 归为宽松许可。** 这会削弱所有依赖的检查，并掩盖源码义务。

**使用本地实现替换这些上游依赖。** 这会新增证书更新和进度集成的维护责任，却没有消除产品限制。保留上游源码可以满足分发要求，同时继续使用有人维护的软件包。

## Consequences

打包时在解释器旁保留可读源码和声明。更新任一已审查依赖时，必须重新检查 wheel 及其条款。其他 wheel 中的原生库保留各自附带的许可；Python 项目级表格不能替代这些文件。
