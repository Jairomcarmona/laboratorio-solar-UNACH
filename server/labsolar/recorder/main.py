from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal

from .. import db
from ..bus import bus_from_config
from ..repo import Repo
from .app import RecorderApp


async def run() -> None:
    bank = os.environ.get("LABSOLAR_BANK", "lab1")
    engine = db.make_engine(os.environ["LABSOLAR_DB_URL"])
    if os.environ["LABSOLAR_DB_URL"].startswith("sqlite"):
        db.init_db(engine)                              # con PostgreSQL el esquema lo crea «labsolar-gateway migrate»
    bus = bus_from_config({"kind": "mqtt", "host": os.environ.get("MQTT_HOST", "mosquitto"), "port": int(os.environ.get("MQTT_PORT", "1883")),
                           "username": os.environ.get("MQTT_USER"), "password": os.environ.get("MQTT_PASSWORD")}, client_id="recorder")
    await bus.start()
    rec = RecorderApp(bus, Repo(engine), bank)
    await rec.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    await stop.wait()
    await rec.stop()
    await bus.close()


def main() -> None:
    argparse.ArgumentParser(description="Registrador del Laboratorio Solar Remoto").parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
