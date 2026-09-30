# Agent Note: 按固定的 Host 审核社区插件

Status: implemented

[English](2026-09-27-community-plugin-host-version-review.md) | 中文

## Problem

社区源码直接导入 Host API。导出被删除会导致编译失败；服务方法语义变化则可能仍能编译，却运行错误。未审核这两类情况就移动 Host 固定版本，会发布未经检查的兼容性声明。

## Decision

[社区构建器](../../../../third_party/plugins/build.mjs)要求已审核的 Host 版本，当前为 `0.1.7-rc.8`，并在产物 peer 候选与 `SOURCE.json` 中记录。Host 升级必须先审核，再移动该检查。[upstream.json](../../../../upstream.json)独立记录 fork 的上游源码固定版本。

### 消息来源归属

Ponytail 在 `MessageSourceMap` 中声明自身的 `ponytail` 成员，并发送 `{ kind: 'ponytail' }`。通用 `plugin` 来源被删除，不构成放宽断言或在文档化扩展点之外发明 kind 的理由。

### 基于 Config 的凭证设置

当前 settings 服务以组合条目 ID 命名设置段，并从该行 Config 派生各段。[飞书设置检查](../../../../packages/host/feishu-settings/tests/service.spec.ts)启动真实 config-editor/settings 组合，并定位 `feishu-channel`。[桌面 Loader 检查](../../../../apps/desktop/tests/feishu-setup-loader.spec.ts)通过随包补丁层验证启用和凭证保存。

[审核后的桥接 provider](../../../../third_party/plugins/compatibility/muse-feishu-channel.mjs)消费已解析 Config，并解引用 volatile 凭证。凭证通过 `settings.update(entryId, values)` 持久化；`settings.get(namespace)` 和插件自注册设置段不是受支持的替代。volatile schema 的输出包含引用，输入包含普通值，单一对象类型无法描述两者。

### 源码审核

[桥接覆盖](../../../../third_party/plugins/compatibility/bridge-desktop.mjs)在暂存适配前检查保留的上游模块摘要。运行时 API 导入必须存在于已构建 ESM 导出中；被擦除的 TypeScript enum 无法由 JavaScript 插件导入。产物保留上游源码固定版本和许可证，仅暴露审核后的产品 provider。

## Verification

接受 Host 固定版本前，对各选定源码使用当前仓库已构建 Host 包打包并执行产物检查。[构建测试](../../../../third_party/plugins/build.test.mjs)从全新暂存重新构建，并比较导出文件和 tarball 字节。[桥接检查](../../../../third_party/plugins/compatibility/bridge-desktop.test.mjs)拒绝未经审核的源码，并运行当前 Host 元数据服务；[传输检查](../../../../third_party/plugins/compatibility/bridge-remote.test.mjs)覆盖流式传输、原生 WebSocket 帧、取消、拒绝及重连。真实飞书收发与打包后的启用仍是独立、未验证的检查。

## Alternatives considered

**移动固定版本，仅编译。** 编译无法发现启用、设置归属或退出语义变化。

**给桥接独立设置命名空间。** 产品凭证页面与桥接会定位不同设置段。

**删除凭证记录，不把字段标记为 volatile。** settings 拒绝写入普通字段；绕过它改用其他编辑器，也不能保留产品页面的设置段语义。

**随旧 provider 删除启用检查。** 替换后的实现仍需覆盖产品组合与已保存凭证在真实 Loader/settings 服务中相交的路径。

## Consequences

产物 peer 候选和源码记录仅声明已审核 Host。能力与生命周期检查伴随编译，下一次 Host 升级在移动固定版本前重新运行这些检查。暂存修改与保留的上游快照保持分离。产物检查要求当前 Host 构建输出，不能用仅源码导入替代发布的 ESM 入口。
