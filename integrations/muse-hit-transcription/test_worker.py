"""Exercise the worker's real HTTP client against an isolated queue fixture."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from common import WorkError, digest, read, save
from native import acquire_media, verified_media
from station import Station, StationError
from verification import recognition_covers_source
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


class MediaTests(unittest.TestCase):
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
            task = {"id": "hgt-" + "0" * 32, "state": "partial", "cwd": str(download),
                    "request": {"seriesIds": [FIRST], "outputDir": str(output), "quality": "720p"}}
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


if __name__ == "__main__":
    unittest.main()
