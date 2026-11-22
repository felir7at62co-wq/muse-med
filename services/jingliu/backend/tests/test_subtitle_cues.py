"""逐字时间的字幕纠正与切条（`app/subtitle_cues.py`）：与 Muse 共用同一份向量。

`tests/fixtures/subtitle_rules_vectors.json` 的每一条在这里跑镜流的模块，在 Muse 里跑逐字节相同的副本
（`run.py`），两边的字、字幕和要人看的编号必须一样。
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
VECTORS = json.loads((BACKEND / "tests/fixtures/subtitle_rules_vectors.json").read_text("utf-8"))


def _shot(case: dict, decisions=None) -> dict:
    from app.subtitle_cues import shot_cues
    return shot_cues(case["words"], case["lines"], case["names"],
                     case["decisions"] if decisions is None else decisions,
                     max_chars=case["max_chars"], space_width=VECTORS["space_width"],
                     audio_sha=case["audio_sha"], flags=case["flags"])


def _expect_of(out: dict) -> dict:
    st = out["stats"]
    return {
        "texts": [w["text"] for w in out["words"]],
        "cues": [{k: c[k] for k in ("start", "end", "text", "long")} for c in out["cues"]],
        "items": [{k: it[k] for k in ("id", "kind", "heard", "script", "start", "end", "decision")}
                  for it in out["items"]],
        "pending": out["pending"],
        "stats": {k: st[k] for k in ("similarity", "fixed", "kept", "extra", "unspoken", "deviated",
                                     "unheard", "no_script", "fixes", "differs", "doubts")},
    }


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_shared_vectors(case):
    assert _expect_of(_shot(case)) == case["expect"]


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_correction_without_decisions_matches_correct_words(case):
    from app.subtitle_cues import apply_decisions, correct_words, review_items
    fixed, stats = correct_words(case["words"], case["lines"], case["names"])
    items = review_items(stats, case["words"], case["lines"], audio_sha=case["audio_sha"])
    assert [w["text"] for w in apply_decisions(case["words"], stats, items, [])] == [w["text"] for w in fixed]
    assert [(w["start"], w["end"]) for w in fixed] == [(w["start"], w["end"]) for w in case["words"]]


def test_word_level_stats_equal_a_segment_level_call():
    from app.subtitle_align import correct_segments
    from app.subtitle_cues import correct_words
    for case in VECTORS["cases"]:
        segs: dict[int, dict] = {}
        for w in case["words"]:
            seg = segs.setdefault(w["seg"], {"start": w["start"], "end": w["end"], "text": ""})
            seg["text"] += w["text"]
            seg["end"] = w["end"]
        _out, by_segment = correct_segments(list(segs.values()), case["lines"], case["names"])
        assert correct_words(case["words"], case["lines"], case["names"])[1] == by_segment, case["name"]


def test_review_ids_depend_only_on_this_shot():
    case = next(c for c in VECTORS["cases"] if c["name"] == "a_same_sounding_negation_is_a_doubt")
    (item,) = _shot(case)["items"]
    assert _shot({**case, "names": ["别的角色"]})["items"][0]["id"] == item["id"]
    assert _shot({**case, "audio_sha": "another-take"})["items"][0]["id"] != item["id"]
    assert _shot({**case, "lines": ["这步行啊。"]})["items"][0]["id"] != item["id"]   # 台词改了：旧的选择作废
    moved = [dict(w, start=w["start"] + 1, end=w["end"] + 1) for w in case["words"]]
    assert _shot({**case, "words": moved})["items"][0]["id"] != item["id"]


def test_a_decision_for_another_item_or_an_unknown_action_changes_nothing():
    case = next(c for c in VECTORS["cases"] if c["name"] == "a_different_reading_is_a_differ")
    (item,) = _shot(case)["items"]
    for decisions in ([{"id": "000000000000", "action": "script"}], [{"id": item["id"], "action": "rewrite"}]):
        out = _shot(case, decisions)
        assert [w["text"] for w in out["words"]] == ["我", "不", "想", "去"] and out["pending"] == 1


def test_cue_times_are_word_times_and_never_shared_by_character_count():
    from app.subtitle_cues import layout_cues
    words = [{"start": 0.0, "end": 0.3, "text": "你好，"}, {"start": 2.0, "end": 2.2, "text": "走"},
             {"start": 2.2, "end": 2.9, "text": "吧"}]
    assert [(c["start"], c["end"], c["text"]) for c in layout_cues(words, 2)] == [
        (0.0, 0.3, "你好"), (2.0, 2.9, "走吧")]


def test_the_module_has_no_io_and_imports_nothing_from_jingliu_but_subtitle_align():
    allowed = {"__future__", "hashlib", "json"}
    tree = ast.parse((BACKEND / "app/subtitle_cues.py").read_text("utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert {a.name.split(".")[0] for a in node.names} <= allowed
        elif isinstance(node, ast.ImportFrom):
            assert node.module in allowed or node.module == "subtitle_align", node.module
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in ("open", "print", "input", "exec", "eval", "__import__")
    align = ast.parse((BACKEND / "app/subtitle_align.py").read_text("utf-8"))
    imported = {(n.module or "").split(".")[0] for n in ast.walk(align) if isinstance(n, ast.ImportFrom)}
    imported |= {a.name.split(".")[0] for n in ast.walk(align) if isinstance(n, ast.Import) for a in n.names}
    assert imported <= {"__future__", "unicodedata", "collections", "difflib", "pypinyin"}


def test_a_byte_copy_runs_as_top_level_modules(tmp_path):
    for name in ("subtitle_align.py", "subtitle_cues.py"):
        (tmp_path / name).write_bytes((BACKEND / "app" / name).read_bytes())
    case = VECTORS["cases"][0]
    code = ("import json, sys; sys.path.insert(0, sys.argv[1]); import subtitle_cues; "
            "c = json.loads(sys.stdin.read()); "
            "print(json.dumps(subtitle_cues.shot_cues(c['words'], c['lines'], c['names'], c['decisions'], "
            "max_chars=c['max_chars'], audio_sha=c['audio_sha'])['cues'], ensure_ascii=False))")
    out = subprocess.run([sys.executable, "-I", "-c", code, str(tmp_path)], input=json.dumps(case),
                         capture_output=True, text=True, check=True, timeout=60)
    assert json.loads(out.stdout) == _shot(case)["cues"]


def test_spans_point_at_each_listed_piece_in_the_heard_characters():
    from app.subtitle_align import correct_segments
    _out, st = correct_segments([{"start": 0.0, "end": 1.0, "text": "林辰你终于回来了，"},
                                 {"start": 1.0, "end": 2.0, "text": "你买不买"}],
                                ["林晨你终于回来了，你卖不卖"], ["林晨"])
    assert st["fixes"] == [{"heard": "辰", "script": "晨"}]
    assert st["spans"] == {"fixes": [[1, 2]], "differs": [[9, 10], [11, 12]], "doubts": []}
