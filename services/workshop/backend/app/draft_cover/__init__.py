"""draft_cover — 草稿封面生成 (image2 + SVG fallback)

业务流程:
1. 用 LLM 把 draft (title + tags + user_input + outline.synopsis) 提炼成
   一段英文 image prompt, 让封面与剧情真实相关.
2. 调 kegeai gpt-image-2 生成 720x1080 竖版海报 PNG.
3. 失败重试最多 3 次; 全部失败才落地一张程序化 SVG (确定性渐变 + 标题 + 题材).
4. 写入 draft.cover_url, 后续直接展示.

API 入口 (路由前缀 /v1/drafts):
  POST /{draft_id}/cover/generate    用户/admin 触发单张
  GET  /{draft_id}/cover/status      查状态
  POST /admin/cover/backfill         admin 批量回填全部空封面 (后台串行)
  GET  /admin/cover/backfill/status  批量进度
  GET  /uploads/draft-covers/{file}  静态文件回读 (无鉴权, 用户 cover_url 直接打)
"""

from .routes import router

__all__ = ["router"]
