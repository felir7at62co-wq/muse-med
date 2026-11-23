"""Exercise the editor routes with Workshop auth and real database transactions."""

import asyncio
from contextlib import asynccontextmanager
import os
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

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
