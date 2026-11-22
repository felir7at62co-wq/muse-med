"""固定工作流注册表 (声明式)。

新增工作流: 往 WORKFLOWS 加一条配置即可; 若用到新的 post_step, 在 service._run_post_steps 里实现。
工作流 = 隐藏提示词前缀 + 锁定尺寸/画质 + 生成后的阶段链(post_steps)。
"""
from __future__ import annotations

# 画质档 -> 长边像素 (短边按比例算)
# ⚠ 必须与前端 lib/imageStudio.ts _LONG 及 providers._size_to_image_size_tier
#   的阈值三处同口径。2026-08-15 由 {1920,2560,3840} 修正为 {1024,2048,3840}:
#   原值会让"选 1K"的长边 1920 被后端归进 2K 档、"选 2K"的 2560 归进 4K 档。
QUALITY_LONG_EDGE = {"1K": 1024, "2K": 2048, "4K": 3840}

# 宽高比 -> (w_ratio, h_ratio) — 10 个实测可用比例, 与前端 IMAGE_ASPECTS 对齐
ASPECT_RATIOS = {
    "1:1": (1, 1),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "4:5": (4, 5),
    "5:4": (5, 4),
    "21:9": (21, 9),
}


def resolve_size(aspect: str, quality: str) -> str:
    """按 宽高比 + 画质档 计算像素 size 字符串 (如 '1152x2048')。"""
    wr, hr = ASPECT_RATIOS.get(aspect, (1, 1))
    long_edge = QUALITY_LONG_EDGE.get(quality, 1024)
    if wr >= hr:
        w = long_edge
        h = round(long_edge * hr / wr)
    else:
        h = long_edge
        w = round(long_edge * wr / hr)
    # 对齐到 8 的倍数 (多数图像/放大管线更友好)
    w = max(64, (w // 8) * 8)
    h = max(64, (h // 8) * 8)
    return f"{w}x{h}"


GRID_9_PREFIX = (
    "生成要求：\n"
    "基于参考图，生成一张每一分镜比例都为9：16的3x3网格分镜图，三行三列的分镜图，"
    "共计9个分镜。需要包括不同景别、不同角度的9张分镜图。分镜图之间具有连贯性，"
    "每个分镜图的比例都为9：16。确保人物角色、服装、发型、环境一致。"
    "确保所有分镜具有一致的色彩分级。确保分镜图为3行3列且比例都为9：16，"
    "每个分镜的大小完全相等，画面中不出现任何文字、符号、标题、字幕。"
    "每个分镜之间不要出现边框。确保人物面部无畸变、崩坏。"
)

# 工作流注册表
WORKFLOWS: dict[str, dict] = {
    "grid_9": {
        "id": "grid_9",
        "name": "一次九张",
        "desc": "3×3 九宫格分镜, 自动切成 9 张 9:16 竖图",
        "prompt_prefix": GRID_9_PREFIX,
        "force_aspect": "9:16",     # 锁定整张网格为 9:16
        "default_quality": "4K",    # 网格图建议高分辨率, 切割后每张才够清晰
        "post_steps": ["split_3x3"],  # auto_hd 由用户 高清 勾选决定, 不写死
    },
}


def get_workflow(wid: str | None) -> dict | None:
    if not wid:
        return None
    return WORKFLOWS.get(wid)


def list_workflows() -> list[dict]:
    """给前端的精简列表 (不含隐藏前缀)。"""
    return [
        {"id": w["id"], "name": w["name"], "desc": w["desc"],
         "force_aspect": w.get("force_aspect"), "default_quality": w.get("default_quality")}
        for w in WORKFLOWS.values()
    ]
