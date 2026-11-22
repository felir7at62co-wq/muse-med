"""导出剧本为纯文本和Markdown格式"""
from __future__ import annotations


def storyboard_to_text(title: str, ch_title: str, shots: list[dict]) -> str:
    """将剧本数据转为纯文本格式"""
    lines = [f"{title} - {ch_title} 剧本", "=" * 40, ""]
    for shot in shots:
        if not isinstance(shot, dict):
            continue
        sn = shot.get("scene_no") or shot.get("shot_no", "")
        tl = shot.get("time_loc", "")
        chars_list = shot.get("characters", [])
        chars = ", ".join(chars_list) if isinstance(chars_list, list) else str(chars_list)

        lines.append(f"场:{sn}")
        if tl:
            lines.append(f"景:{tl}")
        if chars:
            lines.append(f"人物:{chars}")
        sub = shot.get("subtitle", "")
        if sub:
            lines.append(f"(出字幕: {sub})")

        # scene-based format (elements)
        for elem in shot.get("elements", []):
            if not isinstance(elem, dict):
                continue
            if elem.get("type") == "action":
                lines.append(elem.get("content", ""))
            elif elem.get("type") == "dialogue":
                mode = f"({elem.get('mode')})" if elem.get("mode") else ""
                action_hint = f" ({elem.get('action')})" if elem.get("action") else ""
                lines.append(f"{elem.get('character', '')}{mode}{action_hint}: {elem.get('content', '')}")

        # shot-based format fallback
        if not shot.get("elements"):
            if shot.get("action"):
                lines.append(f"\u25b3{shot['action']}")
            if shot.get("dialogue"):
                lines.append(f"对白: {shot['dialogue']}")

        lines.append("")

    return "\n".join(lines)


def storyboard_to_markdown(title: str, ch_title: str, shots: list[dict]) -> str:
    """将剧本数据转为Markdown格式"""
    lines = [f"# {title} - {ch_title}", ""]
    for i, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        sn = shot.get("scene_no") or shot.get("shot_no", i + 1)
        tl = shot.get("time_loc", shot.get("location", ""))
        chars_list = shot.get("characters", [])
        chars = ", ".join(chars_list) if isinstance(chars_list, list) else str(chars_list)

        lines.append(f"## 场 {sn}")
        meta = []
        if tl:
            meta.append(f"**景**: {tl}")
        if chars:
            meta.append(f"**人物**: {chars}")
        if meta:
            lines.append(" | ".join(meta))
        lines.append("")

        for elem in shot.get("elements", []):
            if not isinstance(elem, dict):
                continue
            if elem.get("type") == "action":
                lines.append(f"> {elem.get('content', '')}")
            elif elem.get("type") == "dialogue":
                mode = f" *({elem.get('mode')})*" if elem.get("mode") else ""
                lines.append(f"**{elem.get('character', '')}**{mode}: {elem.get('content', '')}")
            lines.append("")

        # fallback
        if not shot.get("elements"):
            if shot.get("action"):
                lines.append(f"> {shot['action']}")
            if shot.get("dialogue"):
                lines.append(f"**对白**: {shot['dialogue']}")
            lines.append("")

    return "\n".join(lines)
