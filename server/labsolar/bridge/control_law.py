"""Ley de seguimiento astronómico: misma que js/sim/control.js (astroOrientation). Provisional hasta la especificación O5.

En Tuxtla el Sol pasa al norte de la línea este-oeste del 24 de marzo al 17 de septiembre. Con los finales de carrera
a 90°/270° el azimut del Sol no es alcanzable esos días: se elige el final de carrera del lado del Sol, con histéresis
alrededor del norte, y la inclinación que minimiza el ángulo de incidencia para ESE azimut.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


def ang_diff(a: float, b: float) -> float:
    return ((a - b) % 360 + 540) % 360 - 180


@dataclass
class AstroLaw:
    az_min: float = 90.0
    az_max: float = 270.0
    tilt_min: float = 0.0
    tilt_max: float = 90.0
    north_hyst_deg: float = 2.0
    north_side: float | None = None

    def orientation(self, sun_az: float, sun_el: float, current_az: float) -> tuple[float, float]:
        if self.az_min <= sun_az <= self.az_max:
            t_az = sun_az
            self.north_side = None
        else:
            d = ang_diff(sun_az, 0.0)
            side = self.north_side
            if side is None:
                side = self.az_min if abs(current_az - self.az_min) <= abs(current_az - self.az_max) else self.az_max
            if abs(d) > self.north_hyst_deg:
                side = self.az_min if d >= 0 else self.az_max
            self.north_side = side
            t_az = side
        el = math.radians(sun_el)
        tilt = math.degrees(math.atan2(math.cos(el) * math.cos(math.radians(sun_az - t_az)), math.sin(el)))
        return t_az, max(self.tilt_min, min(self.tilt_max, tilt))
