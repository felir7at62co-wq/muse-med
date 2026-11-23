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

    def test_jingliu_opens_an_account_for_a_subject_outside_the_bindings_file(self):
        """Jingliu accounts are opened on first sign-in; Workshop admits only the bindings file."""
        opened = []

        class AccountError(Exception):
            def __init__(self, status, code, message):
                super().__init__(message)
                self.status, self.code, self.message = status, code, message

        def resolve_or_provision(subject, username):
            opened.append((subject, username))
            if subject == "broken":
                raise AccountError(503, "bindings_invalid", "Muse 账号绑定文件内容不对")
            return None if subject == "switched-off" else 1000001

        accounts = types.SimpleNamespace(AccountError=AccountError, resolve_or_provision=resolve_or_provision)
        mint = AsyncMock(return_value={"token": "workbench-only", "user": {"id": 1000001}})
        with patch.dict(os.environ, {"MUSE_WORKBENCH_SHARED_HOST": "1"}), \
                patch.dict(sys.modules, {"test_app.muse_accounts": accounts}), \
                patch.object(adapter, "issue_native_session", mint):
            for audience, prefix in (("jingliu", "/v2/auth/muse"), ("script-workshop", "/v1/auth/muse")):
                client = self.client(audience)
                def ask(sub, **extra):
                    return client.post(prefix + "/internal-session", json={"sub": sub, **extra},
                                       headers={"Authorization": "Bearer " + self.priv})
                if audience == "jingliu":
                    self.assertEqual(ask("muse-new", username="林晨").json()["user"]["id"], 1000001)
                    mint.assert_awaited_with("jingliu", 1000001, None)
                    self.assertEqual(ask("switched-off").status_code, 403)
                    broken = ask("broken")
                    self.assertEqual((broken.status_code, broken.json()["detail"]), (503, "Muse 账号绑定文件内容不对"))
                    self.assertEqual(opened, [("muse-new", "林晨"), ("switched-off", None), ("broken", None)])
                    # Only a printable name of at most 64 characters reaches the native account.
                    for odd in ("x" * 65, "林\n晨", " ", "\u200b"):
                        ask("muse-new", username=odd)
                        self.assertIsNone(opened.pop()[1], repr(odd))
                    ask("muse-new", username=" 林 晨 ")
                    self.assertEqual(opened.pop()[1], "林 晨")
                else:
                    self.assertEqual(ask("muse-new", username="林晨").status_code, 403)
                    self.assertEqual(len(opened), 3)            # Workshop never opens an account
                # The bindings file still wins, and a missing subject is refused before anything is opened.
                self.assertEqual(ask("muse-a").status_code, 200)
                mint.assert_awaited_with(audience, 7, None)
                self.assertEqual(ask("").status_code, 403)
                self.assertEqual(len(opened), 3)
        # Without the Jingliu module the adapter admits only file bindings.
        with patch.dict(os.environ, {"MUSE_WORKBENCH_SHARED_HOST": "1"}):
            client = self.client("jingliu")
            refused = client.post("/v2/auth/muse/internal-session", json={"sub": "muse-new"},
                                  headers={"Authorization": "Bearer " + self.priv})
            self.assertEqual(refused.status_code, 403)

    def test_workshop_opens_a_library_reader_only_for_a_company_account_from_the_edge(self):
        """Workshop opens a reader only when the shared-host edge sends `company: true`; the bindings file wins."""
        opened = []

        async def resolve_or_provision(subject, username, bound_owners):
            opened.append((subject, username, bound_owners))
            return 31

        readers = types.SimpleNamespace(resolve_or_provision=resolve_or_provision)
        mint = AsyncMock(return_value={"access_token": "workbench-only", "user": {"id": 31}})
        with patch.dict(os.environ, {"MUSE_WORKBENCH_SHARED_HOST": "1"}), \
                patch.dict(sys.modules, {"test_app.muse_readers": readers}), \
                patch.object(adapter, "issue_native_session", mint):
            client = self.client("script-workshop")

            def ask(secret=self.priv, **body):
                return client.post("/v1/auth/muse/internal-session", json=body, headers={"Authorization": "Bearer " + secret})
            for vouch in (None, False, "true", 1):
                self.assertEqual(ask(sub="muse-new", username="林晨", company=vouch).status_code, 403)
            self.assertEqual(ask(secret="y" * 43, sub="muse-new", company=True).status_code, 403)
            self.assertEqual(opened, [])
            self.assertEqual(ask(sub="muse-new", username=" 林晨 ", company=True).json()["user"]["id"], 31)
            self.assertEqual(opened, [("muse-new", "林晨", {7})])
            mint.assert_awaited_with("script-workshop", 31, None)
            self.assertEqual(ask(sub="muse-new", username="林\n晨", company=True).status_code, 200)
            self.assertIsNone(opened.pop()[1])
            self.assertEqual(ask(sub="muse-a", company=True).status_code, 200)
            mint.assert_awaited_with("script-workshop", 7, None)
            self.assertEqual(len(opened), 1)
        # Without the reader module the Workshop admits only file bindings.
        with patch.dict(os.environ, {"MUSE_WORKBENCH_SHARED_HOST": "1"}):
            refused = self.client("script-workshop").post("/v1/auth/muse/internal-session", json={"sub": "muse-new", "company": True},
                                                          headers={"Authorization": "Bearer " + self.priv})
            self.assertEqual(refused.status_code, 403)

    def test_install_is_repeatable_and_validates_frontend_before_writing(self):
        root, front = self.root / "backend", self.root / "front"
        (root / "app").mkdir(parents=True)
        for relative, rate in [("routers/jianying.py", "DRAFT_FPS"), ("nd/export.py", "J.DRAFT_FPS")]:
            path = root / "app" / relative
            path.parent.mkdir()
            path.write_text(f"script = draft.ScriptFile(w, h, {rate})\n")
        (root / "app/routers/library.py").write_text(
            '@router.get("/library")\ndef list_library(kind=None):\n        access.require_project_access(session, body.project_id)\n'
            '        uid = access.current_user_id()\n')
        front.mkdir()
        (front / "api.js").write_text("upstream changed")
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
