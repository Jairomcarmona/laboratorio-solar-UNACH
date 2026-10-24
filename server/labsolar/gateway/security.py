from __future__ import annotations

import collections
import time

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_ph = PasswordHasher()                                      # argon2id con parámetros por defecto de argon2-cffi
_DUMMY = _ph.hash("contraseña-ficticia-para-igualar-tiempos")


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(hash_: str | None, pw: str) -> bool:
    """Tiempo similar exista o no el usuario (evita enumerar cuentas por tiempo de respuesta)."""
    try:
        return _ph.verify(hash_ or _DUMMY, pw) and hash_ is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


class SlidingWindow:
    """Límite de eventos por ventana deslizante, por clave."""

    def __init__(self, limit: int, window_s: float, clock=time.monotonic) -> None:
        self.limit, self.window, self.clock = limit, window_s, clock
        self._d: dict[str, collections.deque] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        q = self._d.setdefault(key, collections.deque())
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True

    def forget(self, key: str) -> None:
        self._d.pop(key, None)
