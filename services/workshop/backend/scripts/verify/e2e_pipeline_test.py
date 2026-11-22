"""端到端流水线验证（第七步测试）：3 集完整管线"""
import asyncio, sys, logging
sys.path.insert(0,"/app")
logging.basicConfig(level=logging.WARNING)

async def main():
    from app.stages.story_bible import generate_story_bible
    from app.stages.outline_gen import generate_outline_pipeline
    from app.stages.scene_card import derive_from_beats, expand_cards_with_llm, write_cards_to_episode, cards_for_episode
    from app.stages.storyboard_gen import generate_storyboard_by_scene, generate_storyboard_from_outline
    from app.check.review import _sb_stats, _SILENT_SCENES_MAX, _ACTION_RUN_MAX, _DIALOGUE_RATIO_MIN, _WORD_LO, _WORD_HI

    DIRECTION = "重生复仇短剧：女主上辈子被继母和妹妹害死，重生回订婚宴当天。都市豪门，女频，要爽。"
    EPISODES = 3
    WORD_TARGET = 2000

    print("=== 步骤 1：生成故事圣经 ===")
    bible = await generate_story_bible(DIRECTION, provider="gemini")
    print(f"  剧名: {bible.get('title')}")

    print("\n=== 步骤 2：生成大纲 ===")
    outline = await generate_outline_pipeline(
        user_input=DIRECTION,
        chapter_count=EPISODES,
        provider="gemini",
    )
    chapters = outline.get("chapters") or []
    print(f"  生成 {len(chapters)} 集大纲")
    for ch in chapters:
        beats = ch.get("beats") or []
        print(f"  第{ch.get('order')}集《{ch.get('title')}》beats={len(beats)}")

    print("\n=== 步骤 3：生成场景卡 ===")
    for ch in chapters:
        if not ch.get("beats"):
            print(f"  第{ch.get('order')}集：无 beats，跳过")
            continue
        cards = derive_from_beats(ch)
        expanded = await expand_cards_with_llm(ch, cards, provider="gemini")
        write_cards_to_episode(outline, ch["order"], expanded)
        intent_cnt = sum(1 for c in expanded if c.get("intent"))
        print(f"  第{ch.get('order')}集：{len(expanded)} 张卡，intent {intent_cnt}/{len(expanded)}")

    print("\n=== 步骤 4：按场生成剧本 ===")
    all_storyboards = {}
    for ch in chapters:
        order = ch.get("order")
        ep_cards = cards_for_episode(outline, order)
        has_intent = any(c.get("intent") for c in ep_cards)
        if ep_cards and has_intent:
            shots = await generate_storyboard_by_scene(
                outline=outline, chapter_order=order,
                provider="gemini", word_target=WORD_TARGET)
            method = "按场"
        else:
            shots = await generate_storyboard_from_outline(
                synopsis=ch.get("synopsis",""), chapter_title=ch.get("title",""),
                episode_order=order, provider="gemini", word_target=WORD_TARGET)
            method = "整集"
        all_storyboards[order] = shots
        stats = _sb_stats(shots)
        print(f"  第{order}集（{method}）：{stats['scenes']} 场，{stats['chars']} 字，对白 {int(stats['dialogue_ratio']*100)}%")

    print("\n=== 步骤 5：验收单 ===")
    ok = 0
    for order, shots in sorted(all_storyboards.items()):
        stats = _sb_stats(shots)
        issues = []
        if stats["chars"] < _WORD_LO * WORD_TARGET:
            issues.append(f"字数偏少({stats['chars']})")
        if stats["dialogue_ratio"] < _DIALOGUE_RATIO_MIN:
            issues.append(f"对白比例低({int(stats['dialogue_ratio']*100)}%)")
        if stats["silent_scenes"] > _SILENT_SCENES_MAX:
            issues.append(f"静默场多({stats['silent_scenes']})")
        if stats["max_action_run"] >= _ACTION_RUN_MAX:
            issues.append(f"连续动作行({stats['max_action_run']})")
        if not issues:
            ok += 1
            print(f"  第{order}集：✅ 通过")
        else:
            print(f"  第{order}集：⚠ {'; '.join(issues)}")

    print(f"\n=== 流水线完成：{len(chapters)} 集大纲，{len(all_storyboards)} 集剧本，验收通过 {ok}/{len(all_storyboards)} ===")

asyncio.run(main())
