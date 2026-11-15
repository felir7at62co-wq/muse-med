"""SQLite ownership, idempotency and durable download reservations."""

import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid

from configuration import Failure

SCHEMA_VERSION = 2


class Ledger:
    """One process owns the database; reservations use SQLite transactions."""

    def __init__(self, config, clock=time.time):
        self.config, self.clock = config, clock
        target = Path(config.database_file)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(target, timeout=config.sqlite_timeout_seconds, isolation_level=None)
        target.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, SCHEMA_VERSION):
            self.db.close()
            raise ValueError("Unsupported media ledger generation")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT,
            tool TEXT NOT NULL, argument_hash TEXT NOT NULL, state TEXT NOT NULL,
            upstream_task TEXT, upstream_download TEXT, result TEXT NOT NULL,
            files TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
            reserved_until REAL NOT NULL, UNIQUE(account_id, request_id))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS media_receipts (
            token TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL,
            created_at REAL NOT NULL, lease_until REAL NOT NULL, imported_at REAL)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS media_receipts_job ON media_receipts(job_id,name,sha256)")
        self.db.execute("""CREATE TABLE IF NOT EXISTS media_audits (
            id INTEGER PRIMARY KEY, created_at REAL NOT NULL, kind TEXT NOT NULL,
            policy_hash TEXT, code_hash TEXT NOT NULL, payload TEXT NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS media_deletions (
            resource TEXT PRIMARY KEY, download_id TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL)""")
        self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        # A process loss cannot prove whether a submission reached the upstream.
        self.db.execute("UPDATE jobs SET state='unconfirmed',result=? WHERE state='submitting'", ('{"code":"process_interrupted"}',))

    def close(self):
        self.db.close()

    def expire_reservations(self):
        """Release expired observations without asserting upstream task failure."""
        self.db.execute("UPDATE jobs SET state='unconfirmed',updated_at=? WHERE state='pending' AND reserved_until<=?", (self.clock(), self.clock()))

    def owned(self, account, job_id):
        self.expire_reservations()
        row = self.db.execute("SELECT * FROM jobs WHERE account_id=? AND job_id=?", (account, job_id)).fetchone()
        if row is None:
            raise Failure(404, "job_not_found")
        return dict(row)

    def create(self, account, tool, arguments):
        """Reserve once before network I/O; repeated download keys never resubmit."""
        now = self.clock()
        self.expire_reservations()
        request_id = arguments.get("request_id") if tool == "download_media" else None
        digest = hashlib.sha256(json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if request_id is not None:
                old = self.db.execute("SELECT * FROM jobs WHERE account_id=? AND request_id=?", (account, request_id)).fetchone()
                if old:
                    if old["argument_hash"] != digest:
                        raise Failure(409, "request_id_conflict")
                    self.db.execute("COMMIT")
                    return dict(old), False
                day = int(now // 86400) * 86400
                used = self.db.execute("SELECT count(*) FROM jobs WHERE account_id=? AND tool='download_media' AND created_at>=?", (account, day)).fetchone()[0]
                if used >= self.config.max_downloads_per_day:
                    raise Failure(429, "daily_download_limit", max(1, int(day + 86400 - now)))
                predicate = "tool='download_media' AND (state IN ('pending','submitting') OR (state='unconfirmed' AND reserved_until>?))"
                total = self.db.execute("SELECT count(*) FROM jobs WHERE " + predicate, (now,)).fetchone()[0]
                own = self.db.execute("SELECT count(*) FROM jobs WHERE account_id=? AND " + predicate, (account, now)).fetchone()[0]
                if total >= self.config.max_downloads_global or own >= self.config.max_downloads_per_account:
                    raise Failure(429, "download_concurrency_limit", 5)
            job_id = str(uuid.uuid4())
            self.db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (job_id, account, request_id, tool, digest, "submitting", None, None, "{}", "[]", now, now, now + self.config.reservation_ttl_seconds))
            self.db.execute("COMMIT")
            return self.owned(account, job_id), True
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def update(self, row, state, *, task=None, download=None, result=None, files=None):
        reserved_until = self.clock() + self.config.reservation_ttl_seconds if state == "pending" else row["reserved_until"]
        self.db.execute("UPDATE jobs SET state=?,upstream_task=?,upstream_download=?,result=?,files=?,updated_at=?,reserved_until=? WHERE job_id=? AND account_id=?", (state, task or row["upstream_task"], download or row["upstream_download"], json.dumps(result if result is not None else json.loads(row["result"]), ensure_ascii=False), json.dumps(files if files is not None else json.loads(row["files"])), self.clock(), reserved_until, row["job_id"], row["account_id"]))
        return self.owned(row["account_id"], row["job_id"])

    def public(self, row, summary=False):
        """Return company IDs and verified file facts, never upstream identifiers."""
        value = {"job_id": row["job_id"], "state": "pending" if row["state"] == "submitting" else row["state"], "tool": row["tool"], "created_at": row["created_at"], "updated_at": row["updated_at"], "files": json.loads(row["files"]), "automatic_resubmit": False}
        if row["request_id"] is not None:
            value["request_id"] = row["request_id"]
        if row["state"] == "unconfirmed":
            value["reservation_active"] = row["reserved_until"] > self.clock()
            value["next_action"] = "query_original" if row["upstream_task"] or row["upstream_download"] else "inspect_receipt"
        if not summary:
            value.update(json.loads(row["result"]))
        return value

    def list(self, account, offset):
        self.expire_reservations()
        rows = self.db.execute("SELECT * FROM jobs WHERE account_id=? ORDER BY created_at DESC,job_id LIMIT ? OFFSET ?", (account, self.config.max_jobs_per_page + 1, offset)).fetchall()
        more = len(rows) > self.config.max_jobs_per_page
        return {"jobs": [self.public(dict(row), True) for row in rows[:self.config.max_jobs_per_page]], "next_offset": offset + self.config.max_jobs_per_page if more else None}
