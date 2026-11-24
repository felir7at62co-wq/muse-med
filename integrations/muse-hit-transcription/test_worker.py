"""Exercise the worker's real HTTP client against an isolated queue fixture."""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from common import WorkError, attempts_left, digest, grant_attempts, read, save
from native import RECOVERY, acquire_media, episode_records, quota_refusal, recovery_prompt, verified_media
import station
from station import Lease, Station, StationError
from verification import ocr_coverage, recognition_covers_source
from worker import Interrupted, Worker

FIRST, SECOND = "7701676176305032217", "7705664276085623832"
TITLE = "示例剧"
TOKEN = "test-service-token-" + "a" * 32
LEASE = "test-owned-lease-" + "b" * 30


def queued(key):
    return {"workId": "hongguo:" + key, "sourceId": key, "state": "queued", "attempts": 0, "workerId": None}


class QueueFixture:
    def __init__(self):
        self.jobs = {key: queued(key) for key in (FIRST, SECOND)}
        self.writes = []
        self.drop_claim = False
        self.drop_publish = False
        self.review = {"required": False}
        self.stop_lease = False

    def request(self, method, path, body):
        key = path.split("/")[-2] if method == "POST" and "/jobs/" in path else path.split("/")[-1]
        action = path.split("/")[-1]
        if method == "GET":
            if path.startswith("/candidates?"):
                return 200, {"queued": [job for job in self.jobs.values() if job["state"] == "queued"], "counts": {}}
            return 200, self.jobs[key]
        self.writes.append((action, key))
        if action == "claim":
            key = body["workId"].removeprefix("hongguo:")
            job = self.jobs[key]
            if job["state"] == "queued":
                job.update(state="downloading", attempts=job["attempts"] + 1, workerId=body["workerId"])
            if self.drop_claim:
                self.drop_claim = False
                return None, None
            return 200, {"job": job, "lease": LEASE, "work": {"title": TITLE, "episodes": 2}, "review": self.review}
        job = self.jobs[key]
        if action == "script":
            self.upload = body
            job["state"] = "published"
            if self.drop_publish:
                self.drop_publish = False
                return None, None
            return 201, {"job": job, "script": {"id": "fixture-script"}}
        if body["lease"] != LEASE or self.stop_lease:
            return 409, {"error": "lease"}
        if action == "progress":
            if "state" in body:
                job.update(state=body["state"], progress=body)
            job["leaseExpiresAt"] = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
        elif action == "reject":
            job["state"] = "rejected"
        elif action == "fail":
            job.update(state="needs-attention", failure=body)
        return 200, job


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        token = self.root / "token"
        token.write_text(TOKEN)
        token.chmod(0o600)
        self.fixture = QueueFixture()
        fixture = self.fixture

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.serve()

            def do_POST(self):
                self.serve()

            def serve(self):
                if self.headers.get("X-Muse-Data-Service-Token") != TOKEN:
                    self.send_error(401)
                    return
                path = self.path.removeprefix("/api/service/hits")
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Content-Type") == "application/json":
                    body = json.loads(body)
                code, result = fixture.request(self.command, path, body)
                if code is None:
                    self.close_connection = True
                    return
                self.send_response(code)
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            def log_message(self, *args):
                pass  # Keep fixture traffic out of test output.

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}/api/service/hits"
        self.cfg = {"stateRoot": str(self.root), "workerId": "muse-hit-test", "stationBase": base,
                    "diskReserveGiB": 0, "heartbeatSeconds": 1, "reviewTimeoutSeconds": 30,
                    "episodeTimeoutSeconds": 60, "episodeAttempts": 2, "publishChecked": False}
        self.worker = Worker(self.cfg, self.root / "unused.json", Station(base, token, 2))
        self.episodes = []

    def fake_media(self, cfg, directory, key, work, check):
        check()
        download = directory / "download"
        download.mkdir(exist_ok=True)
        media = []
        for i in (1, 2):
            video = download / f"{i:04d}.mp4"
            video.write_bytes(bytes([i]))
            media.append({"path": str(video), "index": i, "sha256": digest(video), "bytes": 1, "durationSeconds": 1})
        data = {"seriesId": key, "title": TITLE, "episodes": 2, "media": media}
        save(directory / "source.json", data)
        return data

    def fake_episode(self, directory, number, timeout, lease):
        lease.check()
        self.episodes.append(number)
        workspace = directory / "episodes" / f"{number:04d}"
        for subdir in ("scripts", "final", "qa"):
            (workspace / subdir).mkdir(parents=True)
        word = workspace / "final" / "example.docx"
        md = workspace / "scripts" / f"{number:04d}.md"
        people = workspace / "characters.json"
        qa = workspace / "qa" / f"{number:04d}.json"
        word.write_bytes(b"Fixture for a natively checked Word")
        md.write_text(f"第 {number} 集\n")
        save(people, {})
        save(qa, {})
        video = directory / "download" / f"{number:04d}.mp4"
        save(directory / "records" / f"{number:04d}.json", {
            "status": "candidate-ready", "videoSHA256": digest(video),
            "delivery": {"word": {"path": "final/example.docx", "sha256": digest(word)},
                         "markdownSHA256": digest(md), "qaSHA256": digest(qa), "charactersSHA256": digest(people)},
        })

    def test_existing_manual_queue_is_excluded_and_complete_draft_is_retained(self):
        self.cfg["excludedSeries"] = [FIRST]
        with patch("worker.acquire_media", self.fake_media), patch.object(self.worker, "start_child", self.fake_episode):
            self.assertTrue(self.worker.once())
        self.assertEqual(self.episodes, [1, 2])
        self.assertEqual(self.fixture.jobs[FIRST]["state"], "queued")
        self.assertEqual(self.fixture.jobs[SECOND]["failure"]["stage"], "DRAFT_READY")
        self.assertEqual(read(self.root / SECOND / "delivery.json")["episodes"], 2)
        self.assertFalse(any(action == "script" for action, _ in self.fixture.writes))

    def test_lost_claim_response_reuses_the_same_job_and_lease(self):
        self.fixture.drop_claim = True
        with self.assertRaises(StationError):
            self.worker.once()
        self.assertEqual(read(self.worker.active)["workId"], FIRST)
        with patch("worker.acquire_media", self.fake_media), patch.object(self.worker, "start_child", self.fake_episode):
            self.assertTrue(self.worker.once())
        self.assertEqual(self.fixture.jobs[FIRST]["attempts"], 1)
        self.assertEqual(self.fixture.jobs[SECOND]["state"], "queued")

    def test_restart_reuses_completed_episode_and_preserves_the_active_job(self):
        def stop_on_second(directory, number, timeout, lease):
            if number == 2:
                raise Interrupted()
            self.fake_episode(directory, number, timeout, lease)

        with patch("worker.acquire_media", self.fake_media):
            with patch.object(self.worker, "start_child", stop_on_second), self.assertRaises(Interrupted):
                self.worker.once()
            after_restart = Worker(self.cfg, self.root / "unused.json", self.worker.station)
            with patch.object(after_restart, "start_child", self.fake_episode):
                self.assertTrue(after_restart.once())
        self.assertEqual(self.episodes, [1, 2])
        self.assertEqual(self.fixture.jobs[FIRST]["attempts"], 1)

    def test_a_requeued_series_this_worker_retired_resumes_with_its_evidence(self):
        self.cfg["onlySeries"] = [FIRST]

        def fail_second(directory, number, timeout, lease):
            if number == 2:
                raise WorkError("EPISODE_QA", "第 2 集未通过校验")
            self.fake_episode(directory, number, timeout, lease)

        with patch("worker.acquire_media", self.fake_media):
            with patch.object(self.worker, "start_child", fail_second):
                self.assertTrue(self.worker.once())
            self.assertEqual(self.fixture.jobs[FIRST]["state"], "needs-attention")
            self.assertFalse(self.worker.once())
            self.fixture.jobs[FIRST].update(state="queued", attempts=0)
            with patch.object(self.worker, "start_child", self.fake_episode):
                self.assertTrue(self.worker.once())
        self.assertEqual(self.episodes, [1, 2])
        self.assertEqual(self.fixture.jobs[FIRST]["failure"]["stage"], "DRAFT_READY")
        (self.root / SECOND).mkdir()
        save(self.root / SECOND / "station-outcome.json", {"workId": SECOND, "state": "published"})
        self.cfg["onlySeries"] = [SECOND]
        self.assertFalse(self.worker.once())
        self.assertEqual(self.fixture.jobs[SECOND]["state"], "queued")

    def test_a_credits_refusal_stops_the_series_after_one_round(self):
        calls = []

        def refused_second(directory, number, timeout, lease):
            if number != 2:
                return self.fake_episode(directory, number, timeout, lease)
            calls.append(number)
            save(directory / "records" / "0002.json", {"status": "needs-inspection", "attempt": 1, "attemptLimit": 3})
            raise WorkError("QUOTA_EXHAUSTED", "额度已用完，请找组长划拨后再继续")

        self.cfg["onlySeries"] = [FIRST]
        with patch("worker.acquire_media", self.fake_media), patch.object(self.worker, "start_child", refused_second):
            self.assertTrue(self.worker.once())
        self.assertEqual(calls, [2])
        self.assertEqual(self.fixture.jobs[FIRST]["state"], "needs-attention")
        self.assertEqual(self.fixture.jobs[FIRST]["failure"]["stage"], "QUOTA_EXHAUSTED")

    def test_published_receipt_is_reconciled_without_uploading_again(self):
        self.cfg["publishChecked"] = True
        self.fixture.drop_publish = True
        with patch("worker.acquire_media", self.fake_media), patch.object(self.worker, "start_child", self.fake_episode):
            with self.assertRaises(StationError):
                self.worker.once()
            self.assertFalse(self.worker.once())
        self.assertEqual(len([entry for entry in self.fixture.writes if entry[0] == "script"]), 1)
        self.assertIn("第 2 集".encode(), self.fixture.upload)
        self.assertEqual(read(self.root / FIRST / "station-outcome.json")["state"], "published")

    def test_selection_rejection_never_downloads_or_submits_media(self):
        self.fixture.review = {"required": True, "standard": "明确受众"}

        def reject(directory, action, timeout, lease):
            self.assertEqual(action, "review")
            save(directory / "review-result.json", {"decision": "reject", "reason": "受众不符合"})

        with patch.object(self.worker, "start_child", reject), patch("worker.acquire_media") as download:
            self.assertTrue(self.worker.once())
            download.assert_not_called()
        self.assertEqual(self.fixture.jobs[FIRST]["state"], "rejected")

    def test_confirmed_lease_failure_stops_before_download(self):
        self.fixture.stop_lease = True
        with patch("worker.acquire_media") as download, self.assertRaises(StationError):
            self.worker.once()
        download.assert_not_called()
        self.assertEqual(read(self.worker.active)["workId"], FIRST)


class FlakyStation:
    """Answers heartbeats after the given failures, the way a restarting or busy station does."""

    def __init__(self, failures):
        self.failures, self.calls = list(failures), 0

    def progress(self, key, lease, **changes):
        self.calls += 1
        if self.failures:
            raise StationError(self.failures.pop(0))
        expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        return {"workId": "hongguo:" + key, "workerId": "w", "state": "transcribing", "leaseExpiresAt": expires}


class LeaseTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(station, "RETRY_SECONDS", 0.01)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_heartbeats_survive_a_station_restart(self):
        fake = FlakyStation([None, None, 502])
        lease = Lease(fake, FIRST, LEASE, "w", 45)
        lease.update(episode=7)
        self.assertEqual(fake.calls, 4)
        lease.check()

    def test_a_refused_heartbeat_ends_the_lease_at_once(self):
        fake = FlakyStation([409])
        with self.assertRaises(StationError):
            Lease(fake, FIRST, LEASE, "w", 45).update()
        self.assertEqual(fake.calls, 1)

    def test_retries_stop_before_the_lease_runs_out(self):
        fake = FlakyStation([None] * 1000)
        lease = Lease(fake, FIRST, LEASE, "w", 45)
        lease.expires = datetime.now(timezone.utc) + timedelta(seconds=station.EXPIRY_MARGIN_SECONDS + 0.05)
        with self.assertRaises(StationError):
            lease.update()
        self.assertLess(fake.calls, 1000)


class MediaTests(unittest.TestCase):
    def test_recovery_names_the_failed_check_and_its_repair(self):
        self.assertEqual(recovery_prompt(None), RECOVERY)
        prompt = recovery_prompt("native OCR does not reach the original ending")
        self.assertTrue(prompt.startswith(RECOVERY))
        self.assertIn("native OCR does not reach the original ending", prompt)
        self.assertIn("补跑到片尾", prompt)
        self.assertIn("重新跑 manuscript_revision transcript_coverage", recovery_prompt("the latest dialogue comparison does not match the current Markdown"))
        self.assertIn("逐项补齐", recovery_prompt("something new"))
        frames = recovery_prompt("expected one current Word meeting all checks; found 0: frame review incomplete (296/729 recorded)")
        self.assertIn("pending=0", frames)
        self.assertNotIn("交付登记里的 Word 不唯一", frames)

    def test_only_the_gateways_credit_codes_count_as_a_quota_refusal(self):
        def ended(message, status=402):
            return {"event": {"type": "turn/end", "data": {"reason": {"kind": "error", "error": {
                "message": message, "code": "QUOTA", "status": status}}}}}

        def tool(text, error=True):
            return {"event": {"type": "tool/result", "data": {"message": {"content": [{"type": "text", "text": text}], "isError": error}}}}

        gateway = '402: {"error":{"message":"额度已用完","code":"quota_exhausted","type":"quota_exhausted","reason":"insufficient"}}'
        self.assertEqual(quota_refusal([ended(gateway)]), "exhausted")
        self.assertEqual(quota_refusal([tool('{"error":"额度已用完","error_code":"quota_exhausted","reason":"insufficient"}')]), "exhausted")
        self.assertEqual(quota_refusal([ended('503: {"error":{"code":"quota_unavailable"}}', 503)]), "unavailable")
        # A provider's own 402, a recovered speech submission and an agent's text never count.
        self.assertIsNone(quota_refusal([ended('402: {"code":"insufficient_quota","message":"Upstream insufficient_quota."}')]))
        self.assertIsNone(quota_refusal([tool('{"error_code":"quota_unavailable"}')]))
        self.assertIsNone(quota_refusal([tool("quota_exhausted", error=False),
                                         {"event": {"type": "assistant/message", "data": {"text": "quota_exhausted"}}}]))
        self.assertIn("现已划拨", recovery_prompt("额度已用完，请找组长划拨后再继续"))

    def test_episode_records_accept_either_roster_form_and_name_the_file_at_fault(self):
        with TemporaryDirectory() as folder:
            workspace = Path(folder).resolve()
            (workspace / "qa").mkdir()
            qa, people = workspace / "qa" / "0001.json", workspace / "characters.json"
            qa.write_text('{"pending": []}', encoding="utf-8")
            for roster in ('[{"name": "周晟安"}]', '{"characters": [{"name": "周晟安"}]}', "{}"):
                people.write_text(roster, encoding="utf-8")
                self.assertEqual(episode_records(workspace, "0001"), (qa, people))
            for roster, problem in (('["周晟安"]', "is not a character table"), ("{", "is missing or not JSON")):
                people.write_text(roster, encoding="utf-8")
                with self.assertRaisesRegex(WorkError, f"characters.json {problem}") as failure:
                    episode_records(workspace, "0001")
                self.assertIn("characters_path", recovery_prompt(str(failure.exception)))
            people.write_text("[]", encoding="utf-8")
            qa.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(WorkError, "qa/0001.json is not a JSON object") as failure:
                episode_records(workspace, "0001")
            self.assertIn("JSON 对象 qa/", recovery_prompt(str(failure.exception)))
            qa.unlink()
            with self.assertRaisesRegex(WorkError, "qa/0001.json is missing or not JSON"):
                episode_records(workspace, "0001")

    def test_a_requeued_exhausted_episode_gets_another_round(self):
        with TemporaryDirectory() as folder:
            record = Path(folder).resolve() / "0014.json"
            grant_attempts(record, 3)
            self.assertFalse(record.exists())
            save(record, {"status": "running", "attempt": 3})
            grant_attempts(record, 3)
            self.assertEqual(attempts_left(read(record), 3), 0)
            save(record, {"status": "needs-inspection", "attempt": 2})
            grant_attempts(record, 3)
            self.assertEqual(attempts_left(read(record), 3), 1)
            save(record, {"status": "needs-inspection", "attempt": 3})
            grant_attempts(record, 3)
            self.assertEqual(read(record)["attemptLimit"], 6)
            grant_attempts(record, 3)
            self.assertEqual(attempts_left(read(record), 3), 3)

    def test_ocr_coverage_counts_the_unsampled_tail_up_to_the_next_frame(self):
        segments = [(0, 55, 55), (55, 110, 110)]
        # 89 frames every 0.5 s from 110 s: the next planned frame (154.5 s) is past a 154.411 s video.
        self.assertEqual(ocr_coverage(segments + [(110, 154.3, 154.5)]), (154.3, 154.5))
        # Stopping at 153.95 s skips the frame at 154.0 s, which the video still contains.
        self.assertLess(ocr_coverage(segments + [(110, 153.95, 154.0)])[1], 154.411 - 0.051)
        self.assertIsNone(ocr_coverage([(0, 55, 55), (56, 110, 110)]))
        self.assertIsNone(ocr_coverage([(1, 55, 55)]))

    def test_multipart_recognition_must_cover_original_source_time(self):
        shared = {"purpose": "screenplay", "service_version": "standard-v2"}
        parts = [{**shared, "id": "a", "offset": 0, "duration": 600},
                 {**shared, "id": "b", "offset": 600, "duration": 52.5}]
        receipt = {**shared, "status": "complete", "parts": parts}
        self.assertTrue(recognition_covers_source(receipt, 652.5))
        self.assertFalse(recognition_covers_source(receipt, 660))
        parts[1]["id"] = parts[0]["id"]
        self.assertFalse(recognition_covers_source(receipt, 652.5))

    def test_manifest_for_complete_original_and_failed_hash(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            video = root / "0001.mp4"
            video.write_bytes(b"video")
            manifest = root / "download-manifest.json"
            item = {"seriesId": FIRST, "title": TITLE, "episodeCount": 1,
                    "downloadedEpisodeCount": 1, "complete": True, "episodes": [
                        {"index": 1, "path": str(video), "bytes": 5, "sha256": digest(video), "durationSeconds": 10,
                         "fullDecodeChecked": True, "validationLevel": "ffprobe-full-decode-sha256"}
                    ]}
            save(manifest, {"ok": True, "complete": True, "items": [item]})
            self.assertEqual(len(verified_media(root, manifest, FIRST, TITLE, 1)), 1)
            video.write_bytes(b"other")
            with self.assertRaisesRegex(WorkError, "校验"):
                verified_media(root, manifest, FIRST, TITLE, 1)

    def test_reuses_the_original_download_after_a_partial_failure(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download = root / "download"
            output = download / "downloads"
            output.mkdir(parents=True)
            save(download / "catalog.json", {"seriesId": FIRST, "title": TITLE, "episodeCount": 1})
            task = {"id": "hgt-" + "0" * 32, "state": "interrupted", "cwd": str(download),
                    "summary": {"code": "task_interrupted"},
                    "request": {"seriesIds": [FIRST], "outputDir": str(output), "quality": "720p", "sourceMode": "legacy"}}
            responses = [
                {"ok": True, "tasks": [task]}, {"ok": True},
                {"ok": True, "tasks": [{**task, "state": "completed", "summary": {"complete": True, "path": str(output)}}]},
            ]
            video = output / "0001.mp4"
            video.write_bytes(b"video")
            episode = {"index": 1, "path": str(video), "bytes": 5, "sha256": digest(video), "durationSeconds": 10,
                       "fullDecodeChecked": True, "validationLevel": "ffprobe-full-decode-sha256"}
            save(output / "download-manifest.json", {"ok": True, "complete": True, "items": [
                {"seriesId": FIRST, "title": TITLE, "episodeCount": 1, "downloadedEpisodeCount": 1,
                 "complete": True, "episodes": [episode]}
            ]})
            cfg = {"quality": "720p", "maxEpisodesPerSeries": 10, "downloadAttempts": 2, "downloadCooldownSeconds": 0}
            with patch("native.hongguo", side_effect=responses) as cli:
                result = acquire_media(cfg, root, FIRST, {"title": TITLE, "episodes": 1}, lambda: None)
                self.assertEqual(cli.call_args_list[1].args[2], ["retry", task["id"]])
                self.assertEqual(result["downloadTaskId"], task["id"])

    def partial_download(self, root):
        """Return a CLI failure and the bound checkpoint with episodes 1 and 3 already verified."""
        download = root / "download"
        output = download / "downloads"
        request = {"mode": "legacy", "seriesIds": [FIRST], "episodes": None, "sourceIdentity": "jackotom:revision:720p"}
        checkpoint_id = sha256(json.dumps(request, separators=(",", ":")).encode()).hexdigest()[:32]
        checkpoint = output / ("hongguo-" + checkpoint_id)
        checkpoint.mkdir(parents=True)
        save(download / "catalog.json", {"seriesId": FIRST, "title": TITLE, "episodeCount": 4, "sourceMode": "legacy"})
        episodes = [{"vid": str(index), "index": index} for index in range(1, 5)]
        finished = []
        for index in (1, 3):
            video = checkpoint / f"{index:04d}.mp4"
            video.write_bytes(b"video")
            media = {"index": index, "path": str(video), "bytes": 5, "sha256": digest(video),
                     "durationSeconds": 10, "fullDecodeChecked": True, "validationLevel": "ffprobe-full-decode-sha256"}
            finished.append({"seriesId": FIRST, "vid": str(index), "episode": media})
        save(checkpoint / "resume-state.json", {"version": 1, "request": request, "completed": finished,
                                               "plans": [{"seriesId": FIRST, "title": TITLE, "episodeCount": 4,
                                                          "episodes": episodes}]})
        task = {"id": "hgt-" + "0" * 32, "runId": "hgr-" + "1" * 32, "state": "failed", "cwd": str(download),
                "request": {"seriesIds": [FIRST], "outputDir": str(output), "quality": "720p", "sourceMode": "legacy"},
                "summary": {"code": "source_unavailable", "path": str(checkpoint)}}
        cfg = {"quality": "720p", "maxEpisodesPerSeries": 10, "downloadAttempts": 1, "downloadCooldownSeconds": 0}
        work = {"title": TITLE, "episodes": 4}
        return download, task, cfg, work

    def test_reports_verified_missing_episodes_and_safe_diagnostics(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            result = {"ok": False, "taskId": task["id"], "runId": task["runId"], "code": "source_unavailable",
                      "retryable": True, "sourceStage": "video_model", "upstreamCode": "SOURCE_UNAVAILABLE",
                      "message": "https://cdn.example.invalid?secret=hidden",
                      "sourceFailures": [
                          {"source": "web", "code": "PREVIEW_ONLY", "message": "hidden"},
                          {"source": "app", "code": "TIMEOUT", "registrationFailure": "TIMEOUT",
                           "deviceId": "hidden"}, {"source": "live", "code": "NETWORK_ERROR"}]}
            responses = [{"ok": True, "tasks": []}, result, {"ok": True, "tasks": [task]}]
            with patch("native.hongguo", side_effect=responses) as cli, self.assertRaisesRegex(WorkError, "缺第 2、4 集"):
                acquire_media(cfg, root, FIRST, work, lambda: None)
            self.assertEqual(cli.call_count, 3)
            progress = read(download / "progress.json")
            self.assertEqual(progress, {"stage": "needs_attention", "totalEpisodes": 4, "verifiedEpisodes": 2,
                                        "missingEpisodes": [2, 4], "error": {
                                            "code": "source_unavailable", "retryable": True, "sourceStage": "video_model",
                                            "upstreamCode": "SOURCE_UNAVAILABLE", "sourceFailures": [
                                                {"source": "web", "code": "PREVIEW_ONLY"},
                                                {"source": "app", "code": "TIMEOUT",
                                                 "registrationFailure": "TIMEOUT"}]}})
            self.assertFalse((root / "source.json").exists())
            self.assertTrue((Path(task["summary"]["path"]) / "0003.mp4").is_file())

    def test_spends_one_new_round_per_authenticated_requeue(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            attempts_path = download / "attempts.json"
            save(attempts_path, {"attempts": 2, "retryAt": 0})
            generation = "2026-11-24T21:05:32.486Z"
            listing = {"ok": True, "tasks": [task]}
            with patch("native.hongguo", return_value=listing) as cli, self.assertRaises(WorkError):
                acquire_media(cfg, root, FIRST, work, lambda: None)
            self.assertEqual(cli.call_count, 1)
            result = {"ok": False, "taskId": task["id"], "runId": task["runId"], "code": "source_unavailable", "retryable": True}
            with patch("native.hongguo", side_effect=[listing, result, listing]) as cli, self.assertRaises(WorkError):
                acquire_media(cfg, root, FIRST, work, lambda: None, retry_generation=generation)
            self.assertEqual(cli.call_args_list[1].args[2], ["retry", task["id"]])
            record = read(attempts_path)
            self.assertEqual(record["attempts"], 3)
            self.assertEqual(record["retryGenerations"], [generation])
            with patch("native.hongguo", return_value=listing) as cli, self.assertRaises(WorkError):
                acquire_media(cfg, root, FIRST, work, lambda: None, retry_generation=generation)
            self.assertEqual(cli.call_count, 1)
            self.assertEqual(read(attempts_path), record)

    def test_retries_a_confirmed_transient_failure_only_to_its_budget(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            cfg["downloadAttempts"] = 2
            new_run = "hgr-" + "2" * 32
            result = {"ok": False, "taskId": task["id"], "runId": task["runId"], "code": "source_unavailable",
                      "retryable": True}
            responses = [{"ok": True, "tasks": []}, result, {"ok": True, "tasks": [task]},
                         {**result, "runId": new_run}, {"ok": True, "tasks": [{**task, "runId": new_run}]}]
            with patch("native.hongguo", side_effect=responses) as cli, self.assertRaisesRegex(WorkError, "重试已用完"):
                acquire_media(cfg, root, FIRST, work, lambda: None)
            self.assertEqual(cli.call_count, 5)
            self.assertEqual(cli.call_args_list[3].args[2], ["retry", task["id"]])
            self.assertEqual(read(download / "attempts.json")["attempts"], 2)

    def test_keeps_explicit_access_refusal_on_requeue(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            attempts_path = download / "attempts.json"
            record = {"attempts": 1, "retryAt": 0, "taskId": task["id"], "lastResult": {
                "taskId": task["id"], "runId": task["runId"], "code": "source_unavailable", "retryable": False,
                "sourceFailures": [{"source": "app", "code": "HTTP_403",
                                    "registrationFailure": "HTTP_403"}]}}
            save(attempts_path, record)
            with patch("native.hongguo", return_value={"ok": True, "tasks": [task]}) as cli, self.assertRaises(WorkError):
                acquire_media(cfg, root, FIRST, work, lambda: None, retry_generation="2026-11-24T21:05:32Z")
            self.assertEqual(cli.call_count, 1)
            self.assertEqual(read(attempts_path), record)

    def test_reads_only_the_original_legacy_foreground_failure(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            attempts_path = download / "attempts.json"
            record = {"attempts": 1, "retryAt": 0}
            save(attempts_path, record)
            result = {"ok": False, "taskId": task["id"], "runId": task["runId"], "code": "source_unavailable",
                      "retryable": False, "sourceFailures": [
                          {"source": "app", "code": "HTTP_403", "registrationFailure": "HTTP_403"}]}
            save(download / "retry-0123456789.json", result)
            save(download / "retry-123456789a.json", {**result, "runId": "hgr-" + "2" * 32, "retryable": True})
            save(download / "info-9876543210.json", {**result, "retryable": True})
            with patch("native.hongguo", return_value={"ok": True, "tasks": [task]}) as cli, self.assertRaises(WorkError):
                acquire_media(cfg, root, FIRST, work, lambda: None, retry_generation="2026-11-24T21:05:32Z")
            self.assertEqual(cli.call_count, 1)
            self.assertEqual(read(attempts_path), record)
            self.assertEqual(read(download / "progress.json")["error"]["sourceFailures"], result["sourceFailures"])

    def test_rejects_changed_media_in_partial_receipt(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            download, task, cfg, work = self.partial_download(root)
            video = Path(task["summary"]["path"]) / "0003.mp4"
            video.write_bytes(b"other")
            with patch("native.hongguo", return_value={"ok": True, "tasks": [task]}) as cli, self.assertRaisesRegex(WorkError, "第 3 集"):
                acquire_media(cfg, root, FIRST, work, lambda: None, retry_generation="2026-11-24T21:05:32Z")
            self.assertEqual(cli.call_count, 1)
            self.assertEqual(video.read_bytes(), b"other")
            self.assertIsNone(read(download / "progress.json")["missingEpisodes"])


if __name__ == "__main__":
    unittest.main()
