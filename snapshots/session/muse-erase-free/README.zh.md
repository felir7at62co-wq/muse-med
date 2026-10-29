# 已核实免费去字幕快照

[English](README.md) | 中文

这个手写 Session 通过发布的 Headless 配置和隔离的 HTTP 供应商运行真实 Jubian 工具。它固定验证实时目录中唯一匹配的火山条目价格为 `0 元/条`、项目预算为零，以及提交前已持久化的 `0.00 CNY` 意图。重放原幂等键不发出 HTTP 请求；价格变为正数后，新幂等键会在新增意图或提交前被拒绝。测试未观察到人工授权、真实供应商请求或实际结算费用。

`session.v4.jsonl` 是规范重放输入；`writer.expected.jsonl` 记录当前输出。`workspace.expected/erase-free-proof.json` 独立核对供应商调用、账本状态，以及模型是否收到每条工具结果。
