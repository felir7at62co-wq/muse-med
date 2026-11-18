"""Exercise both archive adapters without live accounts, payment or upstream API calls."""
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from install import install

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("test_app.muse_login", HERE / "muse_login.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class Workbench(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.bindings = self.root / "bindings.json"
        self.issuer = "https://accounts.example"
        self.public = "https://scripts.example"
        self.priv = "x" * 43
        self.settings = types.SimpleNamespace(auth_upstream=self.issuer, auth_required=True)
        self.enterContext(patch.dict(sys.modules, {"test_app.config": types.SimpleNamespace(get_settings=lambda: self.settings)}))
        self.enterContext(patch.dict(os.environ, {
            "MUSE_WORKBENCH_BINDINGS": str(self.bindings), "MUSE_WORKBENCH_ISSUER": self.issuer,
            "MUSE_WORKBENCH_SECRET": self.priv, "MUSE_WORKBENCH_PUBLIC_ORIGIN": self.public,
            "MUSE_WORKBENCH_STATE_DB": str(self.root / "state.db"),
            "MUSE_WORKBENCH_PARENT_ORIGIN": "dsh-app://app", "JWT_SECRET": "test-only-" * 6,
        }))
        self.write_users({"muse-a": 7})

    def write_users(self, users, **rest):
        self.bindings.write_text(json.dumps({"issuer": self.issuer, "users": users, **rest}))

    def client(self, audience):
        app = FastAPI()
        adapter.configure_muse_login(app, audience)
        return TestClient(app)

    def test_startup_requires_native_access_checks_and_binding_consistency(self):
        self.settings.auth_upstream = ""
        with self.assertRaisesRegex(ValueError, "FW_AUTH_UPSTREAM"):
            self.client("jingliu")
        self.settings.auth_required = False
        with self.assertRaisesRegex(ValueError, "AUTH_REQUIRED"):
            self.client("script-workshop")
        self.settings.auth_required = True
        with patch.dict(os.environ, {"JWT_SECRET": "drama-dev-secret-change-me"}), self.assertRaisesRegex(ValueError, "JWT_SECRET"):
            self.client("script-workshop")
        self.write_users({"a": 1, "b": 1})
        with self.assertRaisesRegex(ValueError, "bindings"):
            self.client("script-workshop")

    def test_role_confirmation_rejects_changes_before_issuing(self):
        current = types.SimpleNamespace(username="owner", display_name="Owner", role="superadmin")
        class Database:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def get(self, model, user_id): return current if user_id == 7 else None
        with patch.dict(sys.modules, {"test_app.auth": types.SimpleNamespace(KnownUser=object(),
                    _issue_session=lambda user: user, effective_role=lambda owner, role: role),
                    "test_app.db": types.SimpleNamespace(get_session=Database)}):
            with self.assertRaises(HTTPException) as rejected:
                adapter.issue_jingliu_session(7, None)
            self.assertEqual(rejected.exception.status_code, 403)
            self.assertEqual(adapter.issue_jingliu_session(7, "superadmin")["role"], "superadmin")
        self.write_users({"muse-a": 7}, jingliuRoles={"typo": "admin"})
        with self.assertRaisesRegex(ValueError, "role"):
            self.client("jingliu")

    def test_native_and_browser_only_bind_verified_subject(self):
        for audience, prefix in (("jingliu", "/v2/auth/muse"), ("script-workshop", "/v1/auth/muse")):
            with self.subTest(audience=audience):
                client = self.client(audience)
                public = self.issuer
                captured, subject = {}, ["muse-a"]
                class Gateway:
                    def __init__(self, **settings): pass
                    async def __aenter__(self): return self
                    async def __aexit__(self, *args): pass
                    async def post(inner, url, headers, json):
                        self.assertEqual(headers, {"Authorization": "Bearer " + self.priv})
                        self.assertEqual(json["audience"], audience)
                        self.assertTrue(url.startswith(public + "/api/workbench-login/"))
                        if url.endswith("/start"):
                            captured.update(json)
                            body = {"authorizeUrl": public + "/workbench-login?test"}
                        else:
                            derived = base64.urlsafe_b64encode(hashlib.sha256(json["verifier"].encode()).digest()).decode().rstrip("=")
                            self.assertEqual(derived, captured["challenge"])
                            body = {"issuer": public, "sub": subject[0], "username": "muse-a"}
                        return types.SimpleNamespace(status_code=200, json=lambda: body)
                mint = AsyncMock(return_value={"token": "workbench-only", "user": {"id": 7}})
                with patch.object(adapter.httpx, "AsyncClient", Gateway), patch.object(adapter, "issue_native_session", mint):
                    legacy = prefix.removesuffix("/muse") + "/feishu/callback"
                    self.assertEqual(client.get(legacy).status_code, 410)
                    self.assertEqual(client.post(prefix + "/challenge", headers={"Origin": "https://foreign.example"}).status_code, 403)
                    self.assertEqual(client.post(prefix + "/browser/start").status_code, 403)
                    page = client.get(prefix + "/login")
                    self.assertIn("使用 Muse 账号登录", page.text)
                    self.assertIn("frame-ancestors dsh-app://app", page.headers["Content-Security-Policy"])
                    for path in ("challenge", "browser/start"):
                        r = client.post(prefix + "/" + path, headers={"Origin": self.public})
                        self.assertEqual(r.status_code, 200, r.text)
                        self.assertEqual(r.headers["cache-control"], "no-store")
                        attempt = r.json()
                        if path == "challenge":
                            captured.update(attempt)
                        else:
                            self.assertEqual(captured["state"], attempt["state"])
                            self.assertNotIn("verifier", attempt)
                        body = {"requestId": attempt["requestId"], "code": "z" * 43}
                        self.assertEqual(client.post(prefix + "/exchange", json=body).json()["user"]["id"], 7)
                        self.assertEqual(client.post(prefix + "/exchange", json=body).status_code, 410)
                    subject[0] = "unbound"
                    attempt = client.post(prefix + "/challenge").json()
                    captured.update(attempt)
                    self.assertEqual(client.post(prefix + "/exchange", json={"requestId": attempt["requestId"], "code": "y"*43}).status_code, 403)
                self.assertEqual(mint.await_count, 2)

    def test_install_is_repeatable_and_validates_frontend_before_writing(self):
        root, front = self.root / "backend", self.root / "front"
        (root / "app").mkdir(parents=True)
        front.mkdir()
        main = root / "app/main.py"
        main.write_text('    if settings.auth_upstream:\n            "login": bool(settings.auth_upstream),\n    app.include_router(auth_router)\n')
        initial = main.read_bytes()
        (front / "index.html").write_text("changed upstream")
        with self.assertRaisesRegex(ValueError, "archive hook"):
            install("jingliu", root, front)
        self.assertEqual(main.read_bytes(), initial)
        install("jingliu", root)
        first = main.read_bytes()
        install("jingliu", root)
        self.assertEqual(main.read_bytes(), first)
        self.assertEqual(main.read_text().count("configure_muse_login(app"), 1)


if __name__ == "__main__":
    unittest.main()
