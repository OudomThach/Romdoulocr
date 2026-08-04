from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from ..db import get_session
from ..models import User
from ..security import Actor, create_session, hash_password, require_auth, revoke_token, verify_password
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


class CreateUserIn(BaseModel):
    username: str
    password: str
    role: str = "viewer"


class UserOut(BaseModel):
    id: int
    username: str
    role: str


@router.post("/login")
async def login(payload: LoginIn, session: AsyncSession = Depends(get_session)) -> dict:
    row = await session.execute(select(User).where(User.username == payload.username))
    user = row.scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = await create_session(session, user)
    return {"token": token, "user": {"username": user.username, "role": user.role}}


@router.post("/logout", response_model=None)
async def logout(
    actor: Actor = Depends(require_auth),
    x_session_token: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> dict:
    if actor.kind == "user" and x_session_token:
        await revoke_token(session, x_session_token)
    return {"ok": True}


@router.get("/me", response_model=UserOut)
async def me(actor: Actor = Depends(require_auth)) -> UserOut:
    if actor.kind == "key":
        return UserOut(username=f"key:{actor.name}", role="admin")
    return UserOut(id=0, username=actor.name, role=actor.role)


@router.post("/users", status_code=201, response_model=UserOut)
async def create_user(
    payload: CreateUserIn,
    actor: Actor = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    _require_admin(actor)
    if payload.role not in ("admin", "viewer"):
        raise HTTPException(status_code=422, detail="role must be admin or viewer")
    if not payload.username.strip() or len(payload.password) < 8:
        raise HTTPException(status_code=422, detail="username required, password at least 8 chars")
    exists = await session.execute(select(User).where(User.username == payload.username.strip()))
    if exists.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="username already exists")
    user = User(
        username=payload.username.strip(),
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    session.add(user)
    await session.commit()
    return UserOut(id=user.id, username=user.username, role=user.role)


def _require_admin(actor: Actor) -> None:
    if actor.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")


@router.get("/users", response_model=list[UserOut])
async def list_users(
    actor: Actor = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[UserOut]:
    _require_admin(actor)
    rows = await session.execute(select(User).order_by(User.username))
    return [UserOut(id=u.id, username=u.username, role=u.role) for u in rows.scalars()]


class UpdateUserIn(BaseModel):
    role: str | None = None


@router.patch("/users/{user_id:int}", response_model=UserOut)
async def update_user(
    user_id: int,
    payload: UpdateUserIn,
    actor: Actor = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    _require_admin(actor)
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if payload.role is not None:
        if payload.role not in ("admin", "viewer"):
            raise HTTPException(status_code=422, detail="role must be admin or viewer")
        user.role = payload.role
        await session.commit()
    return UserOut(id=user.id, username=user.username, role=user.role)


@router.delete("/users/{user_id:int}", response_model=None, status_code=204)
async def delete_user(
    user_id: int,
    actor: Actor = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    _require_admin(actor)
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if user.username == actor.name:
        raise HTTPException(status_code=422, detail="cannot delete yourself")
    await session.delete(user)
    await session.commit()
