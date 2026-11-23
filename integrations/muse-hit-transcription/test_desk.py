"""转写工作台: claim and prepare for a Bot, advisory checks, publish, release, restart, and the MCP tools end to end."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest

import desk_mcp
from common import WorkError, digest, save
from desk import Desk, Handler, Server
from test_agent_runner import KEY, SECOND, WORKER, ManyStation, write_episode


class FakeBots:
    """Cloud Muse: two transcription Bots, their chats' running state and last turn ends; folder changes and
    messages are recorded."""

    def __init__(self):
        self.updates, self.sent, self.running, self.turns = [], [], set(), {}
        self.chats = {"bot-1": "chat-1", "bot-2": "chat-2"}
        self.month = {"input": 1000, "cacheRead": 0, "cacheWrite": 0, "output": 100, "calls": 1}
        self.logs = {}

    def bot(self, endpoint, payload):
        if endpoint == "state":
            return {"bots": [{"id": "bot-1", "name": "转写1", "sessionId": self.chats["bot-1"], "model": "m/flash"},
                             {"id": "bot-2", "name": "转写2", "sessionId": self.chats["bot-2"], "model": "m/flash"}]}
        if endpoint == "usage-summary":
            return {"botId": payload["botId"], "month": dict(self.month)}
        if endpoint == "update-bot":
            self.updates.append(payload)
            return {"id": payload["id"]}
        if endpoint == "send":
            self.sent.append(payload)
            return True
        raise AssertionError(endpoint)

    def sessions(self):
        return [{"sessionId": sid, "running": True} for sid in self.running]

    def last_turn(self, session):
        return self.turns.get(session, ("completed", None))

    def log_lines(self, session):
        return self.logs.get(session, [])


class DeskCase(unittest.TestCase):
    """A desk on two cached dramas with two Bots; no tests of its own."""

    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for key, count in ((KEY, 3), (SECOND, 2)):
            cache = self.root / "cache" / key
            cache.mkdir(parents=True)
            media = []
            for number in range(1, count + 1):
                video = cache / f"{number:04d}.mp4"
                video.write_bytes(key.encode() + bytes([number]))
                media.append({"index": number, "path": str(video), "bytes": video.stat().st_size, "sha256": digest(video), "durationSeconds": 60})
            save(cache / "source.json", {"seriesId": key, "media": media})
        self.cfg = {"stateRoot": str(self.root / "state"), "workspaceRoot": str(self.root / "workspace"),
                    "mediaCaches": [str(self.root / "cache")], "workerId": WORKER, "heartbeatSeconds": 1, "preset": "short-drama-v2",
                    "batchSize": 10, "followUps": 2, "batchTimeoutMinutes": 5, "pollSeconds": 0.01, "minSpeechCoverage": 0.5}
        self.station = ManyStation({KEY: "盛夏芬德拉", SECOND: "第二部剧"})
        self.station.claim = self.claim_with_counts(self.station.claim)
        self.bots = FakeBots()
        self.desk = Desk(self.cfg, self.station, self.bots)
        self.addCleanup(self.desk.close)
        # Preparation runs in its own thread; let it finish before the folders go.
        self.addCleanup(lambda: [thread.join(5) for thread in list(self.desk.threads.values())])

    def claim_with_counts(self, claim):
        def wrapped(worker, key):
            reply = claim(worker, key)
            reply["work"]["episodes"] = 3 if key == KEY else 2
            return reply
        return wrapped

    def ready(self, key):
        deadline = time.time() + 5
        while time.time() < deadline:
            row = self.desk.status({"work_id": "hongguo:" + key})
            if row["state"] != "preparing":
                return row
            time.sleep(0.02)
        self.fail("the drama never became ready")


class DeskTest(DeskCase):
    def test_a_claimed_drama_is_prepared_for_its_bot_checked_and_published(self):
        first = self.desk.claim({"work_id": "hongguo:" + KEY, "bot": "转写1"})
        self.assertEqual((first["state"], first["bot"]), ("preparing", "转写1"))
        row = self.ready(KEY)
        workspace = Path(row["workspace"])
        self.assertEqual(sorted(p.name for p in (workspace / "原片").iterdir()), ["0001.mp4", "0002.mp4", "0003.mp4"])
        self.assertEqual(self.bots.updates, [{"id": "bot-1", "workDir": str(workspace)}])
        self.assertEqual((row["done"], row["total"], row["publishable"]), (0, 3, False))
        self.assertIn("缺 episodes/第1集.md", row["open"][0]["missing"])
        write_episode(workspace, 1)
        write_episode(workspace, 2)
        with self.assertRaises(WorkError) as refused:
            self.desk.publish({"work_id": KEY})
        self.assertEqual(refused.exception.code, "INCOMPLETE")
        self.assertIn("第3集缺 episodes/第3集.md", str(refused.exception))
        write_episode(workspace, 3)
        row = self.desk.status({"work_id": KEY})
        self.assertEqual((row["done"], row["publishable"]), (3, True))
        self.assertIn(("progress", "转写1 转写中，已完成 3/3 集"), self.station.calls)
        self.assertEqual(self.desk.publish({"work_id": KEY})["state"], "published")
        self.assertEqual(self.station.done, {KEY: 3})
        self.assertFalse((workspace / "原片").exists())
        with self.assertRaises(WorkError) as again:
            self.desk.claim({"work_id": KEY, "bot": "转写1"})
        self.assertEqual(again.exception.code, "ALREADY_PUBLISHED")

    def test_claims_name_a_real_bot_that_holds_no_other_drama(self):
        with self.assertRaises(WorkError) as unknown:
            self.desk.claim({"work_id": KEY, "bot": "转写9"})
        self.assertEqual(unknown.exception.code, "UNKNOWN_BOT")
        self.desk.claim({"work_id": KEY, "bot": "转写1"})
        self.ready(KEY)
        self.assertEqual(self.desk.claim({"work_id": KEY, "bot": "转写1"})["state"], "ready")
        with self.assertRaises(WorkError) as taken:
            self.desk.claim({"work_id": KEY, "bot": "转写2"})
        self.assertEqual(taken.exception.code, "ALREADY_ASSIGNED")
        with self.assertRaises(WorkError) as busy:
            self.desk.claim({"work_id": SECOND, "bot": "转写1"})
        self.assertEqual(busy.exception.code, "BOT_BUSY")
        self.assertEqual(self.desk.claim({"work_id": SECOND, "bot": "转写2"})["bot"], "转写2")

    def test_a_released_drama_goes_back_for_attention_and_keeps_its_work(self):
        self.desk.claim({"work_id": KEY, "bot": "转写1"})
        workspace = Path(self.ready(KEY)["workspace"])
        write_episode(workspace, 1)
        self.assertEqual(self.desk.release({"work_id": KEY, "reason": "第 2 集原片损坏"})["state"], "released")
        self.assertEqual(self.station.calls[-1], ("attention", "BOT_RELEASED", "第 2 集原片损坏"))
        self.assertTrue((workspace / "episodes" / "第1集.md").is_file())
        self.assertEqual(json.loads((self.root / "state" / KEY / "station-outcome.json").read_text())["state"], "needs-attention")
        self.assertEqual(self.desk.claim({"work_id": SECOND, "bot": "转写1"})["state"], "preparing")

    def test_a_restarted_desk_claims_its_dramas_again_and_keeps_their_leases(self):
        self.desk.claim({"work_id": KEY, "bot": "转写1"})
        self.ready(KEY)
        self.desk.close()
        claims = []
        original = self.station.claim
        self.station.claim = lambda worker, key: (claims.append(key), original(worker, key))[1]
        again = Desk(self.cfg, self.station, self.bots)
        self.addCleanup(again.close)
        again.resume()
        self.assertEqual(claims, [KEY])
        self.assertEqual(again.status({"work_id": KEY})["lease"], "held")


class WatchTest(DeskCase):
    def test_an_interrupted_bot_is_nudged_after_two_idle_passes_and_episode_times_are_kept(self):
        self.cfg["watchSeconds"] = 0
        self.desk.claim({"work_id": KEY, "bot": "转写1"})
        workspace = Path(self.ready(KEY)["workspace"])
        write_episode(workspace, 1)
        self.bots.turns["chat-1"] = ("aborted", "disposed")
        self.desk.watch_once()
        self.assertEqual(self.bots.sent, [])
        self.desk.watch_once()
        self.assertEqual(len(self.bots.sent), 1)
        self.assertEqual(self.bots.sent[0]["sessionId"], "bot-1")
        self.assertTrue(self.bots.sent[0]["text"].startswith("刚才你这一轮被中断了"))
        self.bots.running.add("chat-1")
        self.desk.watch_once()
        self.desk.watch_once()
        self.assertEqual(len(self.bots.sent), 1)
        self.bots.running.clear()
        self.bots.turns["chat-1"] = ("completed", None)
        self.desk.watch_once()
        self.desk.watch_once()
        self.assertEqual(len(self.bots.sent), 1)
        row = self.desk.status({"work_id": KEY})
        self.assertEqual((row["done"], row["nudges"]), (1, 1))
        self.assertIsNotNone(row["firstDone"])


class MeasureTest(DeskCase):
    def test_spend_per_episode_and_quality_by_part_and_compaction_are_reported(self):
        self.cfg["prices"] = {"m/flash": {"input": 2, "cacheRead": 0.5, "output": 8}}
        self.desk.claim({"work_id": KEY, "bot": "转写1"})
        workspace = Path(self.ready(KEY)["workspace"])
        write_episode(workspace, 1)
        self.desk.watch_once()
        self.bots.logs["chat-1"] = [json.dumps({"type": "compaction/end", "time": 1})]
        write_episode(workspace, 2)
        self.desk.watch_once()
        self.bots.chats["bot-1"] = "chat-1b"
        write_episode(workspace, 3, qa=False)
        self.desk.watch_once()
        self.bots.month = {"input": 301000, "cacheRead": 0, "cacheWrite": 0, "output": 30100, "calls": 31}
        row = self.desk.status({"work_id": KEY})
        self.assertEqual(row["usage"]["tokens"], {"input": 300000, "cacheRead": 0, "cacheWrite": 0, "output": 30000, "calls": 30})
        self.assertEqual(row["usage"]["perEpisode"]["output"], 10000)
        self.assertEqual((row["usage"]["yuan"], row["usage"]["yuanPerEpisode"]), (0.84, 0.28))
        self.assertEqual(row["usage"]["speechMinutes"], 3.0)
        self.assertEqual([(q["part"], q["compactionsBefore"], q["episodes"], q["qaShare"]) for q in row["quality"]],
                         [(1, 0, [1], 1.0), (1, 1, [2], 1.0), (2, 0, [3], 0.0)])


class ToolsTest(unittest.TestCase):
    def test_the_bot_tools_reach_the_desk_through_its_socket(self):
        with TemporaryDirectory(dir="/tmp") as folder:
            path = str(Path(folder) / "d.sock")

            class Fake:
                def execute(self, request):
                    if request["operation"] == "status":
                        raise WorkError("NOT_ON_DESK", "工作台没有这部剧；先用 drama_claim 领取")
                    return {"echo": request}
            with Server(path, Handler) as server:
                server.desk = Fake()
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
                thread.start()
                try:
                    listed = desk_mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, path)
                    self.assertEqual([tool["name"] for tool in listed["result"]["tools"]],
                                     ["reserve_list", "drama_claim", "drama_status", "drama_publish", "drama_release"])
                    claim = desk_mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                             "params": {"name": "drama_claim", "arguments": {"work_id": "hongguo:" + KEY, "bot": "转写1"}}}, path)
                    self.assertEqual(json.loads(claim["result"]["content"][0]["text"]),
                                     {"echo": {"operation": "claim", "args": {"work_id": "hongguo:" + KEY, "bot": "转写1"}}})
                    status = desk_mcp.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                              "params": {"name": "drama_status", "arguments": {"work_id": KEY}}}, path)
                    self.assertTrue(status["result"]["isError"])
                    self.assertEqual(json.loads(status["result"]["content"][0]["text"])["code"], "NOT_ON_DESK")
                    missing = desk_mcp.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                               "params": {"name": "drama_release", "arguments": {"work_id": KEY}}}, path)
                    self.assertEqual(json.loads(missing["result"]["content"][0]["text"])["code"], "INVALID_ARGUMENTS")
                finally:
                    server.shutdown()
        gone = desk_mcp.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "reserve_list", "arguments": {}}},
                               "/tmp/no-such-desk.sock")
        self.assertEqual(json.loads(gone["result"]["content"][0]["text"])["code"], "DESK_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
