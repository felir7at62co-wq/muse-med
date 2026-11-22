"""音频生成工作台 (audio_studio)。

能力:
- 语音克隆 TTS: 上传参考音色 + 输入文本 -> RunningHub IndexTTS-1.5 工作流合成
- 产出转存 OSS, 30 天过期清理
- 与生图版块共享 RunningHub 100 并发

调度/抗重启思路与 image_studio 高清放大一致 (远端异步工作流 + rh_task_id 续查)。
"""
from .routes import router as audio_studio_router  # noqa: F401

__all__ = ["audio_studio_router"]