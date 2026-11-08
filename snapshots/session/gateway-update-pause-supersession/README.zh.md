---
description: "通过无密钥认证连接验证 Gateway 暂停取代与生产者排空。"
kind: "reference"
---

# Gateway 更新暂停取代

[English](README.md) | 中文

普通 Loader 和随包 Headless profile 运行原生 fixture（测试前置数据）工具，调用生产 Gateway、Web 服务器、Connection、访问服务和 Typert 注册表。经过认证的回环 WebSocket 调用已声明的流服务，其 `next()` 和 `return()` 操作由显式释放屏障控制。

恢复后允许替代流连接，释放旧迭代器的 `return()` 会使旧暂停以已被取代为由拒绝，同时替代流保持连接。下一次暂停关闭替代流，并等待仍在运行的旧生产者 `next()` 完成后才结束。实际工具结果进入下一次模型请求，`workspace.expected/gateway-pause-proof.json` 记录经过校验的观察事实。模型响应和生产者时机使用受控 fixture 输入，不联系外部供应商。
