"""Bus de mensajes interno. MqttBus (Mosquitto) en producción; MemoryBus en pruebas y desarrollo sin broker.

Misma interfaz para los dos: publish(topic, payload, qos, retain) y subscribe(*patrones) -> Subscription asíncrona.
Los patrones usan los comodines de MQTT (+ un nivel, # el resto).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any, AsyncIterator

from . import contract

log = logging.getLogger("labsolar.bus")


def topic_matches(pattern: str, topic: str) -> bool:
    p, t = pattern.split("/"), topic.split("/")
    for i, seg in enumerate(p):
        if seg == "#":
            return True
        if i >= len(t):
            return False
        if seg != "+" and seg != t[i]:
            return False
    return len(p) == len(t)


class Subscription:
    def __init__(self, bus: "Bus", patterns: tuple[str, ...], maxsize: int = 1000):
        self.bus = bus
        self.patterns = patterns
        self.queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0

    def _offer(self, topic: str, payload: Any) -> None:
        if any(topic_matches(p, topic) for p in self.patterns):
            try:
                self.queue.put_nowait((topic, payload))
            except asyncio.QueueFull:          # un consumidor lento no detiene al resto: se descarta lo más viejo
                with contextlib.suppress(asyncio.QueueEmpty):
                    self.queue.get_nowait()
                self.dropped += 1
                self.queue.put_nowait((topic, payload))

    def __aiter__(self) -> AsyncIterator[tuple[str, Any]]:
        return self._iter()

    async def _iter(self):
        while True:
            yield await self.queue.get()

    async def get(self, timeout: float | None = None) -> tuple[str, Any]:
        return await asyncio.wait_for(self.queue.get(), timeout)

    def close(self) -> None:
        self.bus._unsubscribe(self)


class Bus:
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    async def publish(self, topic: str, payload: Any, qos: int = 0, retain: bool = False) -> None: ...
    def subscribe(self, *patterns: str) -> Subscription: ...
    def _unsubscribe(self, sub: Subscription) -> None: ...

    async def publish_msg(self, bank: str, name: str, payload: Any, validate: bool = True) -> None:
        """Publica en un tópico del contrato con su QoS y retención, validando el esquema (sale solo lo que cumple el contrato)."""
        if validate:
            contract.validate(contract.TOPIC_SCHEMA[name], payload)
        spec = contract.TOPICS[name]
        await self.publish(contract.topic(bank, name), payload, qos=spec["qos"], retain=spec["retain"])


class MemoryBus(Bus):
    def __init__(self) -> None:
        self._subs: list[Subscription] = []
        self.retained: dict[str, Any] = {}
        self.log: list[tuple[str, Any]] = []           # para inspección en pruebas
        self.keep_log = False

    async def start(self) -> None: ...
    async def close(self) -> None: ...

    async def publish(self, topic: str, payload: Any, qos: int = 0, retain: bool = False) -> None:
        # pasa por JSON para que los dos buses se comporten igual (sin objetos no serializables, sin NaN)
        payload = contract.loads(contract.dumps(payload)) if not isinstance(payload, (str, bytes)) else payload
        if retain:
            self.retained[topic] = payload
        if self.keep_log:
            self.log.append((topic, payload))
        for s in list(self._subs):
            s._offer(topic, payload)

    def subscribe(self, *patterns: str) -> Subscription:
        s = Subscription(self, patterns)
        self._subs.append(s)
        for t, p in list(self.retained.items()):
            s._offer(t, p)
        return s

    def _unsubscribe(self, sub: Subscription) -> None:
        with contextlib.suppress(ValueError):
            self._subs.remove(sub)


class MqttBus(Bus):
    """Cliente MQTT (aiomqtt) con reconexión, TLS, usuario propio y testamento (last will) opcional."""

    def __init__(self, host: str, port: int = 1883, username: str | None = None, password: str | None = None, tls: bool = False,
                 cafile: str | None = None, client_id: str | None = None, will: tuple[str, Any, int, bool] | None = None,
                 keepalive: int = 20) -> None:
        self.host, self.port, self.username, self.password = host, port, username, password
        self.tls, self.cafile, self.client_id, self.will, self.keepalive = tls, cafile, client_id, will, keepalive
        self._subs: list[Subscription] = []
        self._patterns: dict[str, int] = {}
        self._client = None
        self._task: asyncio.Task | None = None
        self._connected = asyncio.Event()
        self._closing = False

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="mqtt-bus")
        await asyncio.wait_for(self._connected.wait(), 15)

    async def close(self) -> None:
        self._closing = True
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    def _tls_params(self):
        import aiomqtt
        if not self.tls:
            return None
        return aiomqtt.TLSParameters(ca_certs=self.cafile)

    async def _run(self) -> None:
        import aiomqtt
        delay = 1.0
        while not self._closing:
            try:
                will = None
                if self.will:
                    t, p, q, r = self.will
                    will = aiomqtt.Will(t, contract.dumps(p), qos=q, retain=r)
                async with aiomqtt.Client(self.host, self.port, username=self.username, password=self.password, identifier=self.client_id,
                                          keepalive=self.keepalive, tls_params=self._tls_params(), will=will) as client:
                    self._client = client
                    for pat in list(self._patterns):
                        await client.subscribe(pat, qos=1)
                    self._connected.set()
                    delay = 1.0
                    async for msg in client.messages:
                        topic = str(msg.topic)
                        try:
                            raw = msg.payload.decode("utf-8") if isinstance(msg.payload, (bytes, bytearray)) else str(msg.payload)
                            payload = contract.loads(raw) if raw else None
                        except Exception as e:                       # carga inválida: se descarta y se registra, nunca se propaga
                            log.warning("mensaje inválido en %s: %s", topic, e)
                            continue
                        for s in list(self._subs):
                            s._offer(topic, payload)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._client = None
                self._connected.clear()
                log.warning("MQTT desconectado (%s); reintento en %.0f s", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def publish(self, topic: str, payload: Any, qos: int = 0, retain: bool = False) -> None:
        if self._client is None:
            if qos == 0:
                return                                               # telemetría perdida: la siguiente llega en 1 s
            await asyncio.wait_for(self._connected.wait(), 10)
        data = payload if isinstance(payload, (str, bytes)) else contract.dumps(payload)
        await self._client.publish(topic, data, qos=qos, retain=retain)

    def subscribe(self, *patterns: str) -> Subscription:
        s = Subscription(self, patterns)
        self._subs.append(s)
        for p in patterns:
            if p not in self._patterns:
                self._patterns[p] = 1
                if self._client is not None:
                    asyncio.get_event_loop().create_task(self._client.subscribe(p, qos=1))
        return s

    def _unsubscribe(self, sub: Subscription) -> None:
        with contextlib.suppress(ValueError):
            self._subs.remove(sub)


def bus_from_config(cfg: dict, client_id: str | None = None, will=None) -> Bus:
    """cfg: {kind: memory|mqtt, host, port, username, password, tls, cafile}"""
    kind = cfg.get("kind", "mqtt")
    if kind == "memory":
        return MemoryBus()
    return MqttBus(cfg.get("host", "localhost"), int(cfg.get("port", 1883)), cfg.get("username"), cfg.get("password"),
                   bool(cfg.get("tls", False)), cfg.get("cafile"), client_id or cfg.get("client_id"), will)
