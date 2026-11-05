"""Validated, private configuration for the company media gateway."""

from dataclasses import dataclass, fields
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


class Failure(Exception):
    """A fixed public error, without upstream messages or credentials."""

    def __init__(self, status, code, retry_after=None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def document(path, maximum):
    """Read a bounded JSON document afresh, including atomic replacements."""
    with Path(path).open("rb") as stream:
        body = stream.read(maximum + 1)
    if len(body) > maximum:
        raise ValueError("Configuration document exceeds its limit")
    return json.loads(body)


@dataclass(frozen=True)
class Config:
    """Every deployment-varying limit is supplied by the private JSON file."""

    version: int
    auth_origin: str
    auth_host: str
    auth_public_origin: str
    upstream_origin: str
    upstream_key_file: str
    accounts_file: str
    policy_file: str
    database_file: str
    requests_per_minute: int
    max_requests_per_account: int
    max_downloads_per_day: int
    max_downloads_per_account: int
    max_downloads_global: int
    reservation_ttl_seconds: int
    request_timeout_seconds: int
    auth_timeout_seconds: int
    max_request_bytes: int
    max_response_bytes: int
    max_file_bytes: int
    max_jobs_per_page: int
    sqlite_timeout_seconds: int

    def __post_init__(self):
        if type(self.version) is not int or self.version != 1:
            raise ValueError("Unsupported gateway configuration version")
        for name in ("auth_origin", "upstream_origin"):
            value = urlsplit(getattr(self, name))
            if value.scheme != "http" or value.hostname != "127.0.0.1" or not value.port or value.path or value.query or value.fragment or value.username or value.password:
                raise ValueError("Backend origins must be fixed loopback HTTP origins")
        public = urlsplit(self.auth_public_origin)
        if public.scheme != "https" or public.netloc != self.auth_host or public.path or public.query or public.fragment or public.username or not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", self.auth_host):
            raise ValueError("Invalid company authentication origin")
        for name in ("upstream_key_file", "accounts_file", "policy_file", "database_file"):
            if not isinstance(getattr(self, name), str) or not Path(getattr(self, name)).is_absolute():
                raise ValueError("Private paths must be absolute")
        for name in (field.name for field in fields(self)):
            if name in ("version", "auth_origin", "auth_host", "auth_public_origin", "upstream_origin", "upstream_key_file", "accounts_file", "policy_file", "database_file"):
                continue
            value = getattr(self, name)
            if type(value) is not int or not 1 <= value <= 2**40:
                raise ValueError("Gateway limits must be positive integers")
        if self.auth_timeout_seconds > self.request_timeout_seconds or self.max_downloads_per_account > self.max_downloads_global or self.max_request_bytes > self.max_response_bytes or self.max_jobs_per_page > 1000:
            raise ValueError("Inconsistent gateway limits")

    @classmethod
    def load(cls, path):
        """Reject omitted and unknown fields before opening network clients."""
        value = document(path, 65536)
        if not isinstance(value, dict) or set(value) != {field.name for field in fields(cls)}:
            raise ValueError("Gateway configuration fields do not match version 1")
        return cls(**value)


def policy(path):
    """Load company app/tenant pairs and explicit legacy account grants."""
    value = document(path, 65536)
    if not isinstance(value, dict) or set(value) != {"version", "authorizationMode", "allowedCompanyIdentities", "allowedAccountIds"} or value["version"] != 1 or value["authorizationMode"] != "company-identities":
        raise ValueError("Invalid company authorization policy")
    identities, accounts = value["allowedCompanyIdentities"], value["allowedAccountIds"]
    if not isinstance(identities, list) or not isinstance(accounts, list):
        raise ValueError("Invalid company grants")
    for entry in identities:
        if not isinstance(entry, dict) or set(entry) != {"appId", "tenantKey"} or any(not isinstance(entry[key], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", entry[key]) for key in entry):
            raise ValueError("Invalid company identity grant")
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{16}", value) for value in accounts):
        raise ValueError("Invalid explicit account grant")
    if not identities and not accounts:
        raise ValueError("At least one explicit company grant is required")
    return value


def from_environment():
    """Resolve the explicit configuration path; absence is a startup error."""
    path = os.environ.get("MUSE_MEDIA_CONFIG")
    if not path:
        raise ValueError("MUSE_MEDIA_CONFIG is required")
    return Config.load(path)
