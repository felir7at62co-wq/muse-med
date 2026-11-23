"""Agent production: the mechanical episode check and one series end to end against a fake station and cloud Muse."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import threading
import time
import unittest

import agent_runner
from agent_runner import (RESUME, Control, Production, batch_prompt, check_episode, follow_up_prompt, run, tool_results,
                          turn_outcome, unix_timestamp)
from common import WorkError, digest, save

KEY = "7550544718799588376"
WORKER = "muse-agent-test"


def write_episode(workspace, number, *, frames=(3, 3), word=True, qa=True, asr=True, script=True):
    """Leave the files an agent writes for one finished episode."""
    if script:
        (workspace / "episodes").mkdir(parents=True, exist_ok=True)
        (workspace / "episodes" / f"第{number}集.md").write_text(
            f"第{number}集\n{number}-1 茶室 日 内\n人物：周晟安、白清枚\n▲周晟安坐在长桌一端。\n周晟安：白小姐，你好，今天的会面是基于对你的尊重。\n"
            "白清枚：你就是我爸给我介绍的联姻对象？\n", encoding="utf-8")
    if asr:
        (workspace / "transcript" / "raw").mkdir(parents=True, exist_ok=True)
        save(workspace / "transcript" / "raw" / f"{number:04d}-v1.json",
             [{"text": "白小姐，你好，今天的会面是基于对你的尊重。"}, {"text": "你就是我爸给我介绍的联姻对象？"}])
    recorded, total = frames
    observations = workspace / ".muse" / "video-observations"
    observations.mkdir(parents=True, exist_ok=True)
    save(observations / f"review-{number}.json", {
        "path": str(workspace / "原片" / f"{number:04d}.mp4"), "episode": number, "scan_complete": True,
        "frames": [{"id": f"F{i}", **({"observation": {"visible": "画面"}} if i < recorded else {})} for i in range(total)]})
    if word:
        (workspace / "final").mkdir(parents=True, exist_ok=True)
        (workspace / "final" / f"第{number}集.docx").write_bytes(b"PK\x03\x04word")
    if qa:
        (workspace / "qa").mkdir(parents=True, exist_ok=True)
        (workspace / "qa" / f"第{number}集-待核.md").write_text("无待核项\n", encoding="utf-8")


class CheckTest(unittest.TestCase):
    def test_a_finished_episode_passes_and_each_missing_part_is_named(self):
        with TemporaryDirectory() as folder:
            workspace = Path(folder)
            write_episode(workspace, 1)
            required, advised, measures = check_episode(workspace, 1, 0.6)
            self.assertEqual((required, advised), ([], []))
            self.assertEqual(measures["frames"], "3/3")
            self.assertGreater(measures["speechCoverage"], 0.9)
            write_episode(workspace, 2, frames=(1, 4), word=False, qa=False, asr=False)
            required, advised, _ = check_episode(workspace, 2, 0.6)
            self.assertEqual(required, ["逐帧审看没做完（已记录 1/4 帧）", "没有本集的语音识别结果", "缺 final/第2集.docx"])
            self.assertEqual(advised, ["缺 qa/第2集-待核.md"])
            required, _, _ = check_episode(workspace, 3, 0.6)
            self.assertEqual(required[0], "缺 episodes/第3集.md")
            self.assertIn("没有逐帧审看记录", required)

    def test_low_speech_coverage_is_advice_not_a_block(self):
        with TemporaryDirectory() as folder:
            workspace = Path(folder)
            write_episode(workspace, 1)
            save(workspace / "transcript" / "raw" / "0001-v2.json", [{"text": "完全不同的一大段台词内容" * 5}])
            required, advised, _ = check_episode(workspace, 1, 0.6)
            self.assertEqual(required, [])
            self.assertTrue(advised[0].startswith("台词与语音识别差距较大"))

    def test_follow_up_lists_every_episode_and_its_parts(self):
        text = follow_up_prompt({3: ["缺 final/第3集.docx"], 1: ["逐帧审看没做完（已记录 1/4 帧）", "缺 qa/第1集-待核.md"]})
        self.assertIn("- 第1集：逐帧审看没做完（已记录 1/4 帧）；缺 qa/第1集-待核.md\n- 第3集：缺 final/第3集.docx", text)


class PromptAndLogTest(unittest.TestCase):
    def test_the_batch_request_limits_sub_agents_and_reuses_speech_receipts(self):
        text = batch_prompt("盛夏芬德拉", 82, 21, 30)
        self.assertIn("子代理同时最多开 3 个", text)
        self.assertIn("用 inspect 查这个回执取结果，不要重新提交", text)
        self.assertIn("子代理同时最多开 3 个", RESUME)

    def test_systemd_unix_timestamps_parse_and_local_text_does_not(self):
        self.assertEqual(unix_timestamp("@1795417523\n"), 1795417523.0)
        self.assertEqual(unix_timestamp("Mon 2026-11-23 15:05:23 CST"), 0.0)
        self.assertEqual(unix_timestamp(""), 0.0)

    def test_the_last_turn_end_is_read_from_the_session_log(self):
        start = json.dumps({"type": "turn/start", "data": {"turn": 1}})
        end = lambda reason: json.dumps({"type": "turn/end", "data": {"turn": 1, "reason": reason}})
        self.assertEqual(turn_outcome([start, end({"kind": "completed"})]), ("completed", None))
        self.assertEqual(turn_outcome([start, end({"kind": "aborted", "reason": {"kind": "disposed"}})]), ("aborted", "disposed"))
        self.assertEqual(turn_outcome([start, end({"kind": "error", "error": {"code": "NO_ADAPTER", "message": "no adapter"}})]),
                         ("error", "NO_ADAPTER no adapter"))
        self.assertEqual(turn_outcome([start, end({"kind": "completed"}), start, '{"type": "tool/call"']), ("unfinished", None))
        self.assertEqual(turn_outcome(['{"type": "session"}']), (None, None))


class ToolResultTest(unittest.TestCase):
    def test_only_results_of_the_named_tool_are_read(self):
        call = lambda cid, name: json.dumps({"type": "tool/call", "data": {"callId": cid, "name": name}})
        result = lambda cid, text: json.dumps({"type": "tool/result", "data": {"message": {"toolCallId": cid, "content": [{"type": "text", "text": text}]}}})
        lines = [call("a", "skill"), result("a", '{"id": 9}'), call("b", "script_finalize"),
                 result("b", '{"id": 1, "version": 2, "episodes": 30}'), call("c", "script_finalize"), result("c", "工具失败")]
        self.assertEqual(tool_results(lines, "script_finalize"), [{"id": 1, "version": 2, "episodes": 30}])


class ControlTest(unittest.TestCase):
    def test_the_control_file_is_read_and_an_unreadable_one_keeps_the_last_request(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "control.json"
            control = Control(path, 3)
            self.assertEqual(control.read(), {"paused": False, "dramasAtOnce": 1, "onlySeries": [], "skipSeries": []})
            path.write_text(json.dumps({"paused": True, "dramasAtOnce": 5, "skipSeries": ["hongguo:" + KEY]}), encoding="utf-8")
            self.assertEqual(control.read(), {"paused": True, "dramasAtOnce": 3, "onlySeries": [], "skipSeries": [KEY]})
            path.write_text('{"paused": fal', encoding="utf-8")
            self.assertTrue(control.read()["paused"])
            path.write_text(json.dumps({"paused": False, "onlySeries": ["not a series"]}), encoding="utf-8")
            self.assertTrue(control.read()["paused"])
            path.write_text(json.dumps({"paused": False, "dramasAtOnce": "two"}), encoding="utf-8")
            self.assertTrue(control.read()["paused"])
            path.write_text(json.dumps({"paused": "yes"}), encoding="utf-8")
            self.assertEqual((control.read()["paused"], control.read()["dramasAtOnce"]), (False, 1))


class FakeStation:
    def __init__(self):
        self.calls, self.published = [], None
        self.state, self.attempts = "queued", 0

    def candidates(self):
        return {"queued": [{"workId": "hongguo:" + KEY, "state": self.state, "attempts": self.attempts}] if self.state == "queued" else []}

    def claim(self, worker, key):
        self.calls.append(("claim", key))
        self.state = "downloading"
        return {"job": {"workId": "hongguo:" + key, "state": "downloading", "workerId": worker}, "lease": "lease-" + "x" * 20,
                "work": {"title": "盛夏芬德拉", "episodes": 3}, "review": {"required": False}}

    def progress(self, key, lease, **changes):
        self.calls.append(("progress", changes.get("message")))
        return {"workId": "hongguo:" + key, "workerId": WORKER, "state": changes.get("state", "transcribing"),
                "leaseExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}

    def attention(self, key, lease, code, message):
        self.calls.append(("attention", code, message))
        return {"state": "needs-attention"}

    def publish(self, key, lease, manuscript, verification):
        self.published = (manuscript.read_text(encoding="utf-8"), verification)
        return {"job": {"state": "published"}}


class FakeMuse:
    """Cloud Muse stand-in: each prompt makes the 'agent' write files; sessions are idle once it has."""

    def __init__(self, act):
        self.act, self.prompts, self.created, self.cwds = act, [], [], {}
        self.restarted, self.outages, self.turns, self.current, self.results = 0.0, 0, {}, None, {}
        self.lock = threading.Lock()

    def create(self, cwd, preset):
        with self.lock:
            self.created.append((cwd, preset))
            session = f"session-{len(self.created)}"
            self.cwds[session] = cwd
        return session

    def prompt(self, session, text):
        with self.lock:
            self.prompts.append((session, text))
            turn = len(self.prompts)
            self.current = session
        self.turns[session] = ("completed", None)
        self.act(Path(self.cwds[session]), text, turn)

    def last_turn(self, session):
        return self.turns.get(session, (None, None))

    def tool_results(self, session, name):
        return self.results.get(session, []) if name == "script_finalize" else []

    def started_at(self):
        return self.restarted

    def sessions(self):
        if self.outages:
            self.outages -= 1
            raise WorkError("MUSE_UNAVAILABLE", "云端 Muse 无法连接（ConnectionRefusedError）")
        with self.lock:
            return [{"sessionId": sid, "cwd": cwd, "running": False} for sid, cwd in self.cwds.items()]

    def cancel(self, session):
        raise AssertionError("no batch should time out")


class ProductionTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        cache = root / "cache" / KEY
        cache.mkdir(parents=True)
        media = []
        for number in (1, 2, 3):
            video = cache / f"{number:04d}.mp4"
            video.write_bytes(bytes([number]) * 10)
            media.append({"index": number, "path": str(video), "bytes": 10, "sha256": digest(video), "durationSeconds": 60})
        save(cache / "source.json", {"seriesId": KEY, "title": "盛夏芬德拉", "episodes": 3, "media": media})
        self.cfg = {"stateRoot": str(root / "state"), "workspaceRoot": str(root / "workspace"), "mediaCaches": [str(root / "cache")],
                    "workerId": WORKER, "heartbeatSeconds": 1, "preset": "short-drama-v2", "batchSize": 2, "followUps": 1,
                    "batchTimeoutMinutes": 5, "pollSeconds": 0.01, "minSpeechCoverage": 0.5, "onlySeries": [KEY]}
        self.station = FakeStation()

    def test_a_series_runs_batch_by_batch_gets_one_follow_up_and_is_published(self):
        def agent(workspace, text, turn):
            if text.startswith("把《盛夏芬德拉》第 1–2 集"):
                write_episode(workspace, 1)
                write_episode(workspace, 2, word=False)
            elif text.startswith("这一批还有几集"):
                self.assertIn("- 第2集：缺 final/第2集.docx", text)
                write_episode(workspace, 2)
            elif text.startswith("把《盛夏芬德拉》第 3–3 集"):
                self.assertIn("前面的集已经转好", text)
                write_episode(workspace, 3)
        muse = FakeMuse(agent)
        production = Production(self.cfg, self.station, muse)
        self.assertTrue(production.once())
        starts = ["把《盛夏芬德拉》第 1–2 集", "这一批还有几集没达到交付要求", "把《盛夏芬德拉》第 3–3 集"]
        self.assertEqual(len(muse.prompts), 3)
        for (_, text), start in zip(muse.prompts, starts):
            self.assertTrue(text.startswith(start), text[:30])
        self.assertEqual(len(muse.created), 2)
        manuscript, verification = self.station.published
        self.assertEqual([line for line in manuscript.splitlines() if line.startswith("第")], ["第1集", "第2集", "第3集"])
        self.assertEqual(verification["episodes"], 3)
        workspace = Path(self.cfg["workspaceRoot"]) / f"盛夏芬德拉-{KEY}"
        self.assertFalse((workspace / "原片").exists())
        self.assertTrue((workspace / "final" / "第3集.docx").is_file())
        self.assertFalse(Path(self.cfg["stateRoot"], "active.json").exists())
        self.assertEqual(json.loads(Path(self.cfg["stateRoot"], KEY, "station-outcome.json").read_text())["state"], "published")

    def test_an_agent_that_never_finishes_leaves_the_series_needing_attention(self):
        muse = FakeMuse(lambda workspace, text, turn: write_episode(workspace, 1, frames=(1, 3)))
        production = Production(self.cfg, self.station, muse)
        self.assertTrue(production.once())
        attention = [call for call in self.station.calls if call[0] == "attention"]
        self.assertEqual(attention[0][1], "AGENT_INCOMPLETE")
        self.assertIn("第1集逐帧审看没做完（已记录 1/3 帧）", attention[0][2])
        self.assertIsNone(self.station.published)
        self.assertEqual(len(muse.prompts), 2)

    def test_a_series_queued_again_after_it_stopped_redoes_only_the_unfinished_batches(self):
        def stuck(workspace, text, turn):
            write_episode(workspace, 1)
            write_episode(workspace, 2)
            if "第 3–3 集" in text or text.startswith("这一批还有几集"):
                write_episode(workspace, 3, word=False)
        first = FakeMuse(stuck)
        self.assertTrue(Production(self.cfg, self.station, first).once())
        self.assertEqual(self.station.calls[-1][1], "AGENT_INCOMPLETE")
        # Queued again after another worker's lease on it expired: one attempt is already spent.
        self.station.state, self.station.attempts = "queued", 1
        second = FakeMuse(lambda workspace, text, turn: write_episode(workspace, 3))
        production = Production(self.cfg, self.station, second)
        self.assertTrue(production.once())
        self.assertEqual(len(second.prompts), 1)
        self.assertTrue(second.prompts[0][1].startswith("把《盛夏芬德拉》第 3–3 集"))
        self.assertIsNotNone(self.station.published)
        recent = self.board("status.json")["recent"][0]
        self.assertEqual((recent["outcome"], recent["retries"], recent["reason"]), ("published", 1, None))

    def board(self, name):
        return json.loads((Path(self.cfg["workspaceRoot"]) / ".production" / name).read_text(encoding="utf-8"))

    def test_a_paused_runner_claims_nothing_and_says_so(self):
        production = Production(self.cfg, self.station, FakeMuse(lambda *_: None))
        self.assertEqual(self.board("control.json"), {"paused": False, "dramasAtOnce": 1, "onlySeries": [], "skipSeries": []})
        save(Path(self.cfg["workspaceRoot"]) / ".production" / "control.json", {"paused": True})
        self.assertFalse(production.once())
        self.assertEqual(self.station.calls, [])
        self.assertEqual(self.board("status.json")["slots"][0]["stage"], "paused")
        save(Path(self.cfg["workspaceRoot"]) / ".production" / "control.json", {"skipSeries": [KEY]})
        self.assertFalse(production.once())
        self.assertEqual(self.station.calls, [])

    def test_a_pause_holds_the_series_at_the_next_batch_boundary(self):
        control = Path(self.cfg["workspaceRoot"]) / ".production" / "control.json"
        seen = []

        def agent(workspace, text, turn):
            for number in (1, 2) if turn == 1 else (3,):
                write_episode(workspace, number)
            if turn == 1:
                save(control, {"paused": True})
        muse = FakeMuse(agent)
        production = Production(self.cfg, self.station, muse)
        original = production.wait

        def wait(seconds):
            slot = self.board("status.json")["slots"][0]
            if slot["stage"] == "paused":
                seen.append((slot["current"]["batches"], len(muse.prompts)))
                save(control, {"paused": False})
            original(seconds)
        production.wait = wait
        self.assertTrue(production.once())
        batches, prompts = seen[0]
        self.assertEqual(prompts, 1)
        self.assertEqual([(row["episodes"], row["done"]) for row in batches], [("1-2", True), ("3-3", False)])
        self.assertIsNotNone(self.station.published)
        status = self.board("status.json")
        self.assertEqual([(row["slot"], row["stage"], row["current"]) for row in status["slots"]], [(1, "idle", None)])
        self.assertEqual(status["recent"][0]["outcome"], "published")

    def test_interrupted_turns_are_resumed_uncounted_until_one_completes(self):
        def agent(workspace, text, turn):
            if turn == 1:
                muse.outages = 2
            if text.startswith("把《盛夏芬德拉》第 1–2 集") or (text == RESUME and turn < 6):
                muse.turns[muse.current] = ("aborted", "disposed") if turn % 2 else ("error", "NO_ADAPTER no adapter")
            elif text == RESUME:
                write_episode(workspace, 1)
                write_episode(workspace, 2)
            else:
                write_episode(workspace, 3)
        muse = FakeMuse(agent)
        self.assertTrue(Production(self.cfg, self.station, muse).once())
        self.assertEqual([text == RESUME for _, text in muse.prompts], [False, True, True, True, True, True, False])
        state = json.loads(Path(self.cfg["stateRoot"], KEY, "state.json").read_text(encoding="utf-8"))
        batch = state["batches"]["1-2"]
        self.assertEqual((batch["followUps"], batch["resumes"], batch["interruptions"]), (0, 5, 0))
        self.assertEqual(self.board("status.json")["recent"][0]["outcome"], "published")
        self.assertIsNotNone(self.station.published)

    def test_prompts_wait_until_cloud_muse_has_been_up_for_the_warmup(self):
        muse = FakeMuse(lambda workspace, text, turn: [write_episode(workspace, n) for n in (1, 2, 3)])
        muse.restarted = time.time()
        sent = []
        original = muse.create
        muse.create = lambda cwd, preset: (sent.append(time.time()), original(cwd, preset))[1]
        began = time.time()
        self.assertTrue(Production({**self.cfg, "museWarmupSeconds": 0.3}, self.station, muse).once())
        self.assertGreaterEqual(sent[0] - began, 0.25)

    def test_a_late_speech_result_is_waited_for_without_spending_a_follow_up(self):
        def agent(workspace, text, turn):
            if turn == 1:
                write_episode(workspace, 1)
                write_episode(workspace, 2, asr=False)
                (workspace / "transcript" / "jobs").mkdir(parents=True, exist_ok=True)
                save(workspace / "transcript" / "jobs" / "0002-v1.json", {"status": "processing", "stem": "0002", "version": 1})
            elif text.startswith("这几集的语音识别还没取回结果"):
                self.assertIn("- 第2集：语音识别还在等服务返回（回执 transcript/jobs/0002-v1.json，状态 processing）", text)
                write_episode(workspace, 2)
            else:
                write_episode(workspace, 3)
        muse = FakeMuse(agent)
        self.assertTrue(Production({**self.cfg, "asrRetrySeconds": 0.01}, self.station, muse).once())
        self.assertEqual(len(muse.prompts), 3)
        batch = json.loads(Path(self.cfg["stateRoot"], KEY, "state.json").read_text(encoding="utf-8"))["batches"]["1-2"]
        self.assertEqual((batch["followUps"], batch["asrWaits"]), (0, 1))
        self.assertIsNotNone(self.station.published)

    def test_each_finished_batch_is_stored_as_a_new_library_version(self):
        versions = []

        def agent(workspace, text, turn):
            match = re.match(r"把《盛夏芬德拉》第1–(\d+)集的剧本定稿入库", text)
            if match:
                self.assertIn("title：盛夏芬德拉【转写稿】", text)
                self.assertIn("origin：hongguo:" + KEY, text)
                last = int(match.group(1))
                self.assertIn(f"episodes/第{last}集.md", text)
                versions.append(last)
                muse.results[muse.current] = [{"id": 1, "version": len(versions), "episodes": last}]
                return
            first, last = map(int, re.search(r"第 (\d+)–(\d+) 集", text).groups())
            for number in range(first, last + 1):
                write_episode(workspace, number)
        muse = FakeMuse(agent)
        cfg = {**self.cfg, "library": {"enabled": True}}
        self.assertTrue(Production(cfg, self.station, muse).once())
        self.assertEqual(versions, [2, 3])
        state = json.loads(Path(self.cfg["stateRoot"], KEY, "state.json").read_text(encoding="utf-8"))
        self.assertEqual({k: state["library"][k] for k in ("id", "version", "episodes")}, {"id": 1, "version": 2, "episodes": 3})
        self.assertIsNotNone(self.station.published)

    def test_a_library_upload_that_reports_nothing_is_recorded_and_production_goes_on(self):
        def agent(workspace, text, turn):
            if text.startswith("把《盛夏芬德拉》第1–"):
                return
            first, last = map(int, re.search(r"第 (\d+)–(\d+) 集", text).groups())
            for number in range(first, last + 1):
                write_episode(workspace, number)
        muse = FakeMuse(agent)
        self.assertTrue(Production({**self.cfg, "library": {"enabled": True}}, self.station, muse).once())
        state = json.loads(Path(self.cfg["stateRoot"], KEY, "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["libraryFailed"]["episodes"], 3)
        self.assertNotIn("library", state)
        self.assertIsNotNone(self.station.published)

    def test_a_turn_refused_for_used_up_credits_stops_the_series_for_attention(self):
        def agent(workspace, text, turn):
            muse.turns[muse.current] = ("error", 'MODEL_ERROR 402: {"code":"quota_exhausted"}')
        muse = FakeMuse(agent)
        self.assertTrue(Production(self.cfg, self.station, muse).once())
        attention = [call for call in self.station.calls if call[0] == "attention"]
        self.assertEqual(attention[0][1:], ("QUOTA_EXHAUSTED", "额度已用完，请找组长划拨后再继续"))
        self.assertEqual(len(muse.prompts), 1)


SECOND = "7550544718799588377"


class ManyStation(FakeStation):
    """Several queued series; each claim and publish is recorded with its worker."""

    def __init__(self, titles):
        super().__init__()
        self.titles, self.states, self.workers, self.done = titles, {key: "queued" for key in titles}, {}, {}
        self.guard = threading.Lock()

    def candidates(self):
        with self.guard:
            return {"queued": [{"workId": "hongguo:" + key, "state": state, "attempts": 0}
                               for key, state in self.states.items() if state == "queued"]}

    def claim(self, worker, key):
        with self.guard:
            self.states[key], self.workers[key] = "downloading", worker
        return {"job": {"workId": "hongguo:" + key, "state": "downloading", "workerId": worker}, "lease": "lease-" + "x" * 20,
                "work": {"title": self.titles[key], "episodes": 2}, "review": {"required": False}}

    def progress(self, key, lease, **changes):
        reply = super().progress(key, lease, **changes)
        with self.guard:
            return {**reply, "workerId": self.workers[key]}

    def publish(self, key, lease, manuscript, verification):
        with self.guard:
            self.done[key] = verification["episodes"]
        return {"job": {"state": "published"}}


class SlotsTest(unittest.TestCase):
    def test_two_dramas_are_worked_on_at_once_by_two_workers(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            for key in (KEY, SECOND):
                cache = root / "cache" / key
                cache.mkdir(parents=True)
                media = []
                for number in (1, 2):
                    video = cache / f"{number:04d}.mp4"
                    video.write_bytes(key.encode() + bytes([number]))
                    media.append({"index": number, "path": str(video), "bytes": video.stat().st_size, "sha256": digest(video),
                                  "durationSeconds": 60})
                save(cache / "source.json", {"seriesId": key, "media": media})
            cfg = {"stateRoot": str(root / "state"), "workspaceRoot": str(root / "workspace"), "mediaCaches": [str(root / "cache")],
                   "workerId": WORKER, "heartbeatSeconds": 1, "preset": "short-drama-v2", "batchSize": 2, "followUps": 1,
                   "batchTimeoutMinutes": 5, "pollSeconds": 0.01, "minSpeechCoverage": 0.5, "maxDramasAtOnce": 2}
            (root / "workspace" / ".production").mkdir(parents=True)
            save(root / "workspace" / ".production" / "control.json", {"dramasAtOnce": 2})
            both = threading.Barrier(2, timeout=10)

            def agent(workspace, text, turn):
                if not text.startswith("把《"):
                    raise AssertionError(text)
                both.wait()
                first, last = map(int, re.search(r"第 (\d+)–(\d+) 集", text).groups())
                for number in range(first, last + 1):
                    write_episode(workspace, number)
            station = ManyStation({KEY: "盛夏芬德拉", SECOND: "第二部剧"})
            production = Production(cfg, station, FakeMuse(agent))

            def stop_when_done():
                deadline = time.time() + 20
                while len(station.done) < 2 and time.time() < deadline:
                    time.sleep(0.01)
                production.stop.set()
            threading.Thread(target=stop_when_done, daemon=True).start()
            run(production, 0.01, 0.01)
            self.assertEqual(station.done, {KEY: 2, SECOND: 2})
            self.assertEqual(sorted(station.workers.values()), [WORKER, WORKER + "-2"])
            status = json.loads((root / "workspace" / ".production" / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["maxDramasAtOnce"], 2)
            self.assertEqual(sorted(row["outcome"] for row in status["recent"]), ["published", "published"])
            self.assertEqual(sorted(path.name for path in (root / "state").glob("active*.json")), [])


if __name__ == "__main__":
    unittest.main()
