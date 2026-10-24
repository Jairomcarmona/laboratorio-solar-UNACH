from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(v: str | None, default: bool) -> bool:
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "si", "sí")


# Política de contenido que usan la pasarela (cuando sirve el simulador) y Nginx (deploy/nginx/nginx.conf); una prueba exige que sean idénticas.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
       "connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")


@dataclass
class Settings:
    bank: str = "lab1"
    db_url: str = "sqlite://"
    mqtt: dict = field(default_factory=lambda: {"kind": "memory"})
    allowed_origins: list[str] = field(default_factory=list)       # vacío = solo mismo origen (el Host de la petición)
    cookie_name: str = "labsolar_session"
    cookie_secure: bool = True
    session_ttl_s: int = 8 * 3600
    ticket_ttl_s: int = 30
    client_hb_timeout_s: float = 6.0
    ack_timeout_s: float = 3.0
    cmd_rate_per_s: int = 5
    login_rate_per_min: int = 10
    max_failed_logins: int = 5
    lock_seconds: int = 300
    booking_max_minutes: int = 120
    booking_horizon_days: int = 60
    password_min_len: int = 10
    gateway_hb_period_s: float = 1.0
    admin_user: str | None = None
    admin_password: str | None = None
    csp: str | None = None                                           # si se define, se envía como Content-Security-Policy en todas las respuestas
    static_dir: str | None = None                                    # solo desarrollo/pruebas: en producción lo sirve Nginx

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ
        mqtt = {"kind": "mqtt", "host": e.get("MQTT_HOST", "mosquitto"), "port": int(e.get("MQTT_PORT", "1883")),
                "username": e.get("MQTT_USER"), "password": e.get("MQTT_PASSWORD"), "tls": _bool(e.get("MQTT_TLS"), False), "cafile": e.get("MQTT_CAFILE")}
        origins = [o.strip() for o in e.get("LABSOLAR_ALLOWED_ORIGINS", "").split(",") if o.strip()]
        return cls(bank=e.get("LABSOLAR_BANK", "lab1"), db_url=e.get("LABSOLAR_DB_URL", "sqlite:///labsolar.db"), mqtt=mqtt, allowed_origins=origins,
                   cookie_secure=_bool(e.get("LABSOLAR_COOKIE_SECURE"), True), admin_user=e.get("LABSOLAR_ADMIN_USER"), admin_password=e.get("LABSOLAR_ADMIN_PASSWORD"),
                   session_ttl_s=int(e.get("LABSOLAR_SESSION_TTL_S", 8 * 3600)), static_dir=e.get("LABSOLAR_STATIC_DIR"), csp=CSP if _bool(e.get("LABSOLAR_SEND_CSP"), False) else None)
