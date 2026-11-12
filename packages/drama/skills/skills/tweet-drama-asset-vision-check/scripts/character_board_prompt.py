"""Compose a four-view character board while preserving the caller's art direction.

This local helper emits prompt fields only. It neither submits generation nor
judges an image, and it does not choose a medium, provider, reference or model.
"""
import argparse
import json
import sys


BOARD_LAYOUT = """人物资产交付版式：16:9横版白底，一行四个独立竖向区域，从左到右固定为A、B、C、D。四区内恰好出现同一角色四次：一个胸像加三个全身，不是一个胸像加两个全身。区域编号只用于构图说明，不在图片里绘制文字、标签、边框或分隔线。
A区（横向0%—34%）：正脸平视胸像，完整头顶、发型、清晰五官、双肩及上胸，脸部不遮罩。
B区（横向34%—56%）：正面0°全身，从完整头顶至鞋底，只有正脸皮肤覆盖贴合脸部的纯白遮罩。
C区（横向56%—78%）：独立的严格侧面90°全身，整个头、胸腔、骨盆和双脚一起转向画面左方，看到单侧面部轮廓，不能正面身体仅转头，也不能用四分之三面。完整头顶至鞋底，只有侧脸皮肤覆盖贴合侧脸轮廓的纯白遮罩。必须给此侧面保留独立空间，不与正面或背面合并。
D区（横向78%—100%）：背面180°全身，背向观察者，完整头顶、后脑、发型、颈部、后背衣服及鞋底，完全不遮罩，不加白块或白条。
B、C、D三张全身图同一体型、同一套衣服、同一身高尺度，头顶和鞋底分别对齐，四区留白且互不重叠，不裁头发或双脚。仅B正脸与C侧脸共两处白色遮罩；保留头发、耳朵、头部轮廓、颈部和衣领。A胸像与D背面均不遮罩。正面、严格侧面、背面缺一不可，不能用放大胸像或扩大正背图替代C区。
四个区域的画风、材质与用光均遵循开头的画风提示词，不模仿版式示意图的人物五官、形象或画风。"""

EDIT_INSTRUCTION = """编辑当前候选人物板：保留原人物五官、发型、服装和输入画风，将原有胸像、正面、背面分别放在A、B、D区，在正面与背面之间新增同一人物的严格侧面全身C区。适当缩小已有三个区域，为侧面单独腾出空间；不要删除背面。最终为胸像＋正面全身＋侧面全身＋背面全身四个独立区域，仅正侧脸遮白，胸像和背面不遮罩。这是对本次候选的版式修复，不重新设计角色。"""


def build_prompt(style_prompt, character_prompt, *, edit_existing=False):
    """Return tool prompt fields without altering the supplied style or character."""
    for name, value in (("style_prompt", style_prompt), ("character_prompt", character_prompt)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be non-empty text")
    instruction = EDIT_INSTRUCTION + "\n" if edit_existing else ""
    return {
        "prompt": f"{style_prompt}\n{instruction}人物设定：{character_prompt}\n{BOARD_LAYOUT}",
        "image_aspect_ratio": "16:9",
    }


def main(argv=None):
    """Write one JSON prompt to stdout; missing art direction fails before output."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--style-prompt", required=True)
    parser.add_argument("--character-prompt", required=True)
    parser.add_argument("--edit-existing", action="store_true", help="Repair the current candidate without redesigning it")
    args = parser.parse_args(argv)
    try:
        result = build_prompt(args.style_prompt, args.character_prompt, edit_existing=args.edit_existing)
    except ValueError as error:
        parser.error(str(error))
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
