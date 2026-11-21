"""镜流超级 Agent：LangGraph 编排 + 工具层 + 审批预算。

模块图（单向，不要成环）：

    api/runner → graph → registry/executor → tools_* → 各业务模块
                   ↓
                 store → db

`policy` 与 `prompt` 是叶子模块（只依赖 config），谁都可以引。
"""
