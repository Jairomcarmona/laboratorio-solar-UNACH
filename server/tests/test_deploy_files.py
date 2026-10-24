"""Comprobaciones estáticas de los archivos de despliegue: que no se abra un puerto de más ni se desincronicen las políticas."""
import re
from pathlib import Path

import yaml

from labsolar.gateway.settings import CSP

D = Path(__file__).resolve().parent.parent / "deploy"
compose = yaml.safe_load((D / "docker-compose.yml").read_text())


def test_solo_nginx_publica_puertos():
    pub = {n: s["ports"] for n, s in compose["services"].items() if s.get("ports")}
    assert list(pub) == ["nginx"] and sorted(pub["nginx"]) == ["443:443", "80:80"]


def test_redes_internas_para_datos_y_campo():
    nets = compose["networks"]
    assert nets["core"].get("internal") and nets["field"].get("internal") and nets["cams"].get("internal")
    assert "core" in compose["services"]["db"]["networks"] and "front" not in compose["services"]["db"]["networks"]
    assert "field" in compose["services"]["bridge"]["networks"]
    assert all("field" not in s.get("networks", []) for n, s in compose["services"].items() if n != "bridge")


def test_servicios_python_sin_privilegios():
    for n in ("gateway", "recorder", "twin", "bridge"):
        s = compose["services"][n]
        assert s["read_only"] is True and s["cap_drop"] == ["ALL"] and "no-new-privileges:true" in s["security_opt"]


def test_csp_de_nginx_igual_a_la_de_la_pasarela():
    conf = (D / "nginx" / "nginx.conf").read_text()
    assert re.search(r'Content-Security-Policy "([^"]+)"', conf).group(1) == CSP
    for h in ("Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "limit_req_zone", "auth_request", "ssl_protocols TLSv1.2 TLSv1.3"):
        assert h in conf
    assert "TLSv1.1" not in conf and "server_tokens off" in conf


def test_acl_de_mosquitto_cubre_cada_servicio_y_no_hay_acceso_anonimo():
    acl = (D / "mosquitto" / "acl").read_text()
    users = set(re.findall(r"^user (\w+)", acl, re.M))
    assert {"bridge", "gateway", "recorder", "twin"} <= users
    conf = (D / "mosquitto" / "mosquitto.conf").read_text()
    assert "allow_anonymous false" in conf and "acl_file" in conf and "tlsv1.2" in conf
    # solo el puente publica telemetría y solo la pasarela da órdenes
    blocks = dict(re.findall(r"^user (\w+)\n((?:topic .*\n)+)", acl, re.M))
    can_write = lambda u, t: re.search(rf"topic write labsolar/v1/\+/{re.escape(t)}\b", blocks[u]) is not None    # noqa: E731
    assert [u for u in blocks if can_write(u, "tele")] == ["bridge"] and [u for u in blocks if can_write(u, "cmd/req")] == ["gateway"]


def test_ejemplo_de_entorno_no_trae_secretos_reales_y_env_esta_ignorado():
    env = (D / ".env.example").read_text()
    for line in env.splitlines():
        if re.match(r"(LABSOLAR_DB_PASSWORD|LABSOLAR_ADMIN_PASSWORD)=", line):
            assert "cambia-esto" in line
    assert ".env" in (D.parent.parent / ".gitignore").read_text().split()
    assert not (D / ".env").exists() and not (D / "mosquitto" / "passwd").exists()


def test_dependencias_fijadas():
    lock = (D.parent / "requirements.lock").read_text().splitlines()
    pins = [l for l in lock if l and not l.startswith("#")]
    assert pins and all(re.fullmatch(r"[A-Za-z0-9_.\-]+==[\w.+!\-]+", l) for l in pins)
