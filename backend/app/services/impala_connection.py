"""Impala connection URL helpers.

This module intentionally mirrors JDBC URL assembly for now so Impala can be
introduced as a first-class datasource type without changing runtime behavior.
Future Impala-specific auth/session options can be added here without touching
pipeline orchestration.
"""
from __future__ import annotations

import urllib.parse

from app.services.crypto import decrypt_password


def build_sqlalchemy_url(conn) -> str:
    """Build a SQLAlchemy URL for an Impala connection record."""
    extra = conn.extra or {}
    if "url" in extra:
        return str(extra["url"])

    dialect = extra.get("dialect", "impala")
    driver = extra.get("driver", "")
    scheme = f"{dialect}+{driver}" if driver else dialect
    password = decrypt_password(conn.password_encrypted) if conn.password_encrypted else None

    url = f"{scheme}://"
    if conn.username:
        url += conn.username
        if password:
            url += f":{urllib.parse.quote_plus(password)}"
        url += "@"
    if conn.host:
        url += conn.host
        if conn.port:
            url += f":{conn.port}"
    if conn.database:
        url += f"/{conn.database}"
    return url
