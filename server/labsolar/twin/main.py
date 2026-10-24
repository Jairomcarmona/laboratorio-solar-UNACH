from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal

from ..bus import bus_from_config
from .app import TwinApp


async def run() -> None:
    bank = os.environ.get("LABSOLAR_BANK", "lab1")
    bus = bus_from_config({"kind": "mqtt", "host": os.environ.get("MQTT_HOST", "mosquitto"), "port": int(os.environ.get("MQTT_PORT", "1883")),
                           "username": os.environ.get("MQTT_USER"), "password": os.environ.get("MQTT_PASSWORD")}, client_id="twin")
    await bus.start()
    app = TwinApp(bus, bank)
    await app.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    await stop.wait()
    await app.stop()
    await bus.close()


def main() -> None:
    argparse.ArgumentParser(description="Gemelo digital del Laboratorio Solar Remoto").parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
