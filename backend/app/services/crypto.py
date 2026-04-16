"""
Encryption helpers for connection passwords.

Uses Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256).
The secret key is read from settings.CONNECTIONS_SECRET_KEY.

If no key is configured the service operates in a degraded mode:
passwords cannot be stored or retrieved, and a warning is logged.
"""
from __future__ import annotations

import base64
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

logger = logging.getLogger(__name__)

_fernet: Fernet | None = None


def _get_fernet() -> Fernet | None:
    global _fernet
    if _fernet is not None:
        return _fernet
    key = settings.CONNECTIONS_SECRET_KEY.strip()
    if not key:
        logger.warning(
            "CONNECTIONS_SECRET_KEY is not set — connection passwords cannot be encrypted."
        )
        return None
    try:
        _fernet = Fernet(key.encode())
        return _fernet
    except Exception as exc:
        logger.error("Invalid CONNECTIONS_SECRET_KEY: %s", exc)
        return None


def encrypt_password(plaintext: str) -> str | None:
    """Encrypt a plaintext password.  Returns a base64 Fernet token string."""
    f = _get_fernet()
    if f is None:
        return None
    return f.encrypt(plaintext.encode()).decode()


def decrypt_password(token: str) -> str | None:
    """Decrypt a Fernet token string.  Returns plaintext or None on failure."""
    f = _get_fernet()
    if f is None:
        return None
    try:
        return f.decrypt(token.encode()).decode()
    except InvalidToken:
        logger.error("Failed to decrypt connection password — token is invalid or key has changed.")
        return None
