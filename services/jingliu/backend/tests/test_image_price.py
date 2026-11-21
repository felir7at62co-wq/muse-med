"""生图单价：每张 25 分（2026-11-21 用户裁定由 15 分上调），所有生图模型同价。

报价说明与扣费流水里的「× 0.25 元」由 `pricing.IMAGE_PER_PIC` 换算，代码里不再另写单价。
"""
from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"


def test_every_image_costs_25_fen():
    from app import pricing, usage

    assert pricing.IMAGE_PER_PIC == 25
    assert (pricing.image_cost(1), pricing.image_cost(4)) == (25, 100)
    assert usage.estimate_cost("image", units=3) == 75
    assert usage.estimate_cost("image") == 25


def test_quotes_state_the_per_image_price():
    from app import charge

    assert charge.estimate("asset_generate", {"n": 4}) == (100, "生图 4 张 × 0.25 元")
    assert charge.estimate("asset_generate", {"n": 0}) == (25, "生图 1 张 × 0.25 元")
    assert charge.estimate("asset_batch", {"items": [{}, {}, {}]}) == (75, "生图 3 张 × 0.25 元")


def test_a_scene_in_a_subset_fill_is_quoted_at_every_view():
    from app import charge, scene_view

    only = [{"kind": "location", "name": "渡口"}, {"kind": "prop", "name": "油灯"}]
    assert charge.estimate("asset_fill", {"only": only}) == (
        (scene_view.VIEW_COUNT + 1) * 25, f"生图 {scene_view.VIEW_COUNT + 1} 张 × 0.25 元")


def test_no_old_image_price_is_left_in_the_app():
    hits = [f"{path.relative_to(APP)}:{no}" for path in sorted(APP.rglob("*.py"))
            for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
            if re.search(r"0\.15\s*元", line)]
    assert hits == []
