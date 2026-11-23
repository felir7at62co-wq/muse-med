"""Behavior of the archived Workshop 视频转剧本 factory job against a scripted worker and an in-memory job table, and the
refusals of its archived job API, pipeline step and startup recovery."""
import asyncio
from contextlib import asynccontextmanager
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import types
import unittest

APP = Path(__file__).resolve().parent.parent / "app"
SERIES = ["748110834663686453" + str(n) for n in range(6)]

FAKE_WORKER = textwrap.dedent('''
    """Scripted stand-in for worker.py --once: the next scenario in SCENARIO_FILE decides the outcome."""
    import json, os, signal, sys, time
    from pathlib import Path
    cfg = json.loads(Path(sys.argv[1]).read_text())
    root = Path(cfg["stateRoot"])
    queue = Path(os.environ["SCENARIO_FILE"])
    with queue.open() as f:
        rows = json.load(f)
    if not rows:
        sys.exit(0)
    kind, key = rows.pop(0)
    queue.write_text(json.dumps(rows))
    work = root / key
    work.mkdir(parents=True)
    (work / "series.json").write_text(json.dumps({"seriesId": key, "work": {"title": "剧" + key[-1]}}))
    if kind == "hang":
        (root / "active.json").write_text(json.dumps({"workId": key}))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        time.sleep(60)
    if kind == "reject":
        (work / "review-result.json").write_text(json.dumps({"decision": "reject", "reason": "受众偏年轻"}))
        print(json.dumps({"workId": key, "state": "rejected"}))
        sys.exit(0)
    receipts = []
    for n in (1, 2):
        scripts = work / "episodes" / f"{n:04d}" / "scripts"
        scripts.mkdir(parents=True)
        (scripts / f"{n:04d}.md").write_text(f"第{n}集正文")
        receipts.append({"episode": n})
    (work / "delivery.json").write_text(json.dumps({"receipt": receipts}))
    (work / "download" / "downloads").mkdir(parents=True)
    print(json.dumps({"workId": key, "state": "needs-attention"}))
''')


class Store:
    jobs = {}
    products = []


class FactoryJob:
    id = None

    def __init__(self, **values):
        self.__dict__.update(values)


class FactoryProduct:
    job_id = product_type = status = None

    def __init__(self, **values):
        self.__dict__.update(values)


class Session:
    async def get(self, model, key, **options):
        return Store.jobs.get(key) if model is FactoryJob else None

    def add(self, item):
        Store.products.append(item)

    async def commit(self):
        return None

    async def execute(self, query):
        rows = list(Store.products)
        return types.SimpleNamespace(scalars=lambda: types.SimpleNamespace(all=lambda: rows))


@asynccontextmanager
async def session_scope():
    yield Session()


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


class BackgroundTasks:
    def __init__(self):
        self.tasks = []

    def add_task(self, function, *args):
        self.tasks.append((function, args))


class Query:
    """select(...).where(...) stand-in; each test uses a single job, so every product matches."""

    def where(self, *conditions):
        return self


class PipelineQuery:
    """select(model).where(...) stand-in for the pipeline; remembers which table is read."""

    def __init__(self, model):
        self.model = model

    def where(self, *conditions):
        return self


class PipelineSession:
    """Session of the pipeline's get_session(): one pipeline, one run and the single job of the test."""
    rows = {}

    async def execute(self, query):
        if query.model is FactoryJob:
            found = next(iter(Store.jobs.values()), None)
        else:
            found = self.rows.get(query.model)
        return types.SimpleNamespace(scalar_one_or_none=lambda: found,
                                     scalars=lambda: types.SimpleNamespace(all=lambda: []))

    async def commit(self):
        return None


async def get_session():
    yield PipelineSession()


MODULES = ("app", "app.db", "app.factory", "app.db.session", "app.db.models", "app.factory.models",
           "app.factory.create_spawn", "app.factory.import_spawn_impl", "app.factory.video_transcribe",
           "app.factory.pipeline", "fastapi")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_module():
    """Import video_transcribe as app.factory.video_transcribe with in-memory db and models modules."""
    for name in ("app", "app.db", "app.factory"):
        sys.modules[name] = types.ModuleType(name)
        sys.modules[name].__path__ = []
    sys.modules["app.db.session"] = types.SimpleNamespace(session_scope=session_scope, get_session=get_session)
    sys.modules["app.factory.models"] = types.SimpleNamespace(FactoryJob=FactoryJob, FactoryProduct=FactoryProduct)
    sys.modules["fastapi"] = types.SimpleNamespace(HTTPException=HTTPException)
    return load("app.factory.video_transcribe", APP / "factory/video_transcribe.py")


def load_pipeline():
    """Import app/factory/pipeline.py as app.factory.pipeline beside the module that load_module() imported."""
    from sqlalchemy.orm import declarative_base
    sys.modules["app.db.models"] = types.SimpleNamespace(Base=declarative_base())

    async def unused(*args):
        raise AssertionError("a 视频转剧本 pipeline does not start other job types")
    sys.modules["app.factory.create_spawn"] = types.SimpleNamespace(run_create_spawn_job=unused)
    sys.modules["app.factory.import_spawn_impl"] = types.SimpleNamespace(run_import_spawn_job=unused)
    return load("app.factory.pipeline", APP / "factory/pipeline.py")


class VideoTranscribeTest(unittest.TestCase):
    def setUp(self):
        saved = {name: sys.modules.get(name) for name in MODULES}

        def restore():
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
        self.addCleanup(restore)
        self.vt = load_module()
        self.vt.CHECK_SECONDS = 0.05
        self.vt.POLL_SECONDS = 0.1
        self.vt.PROGRESS_SECONDS = 0.05
        self.vt.STOP_GRACE_SECONDS = 5
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        for name in ("app", "sdk/account", "download/profiles/hongguo", "slots", "bin"):
            (root / name).mkdir(parents=True)
        (root / "app/worker.py").write_text(FAKE_WORKER)
        (root / "sdk/account/session.json").write_text("{}")
        (root / "sdk/presets/transcription").mkdir(parents=True)
        (root / "sdk/presets/transcription/preset.yml").write_text("name: transcription")
        (root / "sdk/transcription.patch.json").write_text(json.dumps([
            {"id": "session-persistence-jsonl", "config": {"root": str(root / "sdk/sessions")}},
            {"id": "agent-preset-registry", "config": {"dirs": [str(root / "sdk/presets/transcription")]}}]))
        for name in ("python", "dsh", "node", "ffmpeg", "ffprobe", "token", "media", "skills", "source", "pypath"):
            (root / "bin" / name).write_text("")
        self.scenarios = root / "scenarios.json"
        os.environ["SCENARIO_FILE"] = str(self.scenarios)
        bin_ = root / "bin"
        self.dep = {
            "workerApp": str(root / "app"), "python": sys.executable, "pythonPath": str(bin_ / "pypath"),
            "dsh": str(bin_ / "dsh"), "node": str(bin_ / "node"), "sourceRoot": str(bin_ / "source"),
            "mediaRuntime": str(bin_ / "media"), "skillFiles": str(bin_ / "skills"), "ffmpeg": str(bin_ / "ffmpeg"),
            "ffprobe": str(bin_ / "ffprobe"), "stationTokenFile": str(bin_ / "token"),
            "templateSdkHome": str(root / "sdk"), "templateDownloadHome": str(root / "download"),
            "slotRoot": str(root / "slots"), "stationBase": "http://127.0.0.1:9/api/service/hits",
            "provider": "p", "model": "m", "maxSlots": 2,
        }
        config = root / "hit.json"
        config.write_text(json.dumps(self.dep))
        os.environ[self.vt.CONFIG_ENV] = str(config)
        self.queued = 10

        async def station_get(dep, route):
            if route.startswith("/candidates"):
                return {"counts": {"queued": self.queued}}
            return {"state": "needs-attention", "lastError": {"reason": "原片缺集"}, "progress": {}}
        self.vt.station_get = station_get
        self.vt.select = lambda model: Query()
        Store.jobs, Store.products = {}, []

    def tearDown(self):
        self.temp.cleanup()

    def job(self, job_id=1, **result):
        Store.jobs[job_id] = FactoryJob(id=job_id, status="pending", result=dict(result), progress={}, error_message=None, finished_at=None)
        return Store.jobs[job_id]

    def scenario(self, *rows):
        self.scenarios.write_text(json.dumps([list(row) for row in rows]))

    def run_job(self, config, job_id=1, timeout=30):
        asyncio.run(asyncio.wait_for(self.vt.run_video_transcribe_job(job_id, config, 7), timeout))
        return Store.jobs[job_id]

    def test_options_normalize_parameters(self):
        self.assertEqual(self.vt.options({}, self.dep), {"count": 0, "concurrency": 1, "quality": "720p", "publish": False, "only_series": []})
        parsed = self.vt.options({"only_series": f"{SERIES[0]}，{SERIES[1]} {SERIES[0]}"}, self.dep)
        self.assertEqual(parsed["only_series"], SERIES[:2])
        for bad in ({"concurrency": 3}, {"count": -1}, {"quality": "4k"}, {"only_series": ["abc"]}):
            with self.assertRaises(ValueError):
                self.vt.options(bad, self.dep)

    def test_outcome_reads_last_machine_line(self):
        self.assertEqual(self.vt.outcome(['{"state": "waiting", "code": "DISK_RESERVE", "message": "满"}']),
                         {"kind": "waiting", "code": "DISK_RESERVE", "message": "满"})
        self.assertEqual(self.vt.outcome(["noise", json.dumps({"workId": SERIES[0], "state": "published"})]),
                         {"kind": "retired", "series": SERIES[0], "state": "published"})
        self.assertEqual(self.vt.outcome([]), {"kind": "idle"})

    def test_slot_keeps_identity_and_claimed_quality(self):
        opts = self.vt.options({"quality": "720p"}, self.dep)
        paths = self.vt.prepare_slot(self.dep, 1, opts)
        worker = json.loads(paths["config"].read_text())
        self.assertEqual(worker["workerId"], "muse-hit-workshop-1")
        self.assertEqual(worker["episodeAttempts"], 3)
        patch = json.loads((paths["sdk"] / "transcription.patch.json").read_text())
        self.assertEqual(patch[0]["config"]["root"], str(paths["sdk"] / "sessions"))
        self.assertEqual(patch[1]["config"]["dirs"], [str(paths["sdk"] / "presets/transcription")])
        self.assertTrue((paths["sdk"] / "presets/transcription/preset.yml").is_file())
        (paths["state"] / "active.json").write_text("{}")
        self.vt.prepare_slot(self.dep, 1, self.vt.options({"quality": "1080p"}, self.dep))
        self.assertEqual(json.loads(paths["config"].read_text())["quality"], "720p")

    def test_count_delivers_scripts_and_skips_rejected_series(self):
        self.job()
        self.scenario(("reject", SERIES[0]), ("deliver", SERIES[1]), ("deliver", SERIES[2]), ("deliver", SERIES[3]))
        job = self.run_job({"count": 2, "concurrency": 1})
        self.assertEqual(job.status, "completed")
        self.assertEqual(job.progress["percent"], 100)
        self.assertEqual([p.meta_data["series_id"] for p in Store.products], SERIES[1:3])
        chapters = json.loads(Store.products[0].content)["chapters"]
        self.assertEqual([c["order"] for c in chapters], [1, 2])
        self.assertEqual(chapters[0]["content"], "第1集正文")
        self.assertEqual([r["series_id"] for r in job.result["rejected"]], [SERIES[0]])
        slot = Path(self.dep["slotRoot"]) / "slot-1" / "state"
        self.assertFalse((slot / SERIES[1] / "download" / "downloads").exists())
        self.assertEqual(json.loads(self.scenarios.read_text()), [["deliver", SERIES[3]]])

    def test_count_ends_when_the_queue_is_empty(self):
        self.job()
        self.queued = 0
        self.scenario()
        job = self.run_job({"count": 3})
        self.assertEqual(job.status, "completed")
        self.assertEqual(Store.products, [])

    def test_stop_terminates_the_worker_and_keeps_results(self):
        job = self.job()
        self.scenario(("deliver", SERIES[0]), ("hang", SERIES[1]))

        async def scenario():
            task = asyncio.create_task(self.vt.run_video_transcribe_job(1, {"count": 0}, 7))
            while not (Path(self.dep["slotRoot"]) / "slot-1/state/active.json").exists():
                await asyncio.sleep(0.05)
            job.result["manual_stop_requested"] = True
            await asyncio.wait_for(task, 20)
        asyncio.run(scenario())
        self.assertEqual(job.status, "stopped")
        self.assertNotIn("manual_stop_requested", job.result)
        self.assertEqual([r["series_id"] for r in job.result["delivered"]], [SERIES[0]])
        self.assertTrue((Path(self.dep["slotRoot"]) / "slot-1/state/active.json").exists())

    def test_attention_records_the_station_reason(self):
        self.job()
        self.scenario(("reject", SERIES[0]))

        original = self.vt.Run.record

        async def record(run, paths, result):
            await original(run, paths, {**result, "state": "needs-attention"})
        self.vt.Run.record = record
        self.queued = 0
        job = self.run_job({"count": 1})
        self.assertEqual(job.result["attention"][0]["reason"], "原片缺集")

    def test_steps_refuse_the_archived_step_and_keep_other_steps(self):
        other = [{"type": "create_spawn", "config": {"total_scripts": 2}}, {"type": "distribute", "config": {"target_id": 3}}]
        self.assertEqual(self.vt.checked_steps(other), other)
        self.assertEqual(self.vt.checked_steps(None), [])
        with self.assertRaises(HTTPException) as caught:
            self.vt.checked_steps([*other, {"type": "video_transcribe", "config": {"count": 2}}])
        self.assertEqual((caught.exception.status_code, caught.exception.detail), (410, self.vt.ARCHIVED))

    def test_status_reports_the_archived_step(self):
        self.assertEqual(asyncio.run(self.vt.status()), {"ready": False, "error": "视频转剧本已归档：转写改由云端 Muse 的转写 Bot 完成"})
        refusal = self.vt.archived()
        self.assertEqual((refusal.status_code, refusal.detail), (410, self.vt.ARCHIVED))

    def test_startup_recovery_ends_an_interrupted_job(self):
        running = self.job(1, delivered=[{"series_id": SERIES[0]}])
        running.status = "running"
        stopped = self.job(2)
        stopped.status = "stopped"
        for job_id in (1, 2, 3):
            asyncio.run(self.vt.end_interrupted(job_id))
        self.assertEqual((running.status, running.error_message), ("failed", self.vt.ARCHIVED))
        self.assertIsNotNone(running.finished_at)
        self.assertEqual(running.result["delivered"], [{"series_id": SERIES[0]}])
        self.assertEqual((stopped.status, stopped.error_message, stopped.finished_at), ("stopped", None, None))

    def test_restart_keeps_a_stop_requested_before_it(self):
        job = self.job(manual_stop_requested=True, delivered=[{"series_id": SERIES[0]}])
        job.status = "running"
        self.scenario(("deliver", SERIES[1]))
        job = self.run_job({"count": 0})
        self.assertEqual(job.status, "stopped")
        self.assertNotIn("manual_stop_requested", job.result)
        self.assertEqual([r["series_id"] for r in job.result["delivered"]], [SERIES[0]])
        self.assertEqual(json.loads(self.scenarios.read_text()), [["deliver", SERIES[1]]])

    def run_pipeline(self, run, resume):
        """Run or resume a one-step 视频转剧本 pipeline run."""
        pipeline = load_pipeline()
        pipeline.select = PipelineQuery
        PipelineSession.rows = {
            pipeline.FactoryPipeline: types.SimpleNamespace(id=1, name="自动流", model_config={},
                                                            steps=[{"type": "video_transcribe", "config": {"count": 2}}]),
            pipeline.FactoryPipelineRun: run,
        }
        updates = []

        async def update_run(run_id, **fields):
            updates.append(fields)
            run.__dict__.update(fields)
        pipeline._update_run = update_run
        asyncio.run(asyncio.wait_for(pipeline.run_pipeline(1, 1, 7, resume=resume), 30))
        return updates

    def test_pipeline_step_fails_without_starting_or_reopening_a_job(self):
        job = self.job(delivered=[{"series_id": SERIES[0]}])
        job.status = "stopped"
        for resume in (False, True):
            run = types.SimpleNamespace(id=1, status="stopped", step_runs=[{"type": "video_transcribe", "job_id": job.id, "status": "stopped"}])
            self.run_pipeline(run, resume)
            self.assertEqual((run.status, run.error_message), ("failed", self.vt.ARCHIVED))
            self.assertEqual([(s["type"], s["job_id"], s["status"], s["summary"]) for s in run.step_runs],
                             [("video_transcribe", None, "failed", self.vt.ARCHIVED)])
        self.assertEqual(list(Store.jobs), [1])
        self.assertEqual(job.status, "stopped")
        self.assertEqual(Store.products, [])

if __name__ == "__main__":
    unittest.main()
