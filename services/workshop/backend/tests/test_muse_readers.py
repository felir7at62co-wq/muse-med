"""Exercise library readers through the Muse sign-in adapter and the library routes on a temporary database."""

import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

import app.config
import app.db
from app import muse_login, muse_readers, script_library
from app.auth import dependencies
from app.auth.models import User
from app.db.models import Base

ISSUER = "https://muse.example"
SECRET = "s" * 43
READER = "a1b2c3d4e5f60718"
SCRIPT = {"title": "盛夏", "rights": "original", "kind": "drama", "style": "realistic",
          "episodes": [{"order": 1, "title": "第一集", "content": "第1集\n下雨了。"}]}


@compiles(JSONB, "sqlite")
def _sqlite_jsonb(type_, compiler, **kwargs):
    return compiler.visit_JSON(type_, **kwargs)


class MuseReaderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        self.engine = create_async_engine("sqlite+aiosqlite:///" + root.name + "/test.db")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all, tables=[
                User.__table__, script_library.ScriptEntry.__table__, script_library.ScriptVersion.__table__])
        async with self.sessions.begin() as session:
            session.add(User(id=1, username="林晨", login_id="editor-1", role="user", status="active"))

        @asynccontextmanager
        async def session_scope():
            async with self.sessions() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        for module in (muse_readers, script_library, dependencies, app.db):
            patched = patch.object(module, "session_scope", session_scope)
            patched.start()
            self.addCleanup(patched.stop)
        bindings = self.root / "bindings.json"
        bindings.write_text(json.dumps({"issuer": ISSUER, "users": {"bound-editor": 1}}))
        self.enterContext(patch.dict(os.environ, {
            "MUSE_WORKBENCH_ISSUER": ISSUER, "MUSE_WORKBENCH_PUBLIC_ORIGIN": ISSUER, "MUSE_WORKBENCH_SECRET": SECRET,
            "MUSE_WORKBENCH_BINDINGS": str(bindings), "MUSE_WORKBENCH_STATE_DB": str(self.root / "signin.sqlite3"),
            "MUSE_WORKBENCH_SHARED_HOST": "1", "JWT_SECRET": "test-only-" * 6,
        }))
        self.enterContext(patch.object(app.config, "get_settings", lambda: types.SimpleNamespace(auth_required=True)))
        application = FastAPI()
        muse_login.configure_muse_login(application, "script-workshop")
        application.include_router(script_library.router)
        self.client = AsyncClient(transport=ASGITransport(app=application), base_url="http://test.example")
        self.addAsyncCleanup(self.client.aclose)

    async def sign_in(self, sub=READER, **body):
        return await self.client.post("/v1/auth/muse/internal-session", json={"sub": sub, **body},
                                      headers={"Authorization": "Bearer " + SECRET})

    async def token(self, sub=READER, **body):
        response = await self.sign_in(sub, **body)
        self.assertEqual(response.status_code, 200, response.text)
        return {"authorization": "Bearer " + response.json()["access_token"]}, response.json()["user"]

    async def count(self, *where):
        async with self.sessions() as session:
            return (await session.execute(select(func.count()).select_from(User).where(*where))).scalar_one()

    async def set_user(self, user_id, **values):
        async with self.sessions.begin() as session:
            await session.execute(update(User).where(User.id == user_id).values(**values))

    async def test_a_company_account_gets_one_reader_that_reads_the_library(self):
        editor, _ = await self.token("bound-editor", company=True)
        published = await self.client.post("/v1/script-library", headers=editor, json=SCRIPT)
        self.assertEqual(published.status_code, 200, published.text)
        entry = published.json()["script"]["id"]
        self.assertEqual((await self.sign_in(username="林晨")).status_code, 403)
        self.assertEqual(await self.count(), 1)

        reader, user = await self.token(username="林晨", company=True)
        self.assertEqual((user["login_id"], user["username"], user["display_name"], user["role"], user["feature_flags"]),
                         ("muse:" + READER, "林晨-a1b2c3", "林晨", "user", {}))
        self.assertEqual((await self.token(username="林晨", company=True))[1]["id"], user["id"])
        self.assertEqual(await self.count(User.login_id == "muse:" + READER), 1)

        listed = await self.client.get("/v1/script-library", headers=reader)
        self.assertEqual((listed.status_code, listed.json()["total"], listed.json()["can_pick"]), (200, 1, False))
        detail = await self.client.get(f"/v1/script-library/{entry}", headers=reader)
        self.assertEqual(detail.json()["content"]["episodes"][0]["content"], "第1集\n下雨了。")
        finalized = await self.client.post("/v1/script-library", headers=reader, json=SCRIPT)
        self.assertEqual(finalized.status_code, 403)
        self.assertEqual((await self.client.post(f"/v1/script-library/{entry}/pick", headers=reader, json={"version": 1})).status_code, 403)

        await self.set_user(user["id"], status="disabled")
        self.assertEqual((await self.sign_in(company=True)).status_code, 403)

    async def test_granted_features_let_a_reader_finalize_and_pick(self):
        reader, user = await self.token(company=True)
        await self.set_user(user["id"], feature_flags={"script_finalize": True})
        finalized = await self.client.post("/v1/script-library", headers=reader, json=SCRIPT)
        self.assertEqual(finalized.status_code, 200, finalized.text)
        entry = finalized.json()["script"]["id"]
        self.assertEqual((await self.client.post(f"/v1/script-library/{entry}/pick", headers=reader, json={"version": 1})).status_code, 403)
        await self.set_user(user["id"], feature_flags={"script_finalize": True, "script_pick": True})
        picked = await self.client.post(f"/v1/script-library/{entry}/pick", headers=reader, json={"version": 1})
        self.assertEqual((picked.status_code, picked.json()["script"]["status"]), (200, "picked"))

    async def test_names_subjects_and_bound_accounts(self):
        unnamed = await muse_readers.resolve_or_provision(READER, None, set())
        async with self.sessions() as session:
            self.assertEqual((await session.get(User, unnamed)).username, "muse-a1b2c3d4")
        for subject in ("../etc", "x" * 60, ""):
            with self.assertRaises(HTTPException) as refused:
                await muse_readers.resolve_or_provision(subject, "林晨", set())
            self.assertEqual(refused.exception.status_code, 403)
        with self.assertRaises(HTTPException) as shared:
            await muse_readers.resolve_or_provision(READER, None, {unnamed})
        self.assertEqual(shared.exception.status_code, 403)
        self.assertEqual(await self.count(), 2)

    async def test_concurrent_first_sign_ins_open_one_reader(self):
        barrier, choose = asyncio.Barrier(4), muse_readers._free_username

        async def together(*args):
            name = await choose(*args)
            await barrier.wait()  # Every sign-in has found no reader before any of them inserts one.
            return name

        with patch.object(muse_readers, "_free_username", together):
            owners = await asyncio.gather(*(muse_readers.resolve_or_provision(READER, "林晨", set()) for _ in range(4)))
        self.assertEqual(len(set(owners)), 1)
        self.assertEqual(await self.count(User.login_id == "muse:" + READER), 1)


if __name__ == "__main__":
    unittest.main()
