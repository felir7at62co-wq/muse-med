"""Finalized-script library readers: a Workshop account for a company Muse account on its first sign-in.

The shared-host edge offers the Workshop a Muse account that the bindings file does not list only after the account's
own Muse profile showed a Feishu identity of a configured company tenant, and then lets that account reach only the
library and its own profile. The Muse sign-in adapter calls `resolve_or_provision` for such an account. The reader's
Workshop user has `login_id` `muse:<Muse account ID>`, role `user`, no password and no feature flags. Every reader
lists and reads every finalized script; picking needs `script_pick` and uploading a finalized script needs
`script_finalize`, both granted by an administrator in the user's feature flags. The bindings file keeps precedence,
so an administrator can still link a Muse account to an existing Workshop user.
"""
import logging
import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .auth.models import User
from .db import session_scope

log = logging.getLogger(__name__)

LOGIN_PREFIX = "muse:"
FINALIZE_FEATURE = "script_finalize"
# A subject longer than 59 characters would not fit the 64-character login and fallback names.
SUBJECT = re.compile(r"[A-Za-z0-9_-]{1,59}")
# Each failed attempt lost a race for the same login or name to another sign-in, so a new lookup can succeed.
ATTEMPTS = 5


def is_reader(user) -> bool:
    """Whether `user` is a library reader opened on a first Muse sign-in."""
    login_id = getattr(user, "login_id", None)
    return isinstance(login_id, str) and login_id.startswith(LOGIN_PREFIX)


async def _free_username(session, subject: str, username: str | None) -> str:
    base = username or "muse-" + subject[:8]
    for name in dict.fromkeys((base, base[:57] + "-" + subject[:6], "muse-" + subject)):
        if (await session.execute(select(User.id).where(User.username == name))).scalar_one_or_none() is None:
            return name
    raise HTTPException(409, "剧本工坊账号名已被占用，请联系管理员")


async def resolve_or_provision(subject: str, username: str | None, bound_owners: set[int]) -> int:
    """The reader of a company Muse account, opened on its first sign-in.

    `username` is the Muse username already limited to 64 printable characters, or None. A reader whose Workshop
    user the bindings file assigns to another Muse account (`bound_owners`) is refused rather than shared.
    Raises HTTPException 403 for an unusable subject or such a reader, 409 when no account name is free and 503
    when concurrent sign-ins keep taking the same login or name.
    """
    if not isinstance(subject, str) or not SUBJECT.fullmatch(subject):
        raise HTTPException(403, "此 Muse 账号无法开通剧本工坊")
    login_id = LOGIN_PREFIX + subject
    for _attempt in range(ATTEMPTS):
        async with session_scope() as session:
            user = (await session.execute(select(User).where(User.login_id == login_id))).scalar_one_or_none()
            if user is None:
                user = User(login_id=login_id, username=await _free_username(session, subject, username),
                            display_name=username, role="user", status="active", feature_flags={})
                session.add(user)
                try:
                    await session.flush()
                except IntegrityError:
                    await session.rollback()
                    continue
                log.info("[muse-readers] opened library reader %s", user.id)
            owner = user.id
        if owner in bound_owners:
            raise HTTPException(403, "此 Muse 账号的剧本工坊账号已关联给其他 Muse 账号，请联系管理员")
        return owner
    raise HTTPException(503, "剧本工坊账号开通繁忙，请稍后再试")
