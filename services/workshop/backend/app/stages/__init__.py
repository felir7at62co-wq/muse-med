"""M5: 三阶段创作（大纲 / 编剧 / 剧本）。

stages.router 暴露：
  - GET    /v1/stages/drafts                列出草稿（"我的草稿"）
  - POST   /v1/stages/drafts                创建空草稿
  - GET    /v1/stages/drafts/{id}           获取草稿（含章节/剧本状态）
  - PATCH  /v1/stages/drafts/{id}           编辑（标题/字数目标/锁定/手改 outline）
  - DELETE /v1/stages/drafts/{id}           删除

  - POST   /v1/stages/drafts/{id}/outline       生成大纲（流式 SSE）
  - POST   /v1/stages/drafts/{id}/outline/lock  锁定大纲（确认进入下一阶段）

  - GET    /v1/stages/drafts/{id}/chapters       列章节
  - POST   /v1/stages/drafts/{id}/chapters/{k}   生成第 k 章（流式 SSE）
  - PATCH  /v1/stages/drafts/{id}/chapters/{k}   手动编辑/锁定
  - DELETE /v1/stages/drafts/{id}/chapters/{k}   删

  - POST   /v1/stages/drafts/{id}/storyboards/{k}  生成第 k 章剧本
  - PATCH  /v1/stages/drafts/{id}/storyboards/{k}  锁定/编辑

M5.1 先实现 drafts CRUD + outline 生成；M5.2 加章节滚动；M5.3 加剧本。
"""

from .router import router

__all__ = ["router"]
