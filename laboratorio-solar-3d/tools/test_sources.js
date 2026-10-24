/* S16-S19: WsSource (con WebSocket y fetch falsos), mapeo de telemetria, ReplaySource y TwinSource. Sin navegador ni servidor. */
const { T } = require('./lib/harness.js');
const { loadSim } = require('./lib/loadsim.js');
const LAB = loadSim();
const t = new T('Fuentes de red');

class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.readyState = 3; this.onclose && this.onclose({ code: code || 1000 }); }
  recv(o) { this.onmessage({ data: JSON.stringify(o) }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let clock = 1_800_000_000_000;
const mod = (p, extra = {}) => ({ poa: 800, tback: 45, v: 30, i: p / 30, p, wh: 12, ...extra });
const tele = (over = {}) => ({ ts: clock, seq: 1, source: 'fake', quality: [], env: { ghi: 700, dni: 800, dhi: 100, ta: 30, rh: 50, wind: 2, windDir: 90, rainRate: 0 },
  A: mod(200, { az: null }), B: mod(260), tracker: { az: 180, tilt: 20, appliedMode: 'astro', mode: 'astro', moving: { az: false, tilt: false } }, safety: { state: 'NORMAL', canOperate: true }, load: { mode: 'mppt', setpoint: null, sweeping: false }, ...over });

function fetchFor(routes) {
  return async (url, init = {}) => {
    const key = (init.method || 'GET') + ' ' + url;
    const h = routes[key];
    if (!h) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return typeof h === 'function' ? h() : h;
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

(async () => {
  // ---- cobertura de claves: la telemetria mapeada tiene todo lo que tiene la del simulador
  {
    const keys = (o, p = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && k !== 'vec' ? [p + k, ...keys(v, p + k + '.')] : [p + k]));
    const eng = new LAB.sim.Engine(); eng.step(0.05);
    const mapped = new Set(keys(LAB.data.mapTele(tele(), { hello: { user: 'ana', role: 'student' }, control: true, sessionId: 's1', link: 'open' })));
    const missing = keys(eng.telemetry).filter((k) => !mapped.has(k));
    t.eq('mapTele cubre todas las claves de la telemetria del simulador', missing.join(','), '');
    const sk = new Set(keys(LAB.data.skeleton()));
    t.eq('el esqueleto inicial tambien', keys(eng.telemetry).filter((k) => !sk.has(k)).join(','), '');
    const m = LAB.data.mapTele(tele(), { hello: { user: 'ana', role: 'student' }, control: true, sessionId: 's1', link: 'open' });
    t.ok('A fijo conserva su orientacion de la configuracion; B toma la medida', m.A.az === LAB.config.fixed.az && Number.isNaN(m.B.az) && m.tracker.az === 180);
    t.ok('canOperate solo con control + rol + PLC', m.safety.canOperate === true && LAB.data.mapTele(tele(), { hello: { user: 'v', role: 'visitor' }, control: false, link: 'open' }).safety.canOperate === false);
    t.ok('estado ESTOP -> lampara roja y estop', (() => { const x = LAB.data.mapTele(tele({ safety: { state: 'ESTOP', canOperate: false } }), { link: 'open' }); return x.safety.lamp === 'red' && x.safety.estop; })());
  }

  // ---- conexion, ticket, hello, telemetria, comandos
  const events = [];
  const src = new LAB.data.WsSource({ WebSocketImpl: FakeWS, now: () => clock, hbMs: 20, wsUrl: 'ws://x/ws',
    fetchImpl: fetchFor({ 'POST /api/ws-ticket': ok({ ticket: 'tk1', ttl: 30 }), 'GET /api/runs': ok({ runs: [{ id: 'run_a', label: 'x', practiceId: null, status: 'open', samples: 3 }] }), 'GET /api/runs/run_a.csv': ok('#c\nn,x\n0,1\n1,2\n') }) });
  src.on('ack', (a) => events.push(a));
  t.ok('antes de conectar: telemetria bloqueada y obsoleta', src.telemetry.quality.includes('stale') && !src.telemetry.safety.canOperate);
  await src.connect(); await tick();
  const ws = FakeWS.last;
  t.ok('usa el ticket en la URL del WebSocket', ws.url === 'ws://x/ws?ticket=tk1');
  await tick(60);
  t.ok('envia latidos cada hbMs', ws.sent.filter((m) => m.t === 'hb').length >= 2);
  ws.recv({ t: 'hello', v: 1, user: 'ana', role: 'student', control: false, state: null });
  ws.recv({ t: 'tele', v: 1, d: tele() });
  t.ok('con telemetria nueva ya no esta obsoleta', !src.telemetry.quality.includes('stale') && src.telemetry.B.p === 260);
  t.ok('sin control el comando se rechaza localmente', src.send({ type: 'tracker.target', az: 150, tilt: 20 }).kind === 'interlock');
  t.eq('comando de simulador: unsupported', src.send({ type: 'sim.cloud', value: 0.5 }).kind, 'unsupported');
  t.eq('comando invalido: validation', src.send({ type: 'tracker.target', az: NaN }).kind, 'validation');
  const r1 = src.send({ type: 'session.start', role: 'student', user: 'otro' });
  t.ok('session.start sale como pendiente', r1.ok && r1.pending);
  const w1 = ws.sent.find((m) => m.id === r1.id);
  t.ok('forma del contrato {t,v,id,type,args} y rol del hello', w1.t === 'cmd' && w1.v === 1 && w1.type === 'session.start' && w1.args.role === 'student');
  ws.recv({ t: 'event', v: 1, d: { ts: clock, level: 'ok', src: 'pasarela', code: 'session.granted', msg: 'Tienes el control del banco', data: { sessionId: 'ses_1' } } });
  ws.recv({ t: 'ack', v: 1, d: { id: r1.id, ok: true, ts: clock } });
  t.ok('acuse ok: control concedido y evento ack', src.control && events.some((e) => e.id === r1.id && e.ok));
  ws.recv({ t: 'tele', v: 1, d: tele() });
  t.ok('con control la telemetria permite operar', src.telemetry.safety.canOperate && src.telemetry.session.active && src.telemetry.session.id === 'ses_1');
  const r2 = src.send({ type: 'tracker.target', az: 150, tilt: 20 });
  ws.recv({ t: 'ack', v: 1, d: { id: r2.id, ok: false, ts: clock, kind: 'interlock', reason: 'Viento alto' } });
  const rej = events.find((e) => e.id === r2.id);
  t.ok('acuse de rechazo llega con motivo y queda en la bitacora', rej && !rej.ok && rej.reason === 'Viento alto' && src.logs.some((l) => /Viento alto/.test(l.msg)));
  const r3 = src.send({ type: 'acq.newRun', label: 'p', practiceId: null });
  ws.recv({ t: 'ack', v: 1, d: { id: r3.id, ok: true, ts: clock } }); await tick(10);
  t.ok('acq.newRun: el id de la corrida viene del servidor', src.acq.runId === 'run_a' && src.runs.length === 1 && src.runs[0].samples.length === 3);
  const csv = await src.exportCsv();
  t.ok('exportCsv pide el CSV al servidor', csv.ok && csv.rows === 2 && /run_a/.test(csv.filename));
  t.ok('estop se envia aun sin control', (() => { src.control = false; const r = src.send({ type: 'safety.estop', who: 'ana' }); return r.ok && r.pending; })());

  // ---- tele obsoleta
  clock += 10_000; src.step(0.1);
  t.ok('sin telemetria > staleMs: marcada obsoleta y bloqueada', src.telemetry.quality.includes('stale') && !src.telemetry.safety.canOperate && src.logs.some((l) => /Sin telemetría/.test(l.msg)));
  ws.recv({ t: 'tele', v: 1, d: tele({ ts: clock }) });
  t.ok('al volver la telemetria se recupera', !src.telemetry.quality.includes('stale'));

  // ---- cierre sin acuse -> timeout para el que esperaba
  src.control = true;
  const r4 = src.send({ type: 'tracker.target', az: 160 });
  events.length = 0; ws.close(1006); await tick();
  t.ok('al perder la conexion los pendientes se resuelven como timeout', events.some((e) => e.id === r4.id && e.kind === 'timeout'));
  t.ok('queda en reconexion', src.link === 'reconnecting');
  src.close();
  const unauth = new LAB.data.WsSource({ WebSocketImpl: FakeWS, fetchImpl: fetchFor({ 'POST /api/ws-ticket': { ok: false, status: 401, json: async () => ({}) } }) });
  let authEv = null; unauth.on('auth', (e) => { authEv = e; }); await unauth.connect();
  t.ok('401 al pedir ticket: sin reintentos y evento auth', unauth.link === 'unauthorized' && authEv && !authEv.ok);

  // ---- reproduccion
  {
    const head = 'n,segmento,utc_iso_simulado,hora_local_sitio,utc_iso_registro_real,G_A_Wm2,G_B_Wm2,Tcel_A_C,Tcel_B_C,Tamb_C,HR_pct,viento_ms,dir_viento_deg,V_A_V,I_A_A,P_A_W,E_A_Wh,V_B_V,I_B_A,P_B_W,E_B_Wh,azimut_B_deg,inclinacion_B_deg,modo_seguidor_aplicado,modo_carga,estado_seguridad,nubes_consigna_pct,sombra_mutua_A_frac,sombra_mutua_B_frac,evento';
    const row = (n) => `${n},s1,2026-10-23T17:30:0${n}.000Z,x,2026-10-23T17:30:0${n}.000Z,800.0,900.0,50.0,48.0,30.0,50,2.0,90,30.00,7.000,210.0,1.00,31.00,8.000,248.0,1.20,${180 + n}.0,20.0,astro,mppt,NORMAL,0,0.00,0.00,${n === 2 ? '"a, b"' : ''}`;
    const rp = new LAB.data.ReplaySource(['# c', head, row(0), row(1), row(2), row(3)].join('\n'));
    t.ok('replay: 4 muestras y primera mapeada', rp.teles.length === 4 && rp.telemetry.B.p === 248 && rp.telemetry.source === 'replay' && rp.telemetry.replay.count === 4);
    rp.step(1.05); t.eq('avanza al ritmo del tiempo registrado', rp.telemetry.replay.index, 1);
    rp.send({ type: 'replay.speed', speed: 10 }); rp.step(0.15); t.eq('x10 avanza mas rapido', rp.telemetry.replay.index, 2);
    rp.step(0.2); t.ok('al final se detiene', rp.telemetry.replay.ended && !rp.playing);
    rp.send({ type: 'replay.seek', ms: Date.parse('2026-10-23T17:30:01.000Z') }); t.eq('seek', rp.telemetry.replay.index, 1);
    t.eq('replay rechaza comandos de operacion', rp.send({ type: 'tracker.target', az: 150 }).kind, 'unsupported');
    t.ok('replay nunca permite operar', rp.telemetry.safety.canOperate === false);
    t.eq('el CSV con comillas se lee entero', LAB.data.parseRunCsv(['# c', head, row(2)].join('\n')).rows[0].evento, 'a, b');
  }

  // ---- gemelo
  {
    const w = new LAB.data.WsSource({ WebSocketImpl: FakeWS, now: () => clock, fetchImpl: fetchFor({ 'POST /api/ws-ticket': ok({ ticket: 't' }) }) });
    await w.connect(); await tick();
    const wsk = FakeWS.last;
    wsk.recv({ t: 'hello', v: 1, user: 'ana', role: 'student', control: false });
    const real = tele({ ts: LAB.fromLocal(2026, 10, 23, 11, 30), env: { ghi: 800, dni: 900, dhi: 90, ta: 31, rh: 45, wind: 1.5, windDir: 80, rainRate: 0 } });
    real.B.p = 150; clock = real.ts;
    wsk.recv({ t: 'tele', v: 1, d: real });
    const tw = new LAB.data.TwinSource(w);
    for (let i = 0; i < 60; i++) tw.step(0.05);
    t.ok('gemelo: fuente twin con ambiente medido', tw.telemetry.source === 'twin' && Math.abs(tw.telemetry.env.ghi - 800) < 1 && Math.abs(tw.telemetry.env.ta - 31) < 0.5);
    t.ok('gemelo: el seguidor del modelo esta donde el real', Math.abs(tw.telemetry.tracker.az - 180) < 1e-6 && Math.abs(tw.telemetry.tracker.tilt - 20) < 1e-6);
    t.ok('gemelo: residuo B = real - modelo', tw.telemetry.residual.B && Math.abs(tw.telemetry.residual.B.diff - (150 - tw.telemetry.B.p)) < 1e-6 && tw.telemetry.residual.B.pct < -10);
    t.eq('gemelo: los comandos van al banco real y se validan', tw.send({ type: 'sim.cloud', value: 0.5 }).kind, 'unsupported');
    w.close();
  }
  t.done();
})();
