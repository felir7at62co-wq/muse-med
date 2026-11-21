"""解说剧·角色开口（narration_dlg）。

用户需求（2026-10-30）：解说剧里角色真的开口说台词，情节靠旁白推进。

  · 解说音色全剧统一（TTS，项目 `narration_voice_url`）
  · 角色音色不要求统一（视频模型原生开口，不送音色参考）
  · 对白**逐字忠于原文**；旁白只由原文动作描述压缩，**不加情节**
  · 不允许长时间既无台词也无旁白
  · 剪辑只产出剪映草稿参数，编码渲染在用户电脑上做（不占服务器）
  · 用户只管输入（剧本 / 人物场景资产 / 解说音色），不参与中间环节

本模式**完全独立**于真人剧 / 解说剧 / 动漫剧：独立的 production_mode 值、
独立的任务 kind、数据只存在镜头 `profile_override` 的 `nd` 键里。
其他模式的代码路径看不到任何差别。

实测与设计记录：docs/PLAN-解说剧角色开口.md
"""

MODE = "narration_dlg"
LABEL = "🎙 解说剧·角色开口"
#: 可选出片模型。第一期只开 Seedance（用户裁定），2026-11-01 用户要求加入海螺 H3。
#: 项目选了别的模型时按 Seedance 2.0 出。H3 用自己的六段式提示词（build_prompt_h3）。
#: 2026-11-02 加入万相 wan3.0：用与 Seedance 相同的中文提示词（build_prompt），
#: 「图片N」由 provider 改写成万相的「图 N」。
MODELS = ("seedance-2.0", "seedance-2.0-mini", "minimax-h3-ref2v", "wan3.0-video")
H3 = "minimax-h3-ref2v"
WAN = "wan3.0-video"
DEFAULT_MODEL = "seedance-2.0"


def is_nd(proj) -> bool:
    return (getattr(proj, "production_mode", None) or "") == MODE
