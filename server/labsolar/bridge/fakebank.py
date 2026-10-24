"""Banco virtual (S20): emula el PLC y la adquisición con la física de pvlib, con latencia, ruido y fallos.

- FakeBank.step(dt): avanza el banco dt segundos (tiempo real o acelerado). Contiene la lógica que en el banco real vive en el PLC:
  finales de carrera, cinemática de ejes, posición segura por viento, paro, watchdog del latido del puente, interlocks.
- FakeModbusServer: sirve FakeBank por Modbus TCP con el mapa de registros de registers.py (el controlador real se prueba contra él).
- Escenario (YAML/JSON): viento, nubes y eventos guionizados (rachas, paro, ...).

NO es el PLC: es la referencia ejecutable de la especificación provisional. El PLC real aplica sus propios límites.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .. import physics
from . import registers as R
from .control_law import AstroLaw

log = logging.getLogger("labsolar.fakebank")

DEFAULTS: dict[str, Any] = {
    "solar_start": None,            # ISO 8601 (hora UTC) desde la que corre la hora solar virtual; None = reloj real
    "speed": 1.0,                   # factor de la hora solar virtual (el PLC y los motores siguen en tiempo real x speed_plc)
    "limits": {"az_min": 90.0, "az_max": 270.0, "tilt_min": 0.0, "tilt_max": 90.0},
    "rates": {"az": 4.0, "tilt": 3.0},               # deg/s (provisionales)
    "stow": {"az": 180.0, "tilt": 0.0},
    "fixed": {"az": 180.0, "tilt": 17.0},
    "wind": {"stow": 14.0, "resume": 10.0, "stow_delay_s": 1.5, "resume_hold_s": 120.0},
    "hb_timeout_s": 6.0,
    "noise": {"seed": 1, "g": 0.004, "v": 0.0015, "i": 0.0015, "t": 0.1},
    "latency_ms": 0,
    "drop_prob": 0.0,               # probabilidad de que una lectura de adquisición se pierda (TimeoutError)
    "scenario": None,
    "weather": {"ta": 27.0, "rh": 70.0, "cloud": 0.1, "wind": 3.0},
}


def deep_update(base: dict, new: dict | None) -> dict:
    out = json.loads(json.dumps(base))
    for k, v in (new or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_update(out[k], v)
        else:
            out[k] = v
    return out


def load_scenario(src: str | dict | None) -> dict:
    if not src:
        return {"wind": [], "cloud": [], "events": []}
    if isinstance(src, dict):
        return {"wind": src.get("wind", []), "cloud": src.get("cloud", []), "events": src.get("events", [])}
    text = Path(src).read_text(encoding="utf-8")
    if str(src).endswith((".yaml", ".yml")):
        import yaml
        d = yaml.safe_load(text)
    else:
        d = json.loads(text)
    return {"wind": d.get("wind", []), "cloud": d.get("cloud", []), "events": d.get("events", [])}


def interp(series: list, t: float, default: float) -> float:
    """series: [[t, valor], ...] por tramos lineales; fuera de rango se mantiene el extremo."""
    if not series:
        return default
    if t <= series[0][0]:
        return float(series[0][1])
    for (t0, v0), (t1, v1) in zip(series, series[1:]):
        if t <= t1:
            return float(v0 + (v1 - v0) * (t - t0) / max(t1 - t0, 1e-9))
    return float(series[-1][1])


class FakeBank:
    def __init__(self, cfg: dict | None = None, now: Callable[[], float] = time.time) -> None:
        self.cfg = deep_update(DEFAULTS, cfg)
        self._now = now
        lim = self.cfg["limits"]
        self.law = AstroLaw(lim["az_min"], lim["az_max"], lim["tilt_min"], lim["tilt_max"])
        self.rng = np.random.default_rng(self.cfg["noise"]["seed"])
        self.scenario = load_scenario(self.cfg["scenario"])
        self.t = 0.0                                    # segundos transcurridos del banco
        # estado del PLC
        self.az, self.tilt = self.cfg["fixed"]["az"], self.cfg["fixed"]["tilt"]
        self.target_az, self.target_tilt = self.az, self.tilt
        self.v_az = self.v_tilt = 0.0
        self.mode = R.Mode.manual
        self.lock_az = self.lock_tilt = False
        self.estop = False
        self.wind_stow = False
        self.comms_stow = False
        self.fault = 0
        self.hb_value = 0
        self.hb_last_change = 0.0
        self.hb_seen = False
        self.cmd_seq = 0
        self.cmd_seq_echo = 0
        self.reject = R.Reject.NONE
        self.wind_high_t = 0.0
        self.wind_low_t = 0.0
        self.wind = self.cfg["weather"]["wind"]
        self.limit_hit = {"az": 0, "tilt": 0}
        # carga electrónica
        self.load_mode = "mppt"
        self.load_setpoint = 0.82
        self.load_seq = 0
        self.v_track = {"A": 36.0, "B": 36.0}
        # módulos (temperatura de módulo = estado térmico)
        self.t_mod = {"A": None, "B": None}
        self.solar_ms0 = self._solar_origin()
        self._env_cache: tuple[int, dict] | None = None
        self.events_log: list[dict] = []
        self._fired: set[int] = set()
        self.gust = 0.0
        self.gust_until = -1.0

    # ------------------------------------------------------------------ tiempo
    def _solar_origin(self) -> float:
        s = self.cfg["solar_start"]
        if not s:
            return self._now() * 1000.0
        import pandas as pd
        return float(pd.Timestamp(s, tz="UTC").value // 10**6)

    @property
    def solar_ms(self) -> int:
        if not self.cfg["solar_start"]:
            return int(self._now() * 1000)
        return int(self.solar_ms0 + self.t * 1000.0 * self.cfg["speed"])

    def _event(self, code: str, msg: str, level: str = "info") -> None:
        self.events_log.append({"t": self.t, "code": code, "msg": msg, "level": level})

    # ------------------------------------------------------------------ entorno
    def env(self) -> dict:
        ms = self.solar_ms
        key = ms // 1000
        if self._env_cache and self._env_cache[0] == key:
            return self._env_cache[1]
        az, el = physics.solar_position(ms)
        cs = physics.clear_sky(ms) if el > 0 else {"ghi": 0.0, "dni": 0.0, "dhi": 0.0}
        cloud = interp(self.scenario["cloud"], self.t, self.cfg["weather"]["cloud"])
        k_ghi = 1 - 0.75 * cloud ** 3.4
        k_dni = max(0.0, min(1.0, (1 - cloud) ** 1.7))
        ghi, dni = cs["ghi"] * k_ghi, cs["dni"] * k_dni
        dhi = max(ghi - dni * math.sin(math.radians(max(el, 0))), 0.0) if el > 0 else 0.0
        import pandas as pd
        doy = pd.Timestamp(ms, unit="ms", tz="UTC").tz_convert("Etc/GMT+6").dayofyear
        e = {"sun_az": az, "sun_el": el, "ghi": ghi, "dni": dni, "dhi": dhi, "doy": int(doy), "cloud": cloud,
             "ta": self.cfg["weather"]["ta"], "rh": self.cfg["weather"]["rh"]}
        self._env_cache = (key, e)
        return e

    def _poa(self, plane_az: float, plane_tilt: float) -> float:
        e = self.env()
        if e["sun_el"] <= 0:
            return 0.0
        return physics.poa_effective(e["ghi"], e["dni"], e["dhi"], e["sun_az"], e["sun_el"], plane_az, plane_tilt, e["doy"])

    # ------------------------------------------------------------------ lógica del PLC
    @property
    def state(self) -> R.State:
        if self.estop:
            return R.State.ESTOP
        if self.fault:
            return R.State.FAULT
        if self.comms_stow:
            return R.State.COMMS_STOW
        if self.wind_stow:
            return R.State.WIND_STOW
        return R.State.NORMAL

    @property
    def applied_mode(self) -> R.Mode:
        if self.estop:
            return R.Mode.estop
        if self.comms_stow or self.wind_stow:
            return R.Mode.stow
        if self.mode in (R.Mode.astro, R.Mode.sensor) and self.env()["sun_el"] < 2:
            return R.Mode.night
        return self.mode

    def write_hb(self, value: int) -> None:
        if not self.hb_seen or value != self.hb_value:
            self.hb_last_change = self.t
        self.hb_seen = True
        self.hb_value = value

    def submit(self, seq: int, mask: int, req_az: float, req_tilt: float, req_mode: int, locks: int) -> R.Reject:
        """El puente escribe campos y luego HR_CMD_SEQ. El PLC valida y deja el resultado en REJECT_CODE / CMD_SEQ_ECHO."""
        self.cmd_seq = seq
        rej = R.Reject.NONE
        lim = self.cfg["limits"]
        if mask & R.REQ_LINK_LOST:
            self._enter_comms_stow("el puente pidió el modo de pérdida de enlace")
        if mask & R.REQ_STOP:
            self._press_estop("paro por software solicitado")
        if mask & R.REQ_ACK:
            if self.comms_stow and self._hb_alive():
                self.comms_stow = False
                self._event("comms_ack", "Falla de comunicación reconocida", "ok")
            elif self.comms_stow:
                rej = R.Reject.COMMS_STOW
        if mask & (R.REQ_AZ | R.REQ_TILT | R.REQ_MODE | R.REQ_LOCKS):
            if self.estop:
                rej = R.Reject.ESTOP
            elif self.comms_stow:
                rej = R.Reject.COMMS_STOW
            elif self.wind_stow and mask & (R.REQ_AZ | R.REQ_TILT | R.REQ_MODE):
                rej = R.Reject.WIND_STOW
            else:
                if mask & R.REQ_AZ and not (lim["az_min"] <= req_az <= lim["az_max"]):
                    rej = R.Reject.AZ_RANGE
                elif mask & R.REQ_TILT and not (lim["tilt_min"] <= req_tilt <= lim["tilt_max"]):
                    rej = R.Reject.TILT_RANGE
                elif mask & R.REQ_MODE and req_mode not in (0, 1, 2, 3):
                    rej = R.Reject.BAD_VALUE
                if rej == R.Reject.NONE:
                    if mask & R.REQ_LOCKS:
                        self.lock_az, self.lock_tilt = bool(locks & 1), bool(locks & 2)
                    if mask & R.REQ_MODE:
                        self.mode = R.Mode(req_mode)
                        if self.mode == R.Mode.fixed:
                            self.target_az, self.target_tilt = self.az, self.tilt
                    if mask & (R.REQ_AZ | R.REQ_TILT):
                        ignored = (mask & R.REQ_AZ and self.lock_az) and (not mask & R.REQ_TILT or self.lock_tilt) or \
                                  (mask & R.REQ_TILT and self.lock_tilt) and (not mask & R.REQ_AZ or self.lock_az)
                        if ignored:
                            rej = R.Reject.LOCKED_AXIS
                        else:
                            if self.mode != R.Mode.manual:
                                self.mode = R.Mode.manual
                            if mask & R.REQ_AZ and not self.lock_az:
                                self.target_az = req_az
                            if mask & R.REQ_TILT and not self.lock_tilt:
                                self.target_tilt = req_tilt
        self.reject = rej
        self.cmd_seq_echo = seq
        return rej

    def _hb_alive(self) -> bool:
        return self.hb_seen and (self.t - self.hb_last_change) < self.cfg["hb_timeout_s"]

    def _press_estop(self, why: str) -> None:
        if not self.estop:
            self.estop = True
            self.v_az = self.v_tilt = 0.0
            self.load_mode = "oc"
            self._event("estop", f"PARO DE EMERGENCIA ({why}). Motores sin energía, carga desconectada.", "bad")

    def press_estop(self) -> None:
        """Botón físico (consola en el banco virtual)."""
        self._press_estop("botón físico")

    def reset_estop_key(self) -> None:
        """Llave en sitio: NO existe por Modbus ni por el puente."""
        if self.estop:
            self.estop = False
            self.load_mode = "mppt"
            self._event("estop_reset", "Paro restablecido con la llave en sitio", "ok")

    def _enter_comms_stow(self, why: str) -> None:
        if not self.comms_stow:
            self.comms_stow = True
            self._event("comms_stow", f"Pérdida de enlace ({why}): posición segura", "bad")

    def set_load(self, mode_idx: int, setpoint: float) -> None:
        if self.estop:
            return
        self.load_mode = R.LOAD_MODES[mode_idx] if 0 <= mode_idx < len(R.LOAD_MODES) else self.load_mode
        self.load_setpoint = setpoint

    # ------------------------------------------------------------------ paso
    def _fire_events(self) -> None:
        for k, ev in enumerate(self.scenario["events"]):
            if k in self._fired or self.t < ev.get("t", 0):
                continue
            self._fired.add(k)
            what = ev.get("type")
            if what == "estop":
                self.press_estop()
            elif what == "gust":
                self.gust = float(ev.get("peak", 15)); self.gust_until = self.t + float(ev.get("seconds", 5))
            elif what == "fault":
                self.fault = int(ev.get("code", 1)); self._event("fault", f"Falla inyectada {self.fault}", "bad")
            elif what == "clear_fault":
                self.fault = 0

    def step(self, dt: float) -> None:
        self.t += dt
        self._fire_events()
        base_wind = interp(self.scenario["wind"], self.t, self.cfg["weather"]["wind"])
        self.wind = max(0.0, base_wind + (self.gust if self.t < self.gust_until else 0.0))
        w = self.cfg["wind"]
        if not self.wind_stow:
            self.wind_high_t = self.wind_high_t + dt if self.wind >= w["stow"] else 0.0
            if self.wind_high_t >= w["stow_delay_s"] and not self.estop:
                self.wind_stow = True; self.wind_low_t = 0.0
                self._event("wind_stow", f"Viento {self.wind:.1f} m/s ≥ {w['stow']} m/s: posición segura", "warn")
        else:
            self.wind_low_t = self.wind_low_t + dt if self.wind < w["resume"] else 0.0
            if self.wind_low_t >= w["resume_hold_s"]:
                self.wind_stow = False
                self._event("wind_resume", "Viento bajo el umbral: se levanta la posición segura", "ok")
        if self.hb_seen and not self.comms_stow and not self._hb_alive():
            self._enter_comms_stow(f"{self.cfg['hb_timeout_s']:.0f} s sin cambio del latido")
        self._move(dt)
        self._thermal(dt)

    def _targets(self) -> tuple[float, float]:
        stow = self.cfg["stow"]
        if self.estop:
            return self.az, self.tilt
        if self.comms_stow or self.wind_stow:
            return stow["az"], stow["tilt"]
        m = self.mode
        if m in (R.Mode.astro, R.Mode.sensor):
            e = self.env()
            if e["sun_el"] < 2:
                ta, tt = 90.0, 0.0
            else:
                ta, tt = self.law.orientation(e["sun_az"], e["sun_el"], self.az)
            if self.lock_az:
                ta = self.target_az
            if self.lock_tilt:
                tt = self.target_tilt
            return ta, tt
        return self.target_az, self.target_tilt

    def _move(self, dt: float) -> None:
        lim, rate = self.cfg["limits"], self.cfg["rates"]
        ta, tt = self._targets()
        if self.mode in (R.Mode.astro, R.Mode.sensor) or self.comms_stow or self.wind_stow:
            self.target_az, self.target_tilt = ta, tt
        if self.estop:
            self.v_az = self.v_tilt = 0.0
            return
        k = 1.4 if (self.comms_stow or self.wind_stow) else 1.0
        self.az, self.v_az, hit_a = self._axis(self.az, ta, rate["az"] * k, dt, lim["az_min"], lim["az_max"])
        self.tilt, self.v_tilt, hit_t = self._axis(self.tilt, tt, rate["tilt"] * k, dt, lim["tilt_min"], lim["tilt_max"])
        self.limit_hit["az"] = hit_a
        self.limit_hit["tilt"] = hit_t

    @staticmethod
    def _axis(pos: float, target: float, rate: float, dt: float, lo: float, hi: float) -> tuple[float, float, int]:
        t = min(max(target, lo), hi)
        err = t - pos
        step = max(-rate * dt, min(rate * dt, err))
        new = pos + step
        hit = -1 if new <= lo and step <= 0 and pos <= lo else (1 if new >= hi and step >= 0 and pos >= hi else 0)
        return new, step / dt if dt > 0 else 0.0, hit

    def _thermal(self, dt: float) -> None:
        e = self.env()
        for m, (az, tilt) in {"A": (self.cfg["fixed"]["az"], self.cfg["fixed"]["tilt"]), "B": (self.az, self.tilt)}.items():
            g = self._poa(az, tilt)
            if self.t_mod[m] is None:
                tss = e["ta"] + g / (physics.params()["thermal"]["u0"] + physics.params()["thermal"]["u1"] * max(self.wind, 0))
                self.t_mod[m] = tss
            else:
                self.t_mod[m] = physics.module_temp_step(self.t_mod[m], g, e["ta"], self.wind, dt * (self.cfg["speed"] if self.cfg["solar_start"] else 1.0))

    # ------------------------------------------------------------------ adquisición (DAQ)
    def read_daq(self) -> dict:
        n = self.cfg["noise"]
        if self.cfg["drop_prob"] and self.rng.random() < self.cfg["drop_prob"]:
            raise TimeoutError("lectura de adquisición perdida (simulado)")
        e = self.env()
        sens = physics.params()["sensors"]
        out: dict[str, Any] = {}
        for m, (az, tilt) in {"A": (self.cfg["fixed"]["az"], self.cfg["fixed"]["tilt"]), "B": (self.az, self.tilt)}.items():
            g = self._poa(az, tilt)
            t_mod = self.t_mod[m] if self.t_mod[m] is not None else e["ta"]
            t_cell = physics.cell_from_module(t_mod, g)
            s = sens["poa" + m]
            poa_meas = max(0.0, g * (1 + s["epsCal"]) * (1 + s["alpha"] * (t_mod - 25)) * (1 + s["noise"] * self.rng.standard_normal())) if g > 0 else 0.0
            v, i = self._operate(m, g, t_cell)
            out[m] = {"poa": poa_meas, "tback": t_mod + n["t"] * self.rng.standard_normal(),
                      "v": v * (1 + n["v"] * self.rng.standard_normal()), "i": max(0.0, i * (1 + n["i"] * self.rng.standard_normal()))}
        out["env"] = {"ghi": None, "ta": e["ta"] + n["t"] * self.rng.standard_normal(), "rh": e["rh"], "wind": self.wind,
                      "windDir": 150.0, "rainRate": 0.0}
        return out

    def _operate(self, m: str, g: float, t_cell: float) -> tuple[float, float]:
        mp = physics.module_power(g, t_cell)
        mode = "oc" if self.estop else self.load_mode
        if mp["pmp"] <= 0:
            return 0.0, 0.0
        if mode == "oc":
            return mp["voc"], 0.0
        if mode == "sc":
            return 0.0, mp["isc"]
        if mode == "cv":
            v = mp["voc"] * min(max(self.load_setpoint, 0.0), 1.0)
            return v, physics.iv_at_voltage(g, t_cell, v)
        if mode == "cr":
            return physics.current_at_resistance(g, t_cell, max(self.load_setpoint, 0.1))
        # mppt: converge al punto de máxima potencia con perturbar y observar suavizado
        self.v_track[m] += (mp["vmp"] - self.v_track[m]) * 0.5
        v = self.v_track[m]
        return v, physics.iv_at_voltage(g, t_cell, v)

    # ------------------------------------------------------------------ registros
    def input_registers(self) -> list[int]:
        lim = self.cfg["limits"]
        ir = [0] * R.IR_COUNT
        flags = R.pack_flags(moving_az=abs(self.v_az) > 0.05, moving_tilt=abs(self.v_tilt) > 0.05, lock_az=self.lock_az, lock_tilt=self.lock_tilt,
                             limit_az_min=self.limit_hit["az"] < 0, limit_az_max=self.limit_hit["az"] > 0,
                             limit_tilt_min=self.limit_hit["tilt"] < 0, limit_tilt_max=self.limit_hit["tilt"] > 0,
                             estop=self.estop, wind_stow=self.wind_stow, comms_stow=self.comms_stow)
        ir[R.IR_HB_ECHO] = self.hb_value & 0xFFFF
        ir[R.IR_STATE] = int(self.state)
        ir[R.IR_APPLIED_MODE] = int(self.applied_mode)
        ir[R.IR_AZ] = R.to_raw(self.az)
        ir[R.IR_TILT] = R.to_raw(self.tilt)
        ir[R.IR_TARGET_AZ] = R.to_raw(self.target_az)
        ir[R.IR_TARGET_TILT] = R.to_raw(self.target_tilt)
        ir[R.IR_FLAGS] = flags
        ir[R.IR_FAULT_CODE] = self.fault
        ir[R.IR_WIND] = R.to_raw(self.wind)
        ir[R.IR_CMD_SEQ_ECHO] = self.cmd_seq_echo & 0xFFFF
        ir[R.IR_AZ_MIN], ir[R.IR_AZ_MAX] = R.to_raw(lim["az_min"]), R.to_raw(lim["az_max"])
        ir[R.IR_TILT_MIN], ir[R.IR_TILT_MAX] = R.to_raw(lim["tilt_min"]), R.to_raw(lim["tilt_max"])
        ir[R.IR_REJECT_CODE] = int(self.reject)
        ir[R.IR_LOAD_MODE] = R.LOAD_MODES.index(self.load_mode)
        ir[R.IR_LOAD_SETPOINT] = int(round(self.load_setpoint * 1000)) & 0xFFFF
        return ir

    def on_holding_write(self, hr: list[int]) -> None:
        """Se llama con el bloque de registros de retención completo después de una escritura del puente."""
        self.write_hb(hr[R.HR_HB])
        if hr[R.HR_LOAD_SEQ] != self.load_seq:
            self.load_seq = hr[R.HR_LOAD_SEQ]
            self.set_load(hr[R.HR_LOAD_MODE], hr[R.HR_LOAD_SETPOINT] / 1000.0)
        if hr[R.HR_CMD_SEQ] != self.cmd_seq and hr[R.HR_CMD_SEQ] != 0:
            self.submit(hr[R.HR_CMD_SEQ], hr[R.HR_REQ_MASK], R.from_raw(hr[R.HR_REQ_AZ]), R.from_raw(hr[R.HR_REQ_TILT]),
                        hr[R.HR_REQ_MODE], hr[R.HR_REQ_LOCKS])


async def run_bank(bank: FakeBank, tick_hz: float = 20.0, speed: float = 1.0, on_tick: Callable[[], Any] | None = None) -> None:
    """Hace avanzar el banco en tiempo real (x speed). Se usa solo; con el servidor Modbus/OPC UA o con el controlador fake."""
    last = time.monotonic()
    while True:
        await asyncio.sleep(1.0 / tick_hz)
        now = time.monotonic()
        bank.step((now - last) * speed)
        last = now
        if on_tick:
            res = on_tick()
            if asyncio.iscoroutine(res):
                await res


class FakeModbusServer:
    """Sirve FakeBank por Modbus TCP (pymodbus >= 3.11, SimDevice). Un lazo de pasos a 'tick_hz' corre en el mismo bucle asyncio.

    Cada lectura de registros de entrada devuelve el estado actual del banco; cada escritura de registros de retención
    pasa por la lógica del PLC (FakeBank.on_holding_write), que valida y deja el resultado en REJECT_CODE / CMD_SEQ_ECHO.
    """

    def __init__(self, bank: FakeBank, host: str = "127.0.0.1", port: int = 5020, tick_hz: float = 20.0, speed: float = 1.0) -> None:
        self.bank, self.host, self.port, self.tick_hz, self.speed = bank, host, port, tick_hz, speed
        self._server = None
        self._task: asyncio.Task | None = None
        self._tick_task: asyncio.Task | None = None
        self._hr = [0] * R.HR_COUNT
        self.requests = 0

    async def _action(self, function_code, start_address, address, count, current_registers, set_values):
        self.requests += 1
        if function_code == 4:                                   # registros de entrada: estado vivo del PLC
            ir = self.bank.input_registers()
            for k in range(len(current_registers)):
                a = start_address + k
                current_registers[k] = ir[a] if 0 <= a < len(ir) else 0
        elif function_code == 3:                                 # lectura de registros de retención
            for k in range(len(current_registers)):
                a = start_address + k
                current_registers[k] = self._hr[a] if 0 <= a < len(self._hr) else 0
        elif function_code in (6, 16) and set_values is not None:
            for k, v in enumerate(set_values):
                a = address + k
                if 0 <= a < len(self._hr):
                    self._hr[a] = int(v) & 0xFFFF
            self.bank.on_holding_write(self._hr)
            for k in range(len(current_registers)):
                a = start_address + k
                current_registers[k] = self._hr[a] if 0 <= a < len(self._hr) else 0
        return None

    async def start(self) -> None:
        from pymodbus.server import ModbusTcpServer
        from pymodbus.simulator import DataType, SimData, SimDevice

        dev = SimDevice(
            R.UNIT,
            simdata=([SimData(0, count=1, datatype=DataType.BITS)], [SimData(0, count=1, datatype=DataType.BITS)],
                     [SimData(0, count=R.HR_COUNT, values=0, datatype=DataType.REGISTERS)],
                     [SimData(0, count=R.IR_COUNT, values=0, datatype=DataType.REGISTERS)]),
            action=self._action)
        self._server = ModbusTcpServer(dev, address=(self.host, self.port))
        self._task = asyncio.create_task(self._server.serve_forever(), name="fake-modbus")
        self._tick_task = asyncio.create_task(self._ticker(), name="fake-bank-tick")
        await asyncio.sleep(0.1)

    async def _ticker(self) -> None:
        await run_bank(self.bank, self.tick_hz, self.speed)

    async def stop(self) -> None:
        for t in (self._tick_task, self._task):
            if t:
                t.cancel()
        if self._server:
            await self._server.shutdown()


class FakeOpcUaServer:
    """Servidor OPC UA (asyncua) que expone los mismos registros como variables en unidades de ingeniería (ver drivers/opcua.py)."""

    def __init__(self, bank: FakeBank, endpoint: str = "opc.tcp://127.0.0.1:4840/labsolar", tick_hz: float = 20.0, speed: float = 1.0, namespace_uri: str = "urn:labsolar:fakebank") -> None:
        from .drivers.opcua import default_nodes
        self.bank, self.endpoint, self.tick_hz, self.speed, self.uri = bank, endpoint, tick_hz, speed, namespace_uri
        self.ir_nodes, self.hr_nodes = default_nodes(2)
        self._server = None
        self._ir: dict[int, Any] = {}
        self._hr: dict[int, Any] = {}
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        from asyncua import Server, ua
        srv = Server()
        await srv.init()
        srv.set_endpoint(self.endpoint)
        idx = await srv.register_namespace(self.uri)
        assert idx == 2, f"el espacio de nombres debe ser 2 (es {idx})"
        obj = await srv.nodes.objects.add_object(idx, "Lab")
        for i, spec in self.ir_nodes.items():
            name = spec["node"].split("Lab.", 1)[1]
            var = await obj.add_variable(ua.NodeId(f"Lab.{name}", idx), name, 0.0, ua.VariantType.Double)
            self._ir[i] = var
        for i, spec in self.hr_nodes.items():
            name = spec["node"].split("Lab.", 1)[1]
            var = await obj.add_variable(ua.NodeId(f"Lab.{name}", idx), name, 0.0, ua.VariantType.Double)
            await var.set_writable()
            self._hr[i] = var
        await srv.start()
        self._server = srv
        self._hr_vals = [0] * R.HR_COUNT
        await self._publish_ir()
        self._tasks = [asyncio.create_task(run_bank(self.bank, self.tick_hz, self.speed, self._publish_ir), name="fake-opcua-bank"),
                       asyncio.create_task(self._poll_hr(), name="fake-opcua-hr")]

    async def _publish_ir(self) -> None:
        from asyncua import ua
        ir = self.bank.input_registers()
        for i, var in self._ir.items():
            await var.write_value(ua.DataValue(ua.Variant(float(ir[i]) * self.ir_nodes[i]["scale"], ua.VariantType.Double)))

    async def _poll_hr(self) -> None:
        while True:
            await asyncio.sleep(0.02)
            vals = list(self._hr_vals)
            for i, var in self._hr.items():
                raw = await var.read_value()
                vals[i] = int(round(float(raw) / self.hr_nodes[i]["scale"])) & 0xFFFF
            if vals != self._hr_vals:
                self._hr_vals = vals
                self.bank.on_holding_write(vals)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        if self._server:
            await self._server.stop()


def main() -> None:                                         # pragma: no cover
    import argparse
    import yaml
    ap = argparse.ArgumentParser(description="Banco virtual: PLC Modbus TCP simulado")
    ap.add_argument("--config", help="YAML del banco virtual")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5020)
    a = ap.parse_args()
    cfg = yaml.safe_load(Path(a.config).read_text()) if a.config else {}

    async def run() -> None:
        srv = FakeModbusServer(FakeBank(cfg), a.host, a.port)
        await srv.start()
        log.info("Banco virtual en %s:%d", a.host, a.port)
        await asyncio.Event().wait()
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())


if __name__ == "__main__":
    main()
