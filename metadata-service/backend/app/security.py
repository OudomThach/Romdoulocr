import base64
import datetime as dt
import hashlib
import hmac
import logging
import secrets

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import authorized_keys, settings
from .db import SessionLocal, get_session
from .models import Session, User

log = logging.getLogger("metadata.auth")

PBKDF2_ITERATIONS = 200_000
SESSION_TTL = dt.timedelta(days=30)


# --------------------------------------------------------------------------- #
# Passwords (stdlib pbkdf2 — no extra deps)
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_b64, dk_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return hmac.compare_digest(dk, expected)


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #
def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_session(session: AsyncSession, user: User) -> str:
    token = new_session_token()
    session.add(
        Session(
            token_hash=token_hash(token),
            user_id=user.id,
            expires_at=dt.datetime.now(dt.timezone.utc) + SESSION_TTL,
        )
    )
    await session.commit()
    return token


async def user_by_token(session: AsyncSession, token: str) -> User | None:
    row = await session.execute(
        select(User)
        .join(Session, Session.user_id == User.id)
        .where(Session.token_hash == token_hash(token), Session.expires_at > dt.datetime.now(dt.timezone.utc))
    )
    return row.scalar_one_or_none()


async def revoke_token(session: AsyncSession, token: str) -> None:
    row = await session.execute(select(Session).where(Session.token_hash == token_hash(token)))
    sess = row.scalar_one_or_none()
    if sess:
        await session.delete(sess)
        await session.commit()


# --------------------------------------------------------------------------- #
# Actor model — who is making the call
# --------------------------------------------------------------------------- #
class Actor:
    def __init__(self, kind: str, name: str, role: str) -> None:
        self.kind = kind  # "user" | "key" | "system"
        self.name = name
        self.role = role

    def label(self) -> str:
        return f"{self.kind}:{self.name}"


async def require_auth(
    x_api_key: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> Actor:
    keys = authorized_keys()
    if x_api_key and x_api_key in keys:
        return Actor("key", x_api_key, "admin")
    if x_session_token:
        user = await user_by_token(session, x_session_token)
        if user:
            return Actor("user", user.username, user.role)
    raise HTTPException(status_code=401, detail="Invalid or missing credentials")


# --------------------------------------------------------------------------- #
# Bootstrap: ensure the admin user exists on startup
# --------------------------------------------------------------------------- #
async def seed_admin() -> None:
    async with SessionLocal() as session:
        exists = await session.execute(select(User).where(User.username == settings.admin_username))
        if exists.scalar_one_or_none():
            return
        session.add(
            User(
                username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                role="admin",
            )
        )
        await session.commit()
        log.warning("Seeded admin user '%s' with password from METADATA_ADMIN_PASSWORD", settings.admin_username)
