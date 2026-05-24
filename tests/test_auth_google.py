"""
Tests for Google login: verify_google_id_token + POST /api/auth/google.

No real DB or network: SQL-touching helpers and Google verification are
monkeypatched, mirroring the style of tests/mcp_tools.
"""

from __future__ import annotations

import uuid
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database import get_db
from app.routers import auth as auth_router
from app.services import auth_service


# ---------------------------------------------------------------------------
# verify_google_id_token — pure function
# ---------------------------------------------------------------------------

def test_verify_returns_none_when_client_id_blank(monkeypatch):
    monkeypatch.setattr(auth_service.settings, "google_client_id", "")
    assert auth_service.verify_google_id_token("any.jwt") is None


def test_verify_returns_none_when_google_lib_raises(monkeypatch):
    monkeypatch.setattr(auth_service.settings, "google_client_id", "client-x")

    def _raise(*_a, **_kw):
        raise ValueError("bad sig")

    monkeypatch.setattr(auth_service.google_id_token, "verify_oauth2_token", _raise)
    assert auth_service.verify_google_id_token("bad.jwt") is None


def test_verify_returns_none_when_email_not_verified(monkeypatch):
    monkeypatch.setattr(auth_service.settings, "google_client_id", "client-x")
    monkeypatch.setattr(
        auth_service.google_id_token,
        "verify_oauth2_token",
        lambda *_a, **_kw: {"email": "alice@example.com", "email_verified": False},
    )
    assert auth_service.verify_google_id_token("unverified.jwt") is None


def test_verify_returns_payload_on_success(monkeypatch):
    monkeypatch.setattr(auth_service.settings, "google_client_id", "client-x")
    payload = {"email": "alice@example.com", "email_verified": True, "sub": "g-123"}
    monkeypatch.setattr(
        auth_service.google_id_token,
        "verify_oauth2_token",
        lambda *_a, **_kw: payload,
    )
    assert auth_service.verify_google_id_token("good.jwt") == payload


# ---------------------------------------------------------------------------
# POST /api/auth/google — router-level
# ---------------------------------------------------------------------------

def _make_app() -> FastAPI:
    """Build a minimal FastAPI app mounting only the auth router."""
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api")

    async def _fake_db():  # only returned to satisfy the dep; never used
        yield MagicMock()

    app.dependency_overrides[get_db] = _fake_db
    return app


def _fake_employee(email: str = "alice@example.com") -> MagicMock:
    """Build a minimal Employee stand-in with the attributes the route reads."""
    emp = MagicMock()
    emp.id = uuid.uuid4()
    emp.name = "Alice"
    emp.email = email
    emp.role = "employee"
    emp.department_id = uuid.uuid4()
    emp.department = MagicMock(name="DeptObj")
    emp.department.name = "Engineering"
    return emp


def test_google_login_invalid_token_returns_401(monkeypatch):
    monkeypatch.setattr(auth_router, "verify_google_id_token", lambda _t: None)

    app = _make_app()
    with TestClient(app) as client:
        resp = client.post("/api/auth/google", json={"id_token": "x"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid Google token"


def test_google_login_unknown_email_returns_user_does_not_exist(monkeypatch):
    monkeypatch.setattr(
        auth_router,
        "verify_google_id_token",
        lambda _t: {"email": "ghost@example.com", "email_verified": True},
    )

    async def _none(_db, _email):
        return None

    monkeypatch.setattr(auth_router, "get_active_employee_by_email", _none)

    app = _make_app()
    with TestClient(app) as client:
        resp = client.post("/api/auth/google", json={"id_token": "x"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "User does not exist"


def test_google_login_active_employee_returns_token(monkeypatch):
    employee = _fake_employee("alice@example.com")
    monkeypatch.setattr(
        auth_router,
        "verify_google_id_token",
        lambda _t: {"email": "alice@example.com", "email_verified": True},
    )

    async def _found(_db, email):
        assert email == "alice@example.com"
        return employee

    async def _empty_memberships(_db, _eid):
        return []

    monkeypatch.setattr(auth_router, "get_active_employee_by_email", _found)
    monkeypatch.setattr(auth_router, "get_effective_permissions", lambda _e: ["doc:read:own_dept"])
    monkeypatch.setattr(auth_router, "_get_workspace_memberships", _empty_memberships)
    monkeypatch.setattr(auth_router, "create_access_token", lambda **_kw: "fake.jwt.token")

    app = _make_app()
    with TestClient(app) as client:
        resp = client.post("/api/auth/google", json={"id_token": "x"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"] == "fake.jwt.token"
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "alice@example.com"
    assert body["user"]["role"] == "employee"
    assert body["user"]["permissions"] == ["doc:read:own_dept"]
