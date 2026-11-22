"""视频反推剧本模块

核心流程:
    用户上传 N 个视频(按集顺序) → 一个草稿 → 每集独立调用豆包视频理解
    (doubao-seed-2-1-pro, 见 config.ark_video_understand_model)
    → 产出 章节正文 + 剧本数据 → 落库
"""
from .doubao_video import analyze_video_file
from .video_pipeline import orders_with_text, resume_sources, run_video_to_script_pipeline
from .character_replace import apply_character_mapping

__all__ = [
    "analyze_video_file",
    "run_video_to_script_pipeline",
    "orders_with_text",
    "resume_sources",
    "apply_character_mapping",
]
