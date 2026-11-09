---
kind: upgrade-guide
description: Skill 激活引入 version-2 本地账本和必读的 Session 版本绑定，较旧构建可能拒绝读取。
---

# Skill 发行包存储与 Session 绑定

[English](guide.md) | 中文

## 变更

私有 Desktop 组合现在挂载本地 Skill 存储及独立的 `@deepseek-ai/dsh-muse-market/activation` 组件。加载激活组件时，会以空默认集合将 version-1 `installations.json` 迁移到 version 2。在有界原子替换之前，会通过独占创建的 `installations.v1.backup.json` 保留完全相同的原始字节。基础安装记录仍返回 `enabled: false`；激活状态通过 `defaults()` 和 `binding()` 读取。

Session 头部仍为 [V4](../../../session-format-status.zh.md)，但参与激活的 Session 会在首次模型请求前记录必读的 `muse-market/bound`。不认识该必读事件的构建会安全拒绝读取日志。新读取器可接受旧日志；已执行但无绑定的 Session 保持空的市场选择，空白 Session 则在首次任务时选择当前默认值。继承完整前缀的 fork 继承其已记录选择。兼容性取决于具体读取器构建及其已知事件类型，不能只看产品版本标签。

## 迁移

1. 停止相关 profile，在原始 Session 日志之外备份完整的发行包 `root`。一同保留 `installations.json`、已有的 `installations.v1.backup.json` 以及所有被引用的包目录。仅备份 Session 不会包含发行包存储。
2. 需要激活的具名 profile 按[包 README](../../../../packages/host/muse-market/README.zh.md) 同时挂载基础服务及独立的 `/activation` 入口。仅需存储的 profile 可只保留基础行。已有文件系统 Skill 不会被移动或自动选中。平铺 Markdown Skill 仍需先建立仅含 `SKILL.md` 和预期资源的独立目录，才能准备发行包。
3. 从 version 1 迁移后，确认 version-2 账本的初始默认集合为空，并保留原始备份字节。已有 version-2 选择保持不变。后继记录超限或备份冲突时会拒绝迁移；保留原始文件并解决错误，不要覆盖备份。仅认识 version 1 的读取器不能读取后继账本；保留备份不代表支持自动降级。
4. 读取 `ctx.museMarketActivation.defaults()`，再显式调用 `setDefault({skillName, expected, target})`，传入观察到的归档 SHA 或 null，以及所选的精确 SHA 或 null。验证新任务绑定该版本，而已有绑定的 Session 保留此前版本。通过 `binding({sessionId})` 区分 `blank`、`bound` 和 `legacy`；存储中的 `enabled` 字段不能回答这个问题。
5. 保留每个已记录版本的精确 ZIP 和匹配的展开资源。缓存字节缺失或变化时，加载会拒绝，不会选择其他版本；请从备份恢复完整且匹配的缓存。停用默认值不会释放 Session 引用，因此移除仍可能拒绝。在切换构建前，使用副本验证必读事件和账本支持情况；保留原始日志和完整存储备份，以便恢复。
