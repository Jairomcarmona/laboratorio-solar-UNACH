"""Puente (S21): el único proceso que conoce el hardware. Python 3.11+, asyncio.

Ciclo a 1 Hz: leer el PLC y la adquisición, armar tele con seq y ts del reloj del borde y publicarla. Comandos: validar esquema y
rangos (copia de solo lectura de los límites del PLC), aplicar la máquina de estados (nada de seguidor durante un barrido), escribir al PLC,
esperar el eco del registro hasta 2 s y publicar el acuse. El puente NUNCA decide seguridad más allá de rechazar: el PLC es la autoridad.

Cadena de vigilancia: pasarela -> puente (hb/gateway cada 1 s; sin latido 6 s el puente deja de aceptar comandos y le pide al PLC el modo de
pérdida de enlace); puente -> PLC (latido alternado cada 1 s; el PLC entra solo en posición segura si deja de cambiar).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .. import contract
from ..bus import Bus
from . import registers as R
from .daq.base import DaqDriver
from .drivers.base import ControllerDriver, PlcState, Request, Result

log = logging.getLogger("labsolar.bridge")

OPERATE_ROLES = {"student", "teacher", "tech"}
CR_MIN, CR_MAX, CV_MIN, CV_MAX = 0.4, 30.4, 0.05, 1.0


@dataclass
class BridgeConfig:
    bank: str = "lab1"
    tele_period_s: float = 1.0
    hb_period_s: float = 1.0
    gateway_timeout_s: float = 6.0
    ack_timeout_s: float = 2.0
    queue_max: int = 10
    fixed: dict = field(default_factory=lambda: {"az": 180.0, "tilt": 17.0})
    sweep_seconds: float = 10.0
    sweep_point_s: float = 0.14
    load_bank: list[float] | None = None
    daq_timeout_s: float = 0.8
    require_gateway_hb: bool = True


def now_ms() -> int:
    return int(time.time() * 1000)


class BridgeApp:
    def __init__(self, bus: Bus, controller: ControllerDriver, daq: DaqDriver, cfg: BridgeConfig | None = None, clock: Callable[[], int] = now_ms) -> None:
        self.bus, self.ctrl, self.daq = bus, controller, daq
        self.cfg = cfg or BridgeConfig()
        self.clock = clock
        self.seq = 0
        self.wh = {"A": 0.0, "B": 0.0}
        self._last_p = {"A": 0.0, "B": 0.0}
        self._last_tele_t: float | None = None
        self.control_session: str | None = None
        self.control_role: str | None = None
        self.gateway_ok = False
        self.gateway_seen = False
        self._gateway_last = 0.0
        self._link_lost_sent = False
        self.last_state: PlcState | None = None
        self.last_daq: dict | None = None
        self.daq_ok = True
        self.plc_ok = True
        self._published_state: dict | None = None
        self._cmd_q: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._sweep: dict | None = None
        self._sweep_task: asyncio.Task | None = None
        self._prev_state_name: str | None = None
        self.stats = {"tele": 0, "cmd": 0, "ack": 0, "rejected": 0, "daq_fail": 0, "plc_fail": 0}
        self.stopped = False

    # ------------------------------------------------------------------ ciclo de vida
    async def start(self) -> None:
        await self.ctrl.connect()
        await self.daq.connect()
        self._gateway_last = time.monotonic()
        self._sub_cmd = self.bus.subscribe(contract.topic(self.cfg.bank, "cmd/req"))
        self._sub_hb = self.bus.subscribe(contract.topic(self.cfg.bank, "hb/gateway"))
        self._tasks = [asyncio.create_task(self._tele_loop(), name="bridge-tele"),
                       asyncio.create_task(self._hb_loop(), name="bridge-plc-hb"),
                       asyncio.create_task(self._cmd_intake(), name="bridge-cmd-intake"),
                       asyncio.create_task(self._cmd_worker(), name="bridge-cmd-worker"),
                       asyncio.create_task(self._gateway_watch(), name="bridge-gw-watch")]
        await self._publish_state(force=True)

    async def stop(self) -> None:
        self.stopped = True
        for t in self._tasks + ([self._sweep_task] if self._sweep_task else []):
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._sub_cmd.close(); self._sub_hb.close()
        await self.ctrl.close()
        await self.daq.close()

    # ------------------------------------------------------------------ eventos y estado
    async def _event(self, level: str, code: str, msg: str, data: dict | None = None) -> None:
        await self.bus.publish_msg(self.cfg.bank, "event", contract.event(self.clock(), level, "puente", code, msg, data))

    async def _publish_state(self, force: bool = False) -> None:
        st = self.last_state
        s = {"ts": self.clock(), "safety": st.state if st else "FAULT", "appliedMode": st.applied_mode if st else "estop",
             "controlSession": self.control_session, "bridge": "online", "plc": "online" if self.plc_ok else "offline"}
        key = {k: v for k, v in s.items() if k != "ts"}
        if force or key != self._published_state:
            self._published_state = key
            await self.bus.publish_msg(self.cfg.bank, "state", s)

    # ------------------------------------------------------------------ latido hacia el PLC
    async def _hb_loop(self) -> None:
        while True:
            try:
                await self.ctrl.heartbeat()
            except Exception as e:
                log.warning("latido al PLC falló: %s", e)
            await asyncio.sleep(self.cfg.hb_period_s)

    # ------------------------------------------------------------------ vigilancia de la pasarela
    async def _gateway_watch(self) -> None:
        while True:
            now = time.monotonic()
            try:
                while True:
                    self._sub_hb.queue.get_nowait()
                    self._gateway_last = now
                    self.gateway_seen = True
            except asyncio.QueueEmpty:
                pass
            ok = (now - self._gateway_last) < self.cfg.gateway_timeout_s or not self.cfg.require_gateway_hb
            if ok and not self.gateway_ok:
                self.gateway_ok = True
                self._link_lost_sent = False
                await self._event("ok", "gateway.up", "Latido de la pasarela recibido")
            elif not ok and self.gateway_ok:
                self.gateway_ok = False
                await self._event("bad", "gateway.lost", f"Sin latido de la pasarela en {self.cfg.gateway_timeout_s:.0f} s: no se aceptan comandos")
            if not ok and not self._link_lost_sent:
                self._link_lost_sent = True
                if self._sweep:
                    await self._finish_sweep("interrupted", "pérdida de enlace con la pasarela")
                old = self.control_session
                self.control_session = None
                try:
                    r = await self.ctrl.request_link_lost()
                    await self._event("warn", "plc.link_lost", "Se pidió al PLC el modo de pérdida de enlace" + ("" if r.ok else f" (PLC: {r.reason})"))
                except Exception as e:
                    await self._event("bad", "plc.link_lost_fail", f"No se pudo avisar al PLC: {e}")
                if old:
                    await self._event("warn", "session.lost", "Sesión con control retirada por pérdida de enlace", {"sessionId": old})
                await self._publish_state()
            await asyncio.sleep(0.25)

    # ------------------------------------------------------------------ telemetría
    async def _tele_loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_t = loop.time()
        while True:
            try:
                await self._tele_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("ciclo de telemetría")
            next_t += self.cfg.tele_period_s
            delay = next_t - loop.time()
            if delay < -self.cfg.tele_period_s:               # nos atrasamos varios periodos: no acumular ráfagas
                next_t = loop.time()
                delay = 0
            await asyncio.sleep(max(0.0, delay))

    async def _read_plc(self) -> PlcState | None:
        try:
            st = await asyncio.wait_for(self.ctrl.read_state(), self.cfg.daq_timeout_s + 0.5)
            self.plc_ok = True
            self.last_state = st
            return st
        except Exception as e:
            if self.plc_ok:
                await self._event("bad", "plc.offline", f"Sin comunicación con el PLC: {e}")
            self.plc_ok = False
            self.stats["plc_fail"] += 1
            return None

    async def _read_daq(self) -> dict | None:
        try:
            d = await asyncio.wait_for(self.daq.read(), self.cfg.daq_timeout_s)
            if not self.daq_ok:
                await self._event("ok", "daq.online", "Adquisición restablecida")
            self.daq_ok = True
            self.last_daq = d
            return d
        except Exception as e:
            if self.daq_ok:
                await self._event("warn", "daq.stale", f"Sin lectura de la adquisición: {e}")
            self.daq_ok = False
            self.stats["daq_fail"] += 1
            return None

    @staticmethod
    def _num(v: Any) -> float | None:
        return float(v) if isinstance(v, (int, float)) and v == v and abs(v) != float("inf") else None

    def _module(self, m: str, d: dict | None, st: PlcState | None, dt: float) -> tuple[dict, bool]:
        g = (d or {}).get(m, {}) if d else {}
        poa, tb, v, i = (self._num(g.get(k)) for k in ("poa", "tback", "v", "i"))
        p = v * i if v is not None and i is not None else None
        if p is not None and dt > 0:
            self.wh[m] += max(p, 0.0) * dt / 3600.0
        bad = (poa is not None and not -20 <= poa <= 1700) or (tb is not None and not -30 <= tb <= 110) or \
              (v is not None and not -2 <= v <= 80) or (i is not None and not -1 <= i <= 20)
        az = st.az if (m == "B" and st) else (self.cfg.fixed["az"] if m == "A" else None)
        tilt = st.tilt if (m == "B" and st) else (self.cfg.fixed["tilt"] if m == "A" else None)
        return {"poa": poa, "poaTrue": None, "beam": None, "tback": tb, "tcell": None, "v": v, "i": i, "p": p,
                "wh": self.wh[m], "curve": None, "az": az, "tilt": tilt}, bad

    async def _tele_once(self) -> None:
        t0 = time.monotonic()
        st, d = await asyncio.gather(self._read_plc(), self._read_daq())
        st = st or self.last_state
        dt = (t0 - self._last_tele_t) if self._last_tele_t is not None else 0.0
        self._last_tele_t = t0
        quality: list[str] = []
        if d is None or st is None or not self.plc_ok:
            quality.append("stale")
        A, badA = self._module("A", d, st, dt if d else 0.0)
        B, badB = self._module("B", d, st, dt if d else 0.0)
        if badA or badB:
            quality.append("sensor_range")
        env_in = (d or {}).get("env", {}) if d else {}
        wind = st.wind if (st and st.wind is not None) else self._num(env_in.get("wind"))
        env = {"ghi": self._num(env_in.get("ghi")), "dni": None, "dhi": None, "ta": self._num(env_in.get("ta")), "rh": self._num(env_in.get("rh")),
               "wind": wind, "windDir": self._num(env_in.get("windDir")), "rainRate": self._num(env_in.get("rainRate"))}
        sw = self._sweep
        if st is None:
            safety = {"state": "FAULT", "canOperate": False, "blockReason": "Sin comunicación con el PLC.", "estop": False, "windStow": False, "watchdog": False}
            tracker = {"az": None, "tilt": None, "targetAz": None, "targetTilt": None, "appliedMode": "estop"}
            load = {"mode": "oc", "setpoint": None, "sweeping": False, "sweepT": None, "sweepSeconds": self.cfg.sweep_seconds}
        else:
            reason = self._block_reason(st)
            safety = {"state": st.state, "canOperate": not reason, "blockReason": reason, "estop": st.state == "ESTOP",
                      "windStow": st.state == "WIND_STOW", "watchdog": st.state == "COMMS_STOW"}
            tracker = {"az": st.az, "tilt": st.tilt, "targetAz": st.target_az, "targetTilt": st.target_tilt, "appliedMode": st.applied_mode,
                       "lockAz": st.lock_az, "lockTilt": st.lock_tilt, "moving": {"az": st.moving_az, "tilt": st.moving_tilt},
                       "limit": {"az": st.limit_az, "tilt": st.limit_tilt}, "blockCause": "" if st.state == "NORMAL" else st.state}
            load = {"mode": st.load_mode, "setpoint": st.load_setpoint, "sweeping": bool(sw),
                    "sweepT": (time.monotonic() - sw["t0"]) if sw else 0.0, "sweepSeconds": self.cfg.sweep_seconds}
            await self._watch_state_change(st)
        self.seq += 1
        tele = {"ts": self.clock(), "seq": self.seq, "source": self._source(), "quality": quality,
                "env": env, "A": A, "B": B, "tracker": tracker, "safety": safety, "load": load}
        await self.bus.publish_msg(self.cfg.bank, "tele", tele)
        self.stats["tele"] += 1
        await self._publish_state()

    def _source(self) -> str:
        """'real' solo si PLC y adquisición son reales; 'fake' si ambos son virtuales; si no, 'mixed' (puesta en marcha por etapas)."""
        fakes = (self.ctrl.name == "fake", self.daq.name == "fake")
        return "fake" if all(fakes) else "mixed" if any(fakes) else "real"

    def _block_reason(self, st: PlcState) -> str:
        if st.state == "ESTOP":
            return "Paro de emergencia activo: solo el personal en sitio puede restablecerlo."
        if st.state == "FAULT":
            return f"Falla del controlador (código {st.fault_code})."
        if st.state == "COMMS_STOW":
            return "Posición segura por pérdida de enlace: reconoce la falla."
        if st.state == "WIND_STOW":
            return "Posición segura por viento."
        if not self.gateway_ok:
            return "Sin enlace con la pasarela."
        return ""

    async def _watch_state_change(self, st: PlcState) -> None:
        prev, self._prev_state_name = self._prev_state_name, st.state
        if prev is None or prev == st.state:
            return
        msgs = {"WIND_STOW": ("warn", "safety.wind_stow", "El PLC llevó el seguidor a posición segura por viento"),
                "COMMS_STOW": ("bad", "safety.comms_stow", "El PLC entró en posición segura por pérdida de enlace"),
                "ESTOP": ("bad", "safety.estop", "PARO DE EMERGENCIA en el controlador"),
                "FAULT": ("bad", "safety.fault", f"Falla del controlador (código {st.fault_code})"),
                "NORMAL": ("ok", "safety.normal", "El controlador volvió a estado normal")}
        level, code, msg = msgs.get(st.state, ("info", "safety.state", st.state))
        await self._event(level, code, msg, {"from": prev, "to": st.state})
        if self._sweep and st.state != "NORMAL":
            await self._finish_sweep("interrupted", {"WIND_STOW": "posición segura", "ESTOP": "paro de emergencia"}.get(st.state, st.state.lower()))

    # ------------------------------------------------------------------ comandos
    async def _cmd_intake(self) -> None:
        async for _topic, req in self._sub_cmd:
            self.stats["cmd"] += 1
            if not isinstance(req, dict) or "id" not in req:
                continue
            if self._cmd_q.qsize() >= self.cfg.queue_max:
                await self._ack(req, False, "interlock", "Cola de comandos llena: espera y reintenta.")
                continue
            self._cmd_q.put_nowait(req)

    async def _cmd_worker(self) -> None:
        while True:
            req = await self._cmd_q.get()
            try:
                await self._handle(req)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("comando %s", req.get("id"))
                await self._ack(req, False, "internal", f"Error interno del puente: {e}")

    async def _ack(self, req: dict, ok: bool, kind: str | None = None, reason: str | None = None, field: str | None = None) -> None:
        a = contract.ack(str(req.get("id")), self.clock(), ok, kind, reason, field)
        if not ok:
            self.stats["rejected"] += 1
        self.stats["ack"] += 1
        await self.bus.publish_msg(self.cfg.bank, "cmd/ack", a)

    @staticmethod
    def _isnum(v: Any) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")

    def _validate(self, ctype: str, a: dict, st: PlcState | None) -> tuple[str, str] | None:
        """Esquema y rangos contra la copia de solo lectura de los límites del PLC. Devuelve (reason, field) o None."""
        lim = st.limits if st else {"azMin": 90.0, "azMax": 270.0, "tiltMin": 0.0, "tiltMax": 90.0}
        if ctype == "tracker.target":
            az, tilt = a.get("az"), a.get("tilt")
            if az is None and tilt is None:
                return "Indica un azimut, una inclinación o ambos.", "az"
            if az is not None and not self._isnum(az):
                return "El azimut no es un número finito.", "az"
            if tilt is not None and not self._isnum(tilt):
                return "La inclinación no es un número finito.", "tilt"
            if az is not None and not lim["azMin"] <= az <= lim["azMax"]:
                return f"Azimut {az:.0f}° fuera del rango autorizado ({lim['azMin']:.0f}°–{lim['azMax']:.0f}°).", "az"
            if tilt is not None and not lim["tiltMin"] <= tilt <= lim["tiltMax"]:
                return f"Inclinación {tilt:.0f}° fuera del rango autorizado ({lim['tiltMin']:.0f}°–{lim['tiltMax']:.0f}°).", "tilt"
        elif ctype == "tracker.mode":
            if a.get("mode") not in R.TRACKER_MODES:
                return "Modo de seguidor desconocido.", "mode"
        elif ctype == "load.set":
            mode, sp = a.get("mode"), a.get("setpoint")
            if mode not in R.LOAD_MODES:
                return "Modo de carga desconocido.", "mode"
            if sp is not None:
                if not self._isnum(sp):
                    return "La consigna no es un número finito.", "setpoint"
                if mode == "cv" and not CV_MIN <= sp <= CV_MAX:
                    return f"La tensión debe estar entre {CV_MIN * 100:.0f} y {CV_MAX * 100:.0f} % de Voc.", "setpoint"
                if mode == "cr" and not CR_MIN <= sp <= CR_MAX:
                    return f"La resistencia debe estar entre {CR_MIN} y {CR_MAX} Ω.", "setpoint"
                if mode == "cr" and self.cfg.load_bank and not any(abs(r - sp) < 1e-9 for r in self.cfg.load_bank):
                    return f"Con banco de cargas solo se admiten las resistencias disponibles ({', '.join(str(r) for r in self.cfg.load_bank)} Ω).", "setpoint"
        elif ctype == "tracker.locks":
            for k in ("lockAz", "lockTilt"):
                if k in a and not isinstance(a[k], bool):
                    return f"{k} debe ser booleano.", k
        return None

    def _map(self, r: Result) -> tuple[bool, str | None, str | None]:
        if r.ok:
            return True, None, None
        return False, ("timeout" if r.timeout else "interlock"), r.reason

    async def _handle(self, req: dict) -> None:
        ctype, args = req.get("type"), req.get("args") or {}
        if not self.gateway_ok and self.cfg.require_gateway_hb:
            return await self._ack(req, False, "interlock", "Sin enlace con la pasarela: no se aceptan comandos.")
        supported, unsupported = contract.cmd_types()
        if ctype in unsupported:
            return await self._ack(req, False, "unsupported", f"El banco real no admite «{ctype}».")
        errs = contract.errors("req", req)
        if errs:
            return await self._ack(req, False, "validation", "Comando mal formado: " + errs[0][:200])
        st = self.last_state
        # sesión con control (defensa en profundidad: la pasarela ya autorizó)
        if ctype == "session.start":
            if self.control_session and self.control_session != req["sessionId"]:
                return await self._ack(req, False, "interlock", "Ya hay una sesión con el control.")
            self.control_session, self.control_role = req["sessionId"], req["role"]
            await self._publish_state(force=True)
            return await self._ack(req, True)
        if ctype == "session.end":
            if self.control_session != req["sessionId"]:
                return await self._ack(req, False, "interlock", "No hay sesión activa.")
            if self._sweep:
                await self._finish_sweep("interrupted", "sesión terminada")
            self.control_session = self.control_role = None
            await self._publish_state(force=True)
            return await self._ack(req, True)
        if ctype == "safety.estop":                     # cualquier sesión autenticada puede pedir el paro por software
            r = await self.ctrl.request_stop()
            ok, kind, reason = self._map(r)
            return await self._ack(req, ok, kind, reason)
        if self.control_session != req["sessionId"]:
            return await self._ack(req, False, "interlock", "Interlock: no hay sesión activa. Inicia sesión y reserva para operar.")
        if req["role"] not in OPERATE_ROLES:
            return await self._ack(req, False, "interlock", "Tu rol (Visitante) es de solo observación.")
        bad = self._validate(ctype, args, st)
        if bad:
            return await self._ack(req, False, "validation", bad[0], bad[1])
        if ctype in ("acq.start", "acq.stop", "acq.newRun"):
            return await self._ack(req, True)           # el registrador marca los límites de la corrida
        if ctype == "safety.ack":
            r = await self.ctrl.request_ack()
            ok, kind, reason = self._map(r)
            return await self._ack(req, ok, kind, reason or None)
        if self._sweep and ctype in ("tracker.target", "tracker.mode", "tracker.locks", "load.set", "load.sweep"):
            return await self._ack(req, False, "interlock", "Hay un barrido I-V en curso." if ctype != "load.sweep" else "Ya hay un barrido en curso.")
        if ctype == "tracker.target":
            r = await self.ctrl.write_targets(args.get("az"), args.get("tilt"))
        elif ctype == "tracker.mode":
            r = await self.ctrl.set_mode(args["mode"])
        elif ctype == "tracker.locks":
            r = await self.ctrl.set_locks(bool(args.get("lockAz")), bool(args.get("lockTilt")))
        elif ctype == "load.set":
            if st and st.state != "NORMAL":
                return await self._ack(req, False, "interlock", self._block_reason(st) or "Estado no normal.")
            await self.ctrl.set_load(args["mode"], args.get("setpoint"))
            r = Result(True)
        elif ctype == "load.sweep":
            if st and st.state != "NORMAL":
                return await self._ack(req, False, "interlock", self._block_reason(st) or "Estado no normal.")
            await self._start_sweep(req)
            r = Result(True)
        elif ctype == "load.sweep.abort":
            if not self._sweep:
                return await self._ack(req, False, "interlock", "No hay barrido en curso.")
            await self._finish_sweep("interrupted", "interrumpido por el usuario")
            r = Result(True)
        else:
            r = Result(False, 0, f"Comando sin manejador: {ctype}")
        ok, kind, reason = self._map(r)
        await self._ack(req, ok, kind, reason)

    # ------------------------------------------------------------------ barrido I-V (orquestado por el puente)
    async def _start_sweep(self, req: dict) -> None:
        st = self.last_state
        prev = (st.load_mode, st.load_setpoint) if st else ("mppt", 0.82)
        d = self.last_daq or {}
        self._sweep = {"id": "sw_" + uuid.uuid4().hex[:10], "t0": time.monotonic(), "prev": prev, "pts": {"A": [], "B": []},
                       "start": self._cond(d, st), "start_ms": self.clock(), "session": req.get("sessionId"), "bank_done": set()}
        self._sweep_task = asyncio.create_task(self._sweep_loop(), name="bridge-sweep")

    def _cond(self, d: dict, st: PlcState | None) -> dict:
        g = lambda m, k: self._num((d.get(m) or {}).get(k)) if d else None   # noqa: E731
        return {"gA": g("A", "poa"), "gB": g("B", "poa"), "tA": g("A", "tback"), "tB": g("B", "tback"),
                "ta": self._num((d.get("env") or {}).get("ta")) if d else None, "wind": st.wind if st else None,
                "azB": st.az if st else None, "tiltB": st.tilt if st else None}

    async def _sweep_loop(self) -> None:
        sw = self._sweep
        secs = self.cfg.sweep_seconds
        bank = sorted(self.cfg.load_bank, reverse=True) if self.cfg.load_bank else None
        try:
            while True:
                t = time.monotonic() - sw["t0"]
                if t >= secs:
                    break
                if bank:
                    n = len(bank) + 2
                    slot = secs / n
                    k = min(n - 1, int(t / slot))
                    frac = t / slot - k
                    mode, sp = ("oc", None) if k == 0 else ("sc", None) if k == n - 1 else ("cr", bank[k - 1])
                    await self.ctrl.set_load(mode, sp)
                    if frac >= 0.7 and k not in sw["bank_done"]:
                        sw["bank_done"].add(k)
                        await self._sweep_point(sw)
                else:
                    await self.ctrl.set_load("cv", min(max(t / secs, 0.0), 1.0))
                    await self._sweep_point(sw)
                await asyncio.sleep(self.cfg.sweep_point_s)
            await self._finish_sweep("complete", "")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("barrido")
            await self._finish_sweep("interrupted", f"error: {e}")

    async def _sweep_point(self, sw: dict) -> None:
        d = await self._read_daq()
        if not d:
            return
        for m in ("A", "B"):
            v, i, g = (self._num((d.get(m) or {}).get(k)) for k in ("v", "i", "poa"))
            if v is not None and i is not None:
                sw["pts"][m].append({"v": v, "i": i, "p": v * i, "g": g})

    async def _finish_sweep(self, status: str, cause: str) -> None:
        sw, self._sweep = self._sweep, None
        if not sw:
            return
        if self._sweep_task and self._sweep_task is not asyncio.current_task():
            self._sweep_task.cancel()
        self._sweep_task = None
        try:
            await self.ctrl.set_load(*sw["prev"])
        except Exception as e:
            await self._event("warn", "sweep.restore_fail", f"No se pudo restaurar la carga: {e}")
        d = self.last_daq or {}
        rec = {"kind": "labsolar-sweep", "id": sw["id"], "status": status, "cause": cause, "sessionId": sw["session"], "runId": None,
               "startSimMs": sw["start_ms"], "endSimMs": self.clock(), "pts": sw["pts"],
               "cond": {"start": sw["start"], "end": self._cond(d, self.last_state)}}
        await self.bus.publish_msg(self.cfg.bank, "sweep", rec)
        await self._event("ok" if status == "complete" else "warn", "sweep." + status,
                          "Barrido I-V completado" if status == "complete" else f"Barrido I-V interrumpido ({cause})")
