"""Exercise the editor routes with Workshop auth and real database transactions."""

import asyncio
import base64
from contextlib import asynccontextmanager
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from docx import Document
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from app import script_editor, script_library
from app.auth import dependencies
from app.auth.jwt_helper import create_access_token
from app.auth.models import User
from app.db.models import Base, ScriptChapter, ScriptDraft, ScriptEditorCandidate, ScriptEditorPublication, ScriptEpisodeHistory, ScriptStoryboard


@compiles(JSONB, "sqlite")
def _sqlite_jsonb(type_, compiler, **kwargs):
    return compiler.visit_JSON(type_, **kwargs)


def _headers(user_id: int, role: str = "user"):
    token, _ = create_access_token(user_id, f"editor-{user_id}", role)
    return {"authorization": "Bearer " + token}


class ScriptEditorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        database_url = os.environ.get("MUSE_SCRIPT_EDITOR_TEST_POSTGRES_URL")
        self.postgres = bool(database_url)
        if database_url:
            # Keep integration tests within an isolated schema on a local PostgreSQL process.
            url = make_url(database_url)
            if url.drivername != "postgresql+psycopg" or url.host != "127.0.0.1" or url.query:
                raise ValueError("A disposable local PostgreSQL URL is required")
            self.database = create_async_engine(url)
            self.addAsyncCleanup(self.database.dispose)
            self.schema = "muse_editor_test_" + uuid4().hex
            async with self.database.begin() as connection:
                await connection.execute(text(f"CREATE SCHEMA {self.schema}"))
            self.addAsyncCleanup(self.drop_schema)
            self.engine = create_async_engine(url, connect_args={"options": f"-csearch_path={self.schema}"})
        else:
            self.engine = create_async_engine("sqlite+aiosqlite:///" + root.name + "/test.db")

            @event.listens_for(self.engine.sync_engine, "connect")
            def _foreign_keys(connection, _):
                cursor = connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()
        self.addAsyncCleanup(self.engine.dispose)

        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all, tables=[
                User.__table__, ScriptDraft.__table__, ScriptChapter.__table__, ScriptStoryboard.__table__,
                ScriptEpisodeHistory.__table__, ScriptEditorCandidate.__table__, ScriptEditorPublication.__table__,
                script_library.ScriptEntry.__table__, script_library.ScriptVersion.__table__,
            ])
        async with self.sessions.begin() as session:
            session.add_all([User(id=id, username=f"editor-{id}", login_id=f"editor-{id}", role=role)
                             for id, role in [(1, "user"), (2, "user"), (3, "admin")]])
            session.add_all([
                ScriptDraft(id=10, user_id=1, title="雨夜的账本", status="scripted", episode_count=2,
                            outline={"synopsis": "女主寻找账本", "episodes": [{"order": 2, "must_have": ["账本"]}]}),
                ScriptDraft(id=20, user_id=2, title="不属于我的稿", status="draft", episode_count=1),
                ScriptDraft(id=30, user_id=1, title="回收站里的稿", status="draft", episode_count=1, is_deleted=True),
                ScriptDraft(id=40, user_id=1, title="没写完的稿", status="draft", episode_count=2),
            ])
            session.add_all([
                ScriptChapter(draft_id=10, chapter_order=1, title="雨夜", full_text="第1集\n下雨了。", version=1),
                ScriptChapter(draft_id=10, chapter_order=2, title="账本", full_text="第2集\n女主打开抽屉。", version=1),
                ScriptChapter(draft_id=20, chapter_order=1, title="旧稿", full_text="第1集\n旧稿。", version=1),
                ScriptChapter(draft_id=40, chapter_order=1, title="第一集", full_text="只有一集。", version=1),
                ScriptStoryboard(draft_id=10, chapter_order=1, is_stale=0),
                ScriptStoryboard(draft_id=10, chapter_order=2, is_stale=0),
            ])

        @asynccontextmanager
        async def session_scope():
            async with self.sessions() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        for module in (script_editor, script_library, dependencies):
            patched = patch.object(module, "session_scope", session_scope)
            patched.start()
            self.addCleanup(patched.stop)
        app = FastAPI()
        app.include_router(script_editor.router)
        app.include_router(script_library.router)
        self.client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test.example")
        self.addAsyncCleanup(self.client.aclose)
        self.draft_url = "/v1/script-editor/drafts/10"
        self.first_url = self.draft_url + "/episodes/1"
        self.second_url = self.draft_url + "/episodes/2"

    async def drop_schema(self):
        async with self.database.begin() as connection:
            await connection.execute(text(f"DROP SCHEMA {self.schema} CASCADE"))

    async def get(self, url: str, user_id: int = 1):
        response = await self.client.get(url, headers=_headers(user_id))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def stage(self, url: str, base: dict, content: str, actor: int = 1):
        return await self.client.post(url + "/candidates", headers=_headers(actor), json={
            "baseRevision": base["revision"], "content": content, "summary": "保留账本并压缩动作。",
        })

    async def apply(self, url: str, candidate: dict, actor: int = 1):
        return await self.client.post(url + "/apply", headers=_headers(actor), json={"candidateId": candidate["id"]})

    async def publish(self, url: str, revision: str, actor: int = 1, **overrides):
        return await self.client.post(url + "/finalize", headers=_headers(actor), json={
            "baseRevision": revision, "rights": "original", "kind": "drama", "style": "realistic", **overrides,
        })

    async def test_draft_access_and_authorized_search(self):
        unauthorized = await self.client.get(self.draft_url)
        self.assertEqual(unauthorized.status_code, 401)
        blocked = await self.client.get(self.first_url, headers=_headers(2))
        self.assertEqual(blocked.status_code, 403)
        role_mismatch = await self.client.get(self.first_url, headers=_headers(2, "admin"))
        self.assertEqual(role_mismatch.status_code, 403)
        deleted = await self.client.get("/v1/script-editor/drafts/30", headers=_headers(1))
        self.assertEqual(deleted.status_code, 404)
        items = await self.get("/v1/script-editor/drafts?query=稿")
        self.assertEqual([item["id"] for item in items["items"]], [40])
        admin_items = await self.get("/v1/script-editor/drafts?limit=2", 3)
        self.assertEqual(admin_items["nextOffset"], 2)
        page_two = await self.get("/v1/script-editor/drafts?limit=2&offset=2", 3)
        self.assertEqual(page_two["nextOffset"], None)
        self.assertEqual({row["id"] for row in [*admin_items["items"], *page_two["items"]]}, {10, 20, 40})
        self.assertTrue((await self.get(self.draft_url))["canFinalize"])
        self.assertFalse((await self.get(self.draft_url, 3))["canFinalize"])
        self.assertEqual((await self.get(self.draft_url))["context"]["outline"]["synopsis"], "女主寻找账本")

    async def test_ordinary_editor_creates_drafts_and_fills_preexisting_empty_episodes(self):
        url = "/v1/script-editor/drafts"
        body = {"title": "风雨里的账本", "episodeCount": 2, "requestId": str(uuid4())}
        self.assertEqual((await self.client.post(url, json=body)).status_code, 401)
        response = await self.client.post(url, headers=_headers(1), json=body)
        self.assertEqual(response.status_code, 200, response.text)
        draft = response.json()
        self.assertEqual([row["episode"] for row in draft["episodes"]], [1, 2])
        self.assertFalse(draft["canFinalize"])
        empty_export = await self.client.get(f"{url}/{draft['id']}/export", headers=_headers(1))
        self.assertEqual(empty_export.status_code, 404)
        retry = await self.client.post(url, headers=_headers(1), json=body)
        self.assertEqual(retry.json()["id"], draft["id"])
        reused = await self.client.post(url, headers=_headers(1), json={**body, "title": "另一份草稿"})
        self.assertEqual(reused.status_code, 409)
        self.assertNotIn(draft["id"], [item["id"] for item in (await self.get(url, 2))["items"]])
        refused_owner = await self.client.post(url, headers=_headers(1), json={"title": "错误归属", "userId": 2})
        self.assertEqual(refused_owner.status_code, 422)
        old = "/v1/script-editor/drafts/40/episodes/2"
        for episode_url in (f"{url}/{draft['id']}/episodes/1", old):
            empty = await self.get(episode_url)
            self.assertEqual(empty["content"], "")
            changed = await self.client.patch(episode_url, headers=_headers(1), json={
                "baseRevision": empty["revision"], "content": "我在这里写正文。",
            })
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual((await self.get(episode_url))["version"], 2)
        missing = await self.client.get(f"{url}/{draft['id']}/episodes/3", headers=_headers(1))
        self.assertEqual(missing.status_code, 404)

    async def test_import_preserves_structured_scenes_and_history_restores_both_layers(self):
        url = "/v1/script-editor/drafts"
        shot = {"scene_no": "1-1", "characters": ["小雨"], "extra": {"continuity": ["湿雨衣", True]},
                "elements": [{"type": "dialogue", "character": "小雨", "content": "账本在这里。"}]}
        response = await self.client.post(url, headers=_headers(1), json={
            "title": "结构化导入",
            "episodes": [{"content": "初稿正文。", "shotsJson": json.dumps([shot])}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        draft_url = f"{url}/{response.json()['id']}"
        chapter_url = draft_url + "/episodes/1"
        board_url = chapter_url + "/storyboard"
        history_url = chapter_url + "/history"
        original = await self.get(chapter_url)
        board = await self.get(board_url)
        self.assertEqual(json.loads(board["shotsJson"]), [shot])
        self.assertTrue(board["exists"])
        forbidden = await self.client.get(board_url, headers=_headers(2))
        self.assertEqual(forbidden.status_code, 403)
        saved = await self.client.patch(chapter_url, headers=_headers(1), json={
            "baseRevision": original["revision"], "content": "第二版正文。",
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue((await self.get(board_url))["stale"])
        failed_save = await self.client.patch(board_url, headers=_headers(1), json={
            "baseRevision": board["revision"], "shotsJson": "[]",
        })
        self.assertEqual(failed_save.status_code, 409)
        current_board = await self.get(board_url)
        changed_shot = {**shot, "characters": ["小雨", "外婆"]}
        board_edit = await self.client.patch(board_url, headers=_headers(1), json={
            "baseRevision": current_board["revision"], "shotsJson": json.dumps([changed_shot]),
        })
        self.assertEqual(board_edit.status_code, 200, board_edit.text)
        self.assertFalse(board_edit.json()["stale"])
        self.assertEqual(json.loads(board_edit.json()["shotsJson"]), [changed_shot])

        for layer, base, last, key in (
            ("chapter", original, saved.json(), "episode"),
            ("storyboard", current_board, board_edit.json(), "storyboard"),
        ):
            versions = await self.get(history_url + f"?layer={layer}")
            self.assertEqual([item["version"] for item in versions["items"]], [1])
            snapshot_url = history_url + f"/{versions['items'][0]['id']}"
            preview = await self.get(snapshot_url + f"?layer={layer}")
            if layer == "chapter":
                self.assertEqual(preview["content"], original["content"])
            else:
                self.assertEqual(json.loads(preview["content"]), [shot])
            restore_url = snapshot_url + "/restore"
            request = {"baseRevision": last["revision"], "layer": layer}
            forbidden = await self.client.post(restore_url, headers=_headers(2), json=request)
            self.assertEqual(forbidden.status_code, 403)
            stale = await self.client.post(restore_url, headers=_headers(1), json={**request, "baseRevision": base["revision"]})
            self.assertEqual(stale.status_code, 409)
            wrong_layer = await self.client.post(restore_url, headers=_headers(1), json={
                **request, "layer": "storyboard" if layer == "chapter" else "chapter",
            })
            self.assertEqual(wrong_layer.status_code, 404)
            if layer == "storyboard":
                # Restoring prose invalidates even a newer storyboard editor's copy.
                self.assertTrue((await self.get(board_url))["stale"])
                request["baseRevision"] = (await self.get(board_url))["revision"]
            restored = await self.client.post(restore_url, headers=_headers(1), json=request)
            self.assertEqual(restored.status_code, 200, restored.text)
            result = restored.json()[key]
            self.assertEqual(result["version"], 3)
            self.assertEqual(result["content"] if layer == "chapter" else json.loads(result["shotsJson"]),
                             original["content"] if layer == "chapter" else [shot])
            self.assertEqual([item["version"] for item in (await self.get(history_url + f"?layer={layer}"))["items"]], [2, 1])

    async def test_legacy_board_snapshots_and_new_board_from_empty(self):
        chapter_url = "/v1/script-editor/drafts/40/episodes/2"
        board_url = chapter_url + "/storyboard"
        scene = {"shot_no": "2-1", "action": "在门口停下。", "legacy": "原始字段"}
        wrapped_scene = {**scene, "action": "在空走廊回头。"}
        async with self.sessions.begin() as session:
            history = ScriptEpisodeHistory(draft_id=40, episode_order=2, stage="storyboard", content=[scene], version=1)
            wrapped = ScriptEpisodeHistory(
                draft_id=40, episode_order=2, stage="storyboard", content={"shots": [wrapped_scene]}, version=2,
            )
            session.add_all([history, wrapped])
            await session.flush()
            snapshot_url = chapter_url + f"/history/{history.id}"
            wrapped_url = chapter_url + f"/history/{wrapped.id}"
        self.assertEqual(json.loads((await self.get(snapshot_url + "?layer=storyboard"))["content"]), [scene])
        self.assertEqual(json.loads((await self.get(wrapped_url + "?layer=storyboard"))["content"]), [wrapped_scene])
        empty = await self.get(board_url)
        self.assertFalse(empty["exists"])
        self.assertEqual(empty["shotsJson"], "[]")
        rejected = await self.client.patch(board_url, headers=_headers(1), json={
            "baseRevision": empty["revision"], "shotsJson": '[{"action":"\\u0000"}]',
        })
        self.assertEqual(rejected.status_code, 422)
        restored = await self.client.post(snapshot_url + "/restore", headers=_headers(1), json={
            "baseRevision": empty["revision"], "layer": "storyboard",
        })
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(json.loads(restored.json()["storyboard"]["shotsJson"]), [scene])
        restored_wrapped = await self.client.post(wrapped_url + "/restore", headers=_headers(1), json={
            "baseRevision": restored.json()["storyboard"]["revision"], "layer": "storyboard",
        })
        self.assertEqual(restored_wrapped.status_code, 200, restored_wrapped.text)
        self.assertEqual(json.loads(restored_wrapped.json()["storyboard"]["shotsJson"]), [wrapped_scene])
        self.assertEqual((await self.get(chapter_url))["content"], "")

    async def test_ordinary_editor_exports_word_and_imports_the_document_as_editable_text(self):
        url = "/v1/script-editor/drafts"
        contents = ["下雨了，女主走到门口。", "女主打开抽屉拿到账本。"]
        draft = await self.client.post(url, headers=_headers(1), json={
            "title": "王家的往事", "episodes": [{"content": content} for content in contents],
        })
        self.assertEqual(draft.status_code, 200, draft.text)
        export_url = f"{url}/{draft.json()['id']}/export"
        self.assertEqual((await self.client.get(export_url)).status_code, 401)
        self.assertEqual((await self.client.get(export_url, headers=_headers(2))).status_code, 403)
        exported = await self.get(export_url + "?format=docx")
        self.assertIn("王家的往事", exported["filename"])
        self.assertEqual(exported["mime"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        document = Document(io.BytesIO(base64.b64decode(exported["base64"])))
        self.assertTrue(set(contents) <= {paragraph.text for paragraph in document.paragraphs})
        for format, mime in (("txt", "text/plain"), ("md", "text/markdown")):
            selected = await self.get(export_url + f"?format={format}&episode=2")
            self.assertTrue(selected["mime"].startswith(mime))
            decoded = base64.b64decode(selected["base64"]).decode("utf-8")
            self.assertIn(contents[1], decoded)
            self.assertNotIn(contents[0], decoded)
        imported = await self.client.post(url, headers=_headers(1), json={
            "title": "原稿回读", "file": {"filename": exported["filename"], "base64": exported["base64"]},
        })
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()["episodeCount"], 2)
        contents[0] = "王家的往事\n\n" + contents[0]
        for order, content in enumerate(contents, start=1):
            self.assertEqual((await self.get(f"{url}/{imported.json()['id']}/episodes/{order}"))["content"], content)
        failed = await self.client.post(url, headers=_headers(1), json={
            "title": "损坏的文件", "file": {"filename": "坏.docx", "base64": "bm90IHdvcmQ="},
        })
        self.assertEqual(failed.status_code, 422)
        self.assertEqual((await self.get(url + "?query=损坏"))["items"], [])

    async def test_file_import_keeps_preface_with_first_episode(self):
        preface = "前情：女主一直没说出自己的真实姓名。"
        opening = "女主推开木门。"
        followup = "第二天，镇上的水井干了。"
        paragraphs = [preface, "第一集：归来", opening, "第二集：水井", followup]
        document = Document()
        for paragraph in paragraphs:
            document.add_paragraph(paragraph)
        word = io.BytesIO()
        document.save(word)
        sources = (
            ("剧稿.txt", "\n\n".join(paragraphs).encode("utf-8")),
            ("剧稿.md", ("\n\n".join(paragraphs)).replace("\n\n第", "\n\n## 第").encode("utf-8")),
            ("剧稿.docx", word.getvalue()),
        )
        url = "/v1/script-editor/drafts"
        for filename, source in sources:
            with self.subTest(filename=filename):
                result = await self.client.post(url, headers=_headers(1), json={
                    "title": filename, "file": {"filename": filename, "base64": base64.b64encode(source).decode("ascii")},
                })
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json()["episodeCount"], 2)
                first = await self.get(f"{url}/{result.json()['id']}/episodes/1")
                second = await self.get(f"{url}/{result.json()['id']}/episodes/2")
                self.assertEqual((first["title"], first["content"]), ("第1集 归来", preface + "\n\n" + opening))
                self.assertEqual((second["title"], second["content"]), ("第2集 水井", followup))

    async def test_reviewed_candidate_apply_changes_only_the_target_and_records_history(self):
        first = await self.get(self.first_url)
        second = await self.get(self.second_url)
        bad_scope = await self.stage(self.second_url, first, "跨集意外修改")
        self.assertEqual(bad_scope.status_code, 409)

        staged = await self.stage(self.second_url, second, "第2集\n女主从抽屉拿出账本。")
        self.assertEqual(staged.status_code, 200, staged.text)
        candidate = staged.json()
        retry = await self.stage(self.second_url, second, candidate["content"])
        self.assertEqual(retry.json(), candidate)
        pending = await self.get(self.second_url)
        self.assertEqual(pending["candidate"], candidate)
        self.assertEqual(pending["content"], second["content"])
        self.assertIsNone((await self.get(self.second_url, 3))["candidate"])
        self.assertEqual((await self.apply(self.second_url, candidate, 3)).status_code, 409)
        self.assertEqual((await self.apply(self.first_url, candidate)).status_code, 409)
        changed = await self.apply(self.second_url, candidate)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["content"], candidate["content"])
        self.assertEqual(changed.json()["version"], 2)
        self.assertIsNone(changed.json()["candidate"])
        self.assertEqual(await self.get(self.first_url), first)
        self.assertEqual((await self.apply(self.second_url, candidate)).status_code, 409)
        async with self.sessions() as session:
            old = (await session.scalars(select(ScriptEpisodeHistory))).one()
            self.assertEqual((old.episode_order, old.version, old.content["full_text"]), (2, 1, second["content"]))
            storyboards = (await session.scalars(select(ScriptStoryboard).order_by(ScriptStoryboard.chapter_order))).all()
            self.assertEqual([storyboard.is_stale for storyboard in storyboards], [0, 1])

    async def test_newly_saved_episode_conflicts_with_staged_candidate_then_allows_discard(self):
        base = await self.get(self.second_url)
        staged = await self.stage(self.second_url, base, "候选稿留在这里。")
        candidate = staged.json()
        replacement = await self.stage(self.second_url, base, "另一份候选")
        self.assertNotEqual(replacement.json()["id"], candidate["id"])
        old_apply = await self.apply(self.second_url, candidate)
        self.assertEqual(old_apply.json()["detail"]["code"], "SCRIPT_EDITOR_CANDIDATE_CHANGED")
        saved = await self.client.patch(self.second_url, headers=_headers(1), json={
            "baseRevision": base["revision"], "content": "用户亲自改了原稿。",
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        conflict = await self.apply(self.second_url, replacement.json())
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["detail"]["code"], "SCRIPT_EDITOR_VERSION_CHANGED")
        discarded = await self.client.post(self.second_url + "/discard", headers=_headers(1), json={
            "candidateId": replacement.json()["id"],
        })
        self.assertEqual(discarded.status_code, 200, discarded.text)
        self.assertEqual(discarded.json()["content"], "用户亲自改了原稿。")
        self.assertIsNone(discarded.json()["candidate"])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(ScriptEpisodeHistory)), 1)

    async def test_finalization_is_idempotent_and_preserves_the_picked_version(self):
        original_draft = await self.get(self.draft_url)
        missing_draft = await self.get("/v1/script-editor/drafts/40")
        self.assertFalse(missing_draft["canFinalize"])
        self.assertEqual((await self.publish("/v1/script-editor/drafts/40", missing_draft["revision"])).status_code, 409)
        self.assertEqual((await self.publish(self.draft_url, original_draft["revision"], actor=3)).status_code, 403)
        self.assertEqual((await self.publish(self.draft_url, original_draft["revision"], rights="licensed")).status_code, 422)

        first = await self.publish(self.draft_url, original_draft["revision"])
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["created"])
        script_id = first.json()["script"]["id"]
        second = await self.publish(self.draft_url, original_draft["revision"])
        self.assertFalse(second.json()["created"])
        self.assertEqual(second.json()["script"]["id"], script_id)
        picked = await self.client.post(f"/v1/script-library/{script_id}/pick", headers=_headers(3), json={"version": 1})
        self.assertEqual(picked.status_code, 200, picked.text)

        base = await self.get(self.second_url)
        changed = await self.client.patch(self.second_url, headers=_headers(1), json={
            "baseRevision": base["revision"], "content": "第2集\n采纳新版。",
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        stale = await self.publish(self.draft_url, original_draft["revision"])
        self.assertEqual(stale.status_code, 409)
        current = await self.get(self.draft_url)
        first_new = await self.publish(self.draft_url, current["revision"])
        self.assertEqual(first_new.status_code, 200, first_new.text)
        self.assertEqual(first_new.json()["script"]["id"], script_id)
        self.assertEqual(first_new.json()["version"], 2)
        self.assertEqual(first_new.json()["script"]["picked"]["version"], 1)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(script_library.ScriptEntry)), 1)
            versions = list((await session.scalars(select(script_library.ScriptVersion).order_by(script_library.ScriptVersion.number))).all())
            self.assertEqual([v.content[0]["content"] for v in versions], ["第1集\n下雨了。"] * 2)
            self.assertEqual([v.content[1]["content"] for v in versions], ["第2集\n女主打开抽屉。", "第2集\n采纳新版。"])

    async def test_postgres_concurrent_saves_and_first_publication(self):
        if not self.postgres:
            self.skipTest("PostgreSQL is required for row locks")
        base = await self.get(self.second_url)
        edits = await asyncio.gather(*(
            self.client.patch(self.second_url, headers=_headers(1), json={
                "baseRevision": base["revision"], "content": content,
            }) for content in ["保存甲", "保存乙"]
        ))
        self.assertEqual(sorted(response.status_code for response in edits), [200, 409])
        current = await self.get(self.draft_url)
        both = await asyncio.gather(*(
            self.publish(self.draft_url, current["revision"]) for _ in range(2)
        ))
        self.assertEqual([response.status_code for response in both], [200, 200])
        self.assertEqual(sorted(response.json()["created"] for response in both), [False, True])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(ScriptEpisodeHistory)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(script_library.ScriptEntry)), 1)

    async def test_postgres_concurrent_create_receipt_and_first_storyboard_save(self):
        if not self.postgres:
            self.skipTest("PostgreSQL is required for row locks")
        drafts = "/v1/script-editor/drafts"
        body = {"title": "并发创建", "requestId": str(uuid4())}
        created = await asyncio.gather(*(self.client.post(drafts, headers=_headers(1), json=body) for _ in range(2)))
        self.assertEqual([response.status_code for response in created], [200, 200])
        self.assertEqual(created[0].json()["id"], created[1].json()["id"])
        board_url = f"{drafts}/{created[0].json()['id']}/episodes/1/storyboard"
        base = await self.get(board_url)
        both = await asyncio.gather(*(
            self.client.patch(board_url, headers=_headers(1), json={
                "baseRevision": base["revision"], "shotsJson": json.dumps([{"action": action}]),
            }) for action in ["停下脚步", "继续向前"]
        ))
        self.assertEqual(sorted(response.status_code for response in both), [200, 409])
        self.assertEqual((await self.get(board_url))["version"], 2)
