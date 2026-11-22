"""视频提示词生成模块.

工作流 (两段式):
  Step 1 [planner]: 分镜全文 → AI → 任务合并方案 (含时长/概要/shot_nos)
  Step 2 [renderer]: 任务方案 + 模板 → AI → 最终模型 prompt 字符串

公开 API:
  - POST /v1/drafts/{id}/prompts/plan      规划阶段
  - POST /v1/drafts/{id}/prompts/render    渲染阶段
  - GET  /v1/drafts/{id}/prompts            列出
  - PATCH/DELETE/regenerate/export         编辑维护

模块路由对外仅暴露 router (在 main.py 注册).
"""
from .routes import router

__all__ = ["router"]
