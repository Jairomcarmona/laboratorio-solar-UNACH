/* Capa de datos desacoplada.
 *
 * La escena 3D y la interfaz solo conocen esta interfaz:
 *   source.telemetry        objeto con el estado del banco (ver LAB.sim.Engine._snapshot para el esquema)
 *   source.step(dt)         avanza la fuente (el simulador calcula; las fuentes de red solo procesan mensajes)
 *   source.send(cmd)        envia un comando; devuelve {ok, reason?} (en red: {ok:true, pending:true} y el acuse llega por el evento 'ack')
 *   source.on(evt, fn)      eventos 'log', 'sweep', 'ack', 'acq', ...
 *
 * Fuentes:  sim    motor local (js/sim/engine.js), funciona sin red.
 *           ws     banco real a traves de la pasarela del servidor (js/data/wsSource.js).
 *           replay corrida registrada (CSV) en solo lectura.
 *           twin   modelo del simulador alimentado con el ambiente medido por el banco.
 * Los limites criticos nunca se confian al cliente: la autoridad es el PLC (ver server/contract/v1).
 */
(function () {
  'use strict';
  LAB.data = LAB.data || {};
  LAB.data.createSource = (kind = 'sim', options = {}) => {
    if (kind === 'ws' || kind === 'real') return new LAB.data.WsSource(options);
    if (kind === 'twin') return new LAB.data.TwinSource(options.ws || new LAB.data.WsSource(options));
    if (kind === 'replay') return new LAB.data.ReplaySource(options.csv || '', options);
    return new LAB.sim.Engine();
  };
})();
