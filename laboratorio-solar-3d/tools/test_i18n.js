/* Idiomas (sin navegador): diccionarios, cambio de idioma, respaldo en español, traducción de mensajes del motor y configuración del sitio.
 * Ejecutar: node tools/test_i18n.js   (código de salida distinto de cero si algo falla) */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { T } = require('./lib/harness.js');
const { loadSim, ROOT } = require('./lib/loadsim.js');

const t = new T('Idiomas y configuración del sitio');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const es = JSON.parse(read('i18n/es.json')), en = JSON.parse(read('i18n/en.json'));
const ph = (s) => new Set((String(s).match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1)));

const LAB = loadSim(['i18n/es.js', 'i18n/en.js', 'js/i18n.js']);
const I = LAB.i18n;

// ---------------------------------------------------------------- diccionarios
t.ok('es y en tienen exactamente las mismas claves', JSON.stringify(Object.keys(es).sort()) === JSON.stringify(Object.keys(en).sort()), Object.keys(es).filter((k) => !(k in en)).concat(Object.keys(en).filter((k) => !(k in es))).slice(0, 5).join(', '));
t.ok('ningún texto está vacío', Object.entries(en).every(([k, v]) => typeof v === 'string' && v.length > 0) && Object.entries(es).every(([k, v]) => typeof v === 'string'));
{
  const EXTRA_ES = { 'prac.los_requisitos_operativos_estan': ['s', 's3'] };       // el plural del español no existe en la frase en inglés
  const bad = [];
  for (const k of Object.keys(es)) {
    const a = ph(es[k]), b = ph(en[k]);
    for (const p of b) if (!a.has(p)) bad.push(`${k}: {${p}} solo en inglés`);
    for (const p of a) if (!b.has(p) && !(EXTRA_ES[k] || []).includes(p)) bad.push(`${k}: {${p}} falta en inglés`);
  }
  t.ok('los marcadores {param} coinciden entre es y en', bad.length === 0, bad.slice(0, 5).join(' | '));
}
t.ok('el inglés no es una copia del español (menos de 8 % de textos idénticos con letras)', (() => {
  const same = Object.keys(es).filter((k) => es[k] === en[k] && /[A-Za-zÁ-ú]{4,}/.test(es[k]));
  return same.length / Object.keys(es).length < 0.08;
})());
t.eq('los .js generados corresponden a los .json', cp.spawnSync('node', [path.join(ROOT, 'tools/build_i18n.js'), '--check']).status, 0);

// ---------------------------------------------------------------- uso en el código: toda clave referida existe
{
  const files = [];
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => { const p = d + '/' + e.name; if (e.isDirectory()) { if (e.name !== 'lib' && e.name !== 'data') walk(p); } else if (/\.js$/.test(e.name) && p !== 'js/i18n.js') files.push(p); });
  walk('js');
  const missing = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/LAB\.t\(\s*'([\w.]+)'/g)) if (!(m[1] in es)) missing.add(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/LAB\.tl\(\s*'([\w.]+)'/g)) if (!(`${m[1]}.0` in es)) missing.add(`${f}: lista ${m[1]}`);
  }
  for (const f of ['index.html', 'login.html', 'reservas.html', 'admin.html']) {
    const src = read(f);
    for (const m of src.matchAll(/data-i18n(?:-html)?="([\w.]+)"/g)) if (!(m[1] in es)) missing.add(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(';').forEach((p) => { const k = p.slice(p.indexOf(':') + 1); if (!(k in es)) missing.add(`${f}: ${k}`); });
  }
  t.ok('toda clave usada en JS y HTML existe en el diccionario', missing.size === 0, [...missing].slice(0, 6).join(' | '));
}

// ---------------------------------------------------------------- comportamiento de LAB.t
t.eq('idioma inicial: español', I.lang, 'es');
t.eq('LAB.t sustituye parámetros', LAB.t('layout.pixeles', { cur: 480 }), '480 píxeles');
I.set('en', false);
t.eq('al cambiar a inglés cambia el texto', LAB.t('layout.pixeles', { cur: 480 }), '480 pixels');
t.eq('LAB.i18n.set rechaza idiomas desconocidos', I.set('fr', false), false);
t.eq('…y conserva el idioma activo', I.lang, 'en');
{
  const saved = I.dict.en['layout.pixeles']; delete I.dict.en['layout.pixeles'];
  t.eq('si falta una clave en inglés, usa el español', LAB.t('layout.pixeles', { cur: 3 }), '3 píxeles');
  t.ok('…y la deja registrada para revisarla', I.fellBack.has('layout.pixeles'));
  I.dict.en['layout.pixeles'] = saved;
}
t.eq('una clave desconocida devuelve la clave (no rompe la pantalla)', LAB.t('no.existe.esta'), 'no.existe.esta');
t.eq('un parámetro ausente deja el marcador visible', LAB.t('layout.pixeles', {}), '{cur} pixels');
{
  let seen = null; const off = I.onChange((l) => { seen = l; });
  I.set('es', false); t.eq('onChange avisa del nuevo idioma', seen, 'es');
  I.set('en', false);
}
t.eq('LAB.locale sigue al idioma', LAB.locale(), 'en-US');
I.set('es', false); t.eq('…y en español usa es-MX', LAB.locale(), 'es-MX');

// ---------------------------------------------------------------- mensajes del motor: se guardan en español y se traducen al mostrarlos
{
  I.set('en', false);
  const e = new LAB.sim.Engine(); const msgs = [];
  const login = () => e.send({ type: 'session.start', role: 'student', user: 'Estudiante', profileId: LAB.core.store.profileId('student', 'Estudiante') });
  const step = (n) => { for (let i = 0; i < n; i++) e.step(0.05); };
  const grab = (r) => { if (r && r.reason) msgs.push(r.reason); if (r && r.msg) msgs.push(r.msg); };
  e.send({ type: 'tracker.target', az: 150, tilt: 30 });                 // sin sesión: rechazado
  grab(e.send({ type: 'tracker.target', az: 150, tilt: 30 }));
  login(); step(40);
  [{ type: 'tracker.target', az: 20 }, { type: 'tracker.target', az: 150, tilt: 30 }, { type: 'tracker.target', az: 150 }, { type: 'tracker.target', tilt: 40 }, { type: 'tracker.mode', mode: 'astro' },
    { type: 'tracker.locks', lockAz: false, lockTilt: true }, { type: 'tracker.target', tilt: 40 }, { type: 'tracker.locks', lockAz: false, lockTilt: false }, { type: 'load.set', mode: 'mppt' }, { type: 'load.set', mode: 'cv', setpoint: 5 },
    { type: 'sim.cloud', value: 3 }, { type: 'sim.wind', value: 99 }, { type: 'sim.speed', speed: 7 }, { type: 'acq.newRun' }, { type: 'acq.start' }, { type: 'acq.start' }, { type: 'load.sweep' }, { type: 'sim.speed', speed: 60 },
    { type: 'safety.estop', who: 'Práctica 4' }, { type: 'tracker.target', az: 150 }, { type: 'safety.reset' }, { type: 'safety.commsLoss' }, { type: 'safety.ack' }, { type: 'safety.commsRestore' }, { type: 'safety.ack' },
    { type: 'acq.stop' }, { type: 'acq.newRun' }, { type: 'sim.gust', peak: 20, seconds: 16 }, { type: 'nope' }].forEach((c) => { grab(e.send(c)); step(20); });
  step(1200);
  e.logs.forEach((l) => msgs.push(l.msg));
  const untranslated = [...new Set(msgs)].filter((m) => LAB.tm(m) === m && /[a-záéíóúñ]{4,}/i.test(m) && /\b(el|la|los|de|que|no|se|está|hay|puedes|inicia|tu)\b|[áéíóúñ]/i.test(m));
  t.ok(`mensajes del motor y del interlock traducidos (${msgs.length} revisados)`, untranslated.length === 0, untranslated.slice(0, 4).join(' | '));
  t.ok('los mensajes en español no se alteran en español', (I.set('es', false), msgs.every((m) => LAB.tm(m) === m)));
  I.set('en', false);
  t.eq('traducción con parámetros', LAB.tm('Azimut 20° fuera del rango autorizado (90°–270°).'), 'Azimuth 20° outside the authorised range (90°–270°).');
  t.eq('traducción anidada (t_*)', LAB.tm('Barrido I-V interrumpido (paro de emergencia): se conservan 13 puntos parciales y el modo de carga se restauró.'), 'I-V sweep interrupted (emergency stop): 13 partial points are kept and the load mode was restored.');
  t.eq('texto desconocido pasa sin cambios', LAB.tm('Texto libre del usuario'), 'Texto libre del usuario');
  t.eq('cadena vacía se conserva', LAB.tm(''), '');
  I.set('es', false);
}

// ---------------------------------------------------------------- ubicación configurable en un solo lugar
{
  const c = LAB.config;
  t.ok('valores por defecto: Tuxtla Gutiérrez', Math.abs(c.site.lat - 16.7516) < 1e-6 && Math.abs(c.site.lon + 93.1161) < 1e-6 && c.site.alt === 530 && c.site.tz === 'America/Mexico_City' && c.site.tzHours === -6);
  t.eq('las coordenadas del edificio se marcan como aproximadas hasta medirlas', c.site.measured, false);
  t.eq('la tabla de cielo despejado corresponde al sitio por defecto', c.siteStatus().tableMatches, true);
  const before = JSON.stringify(c.site);
  const bad = c.setSite({ lat: 95 });
  t.ok('latitud fuera de rango se rechaza con clave de idioma', !bad.ok && bad.errors[0] === 'site.err.lat' && (bad.errors[0] in es));
  t.ok('zona horaria desconocida se rechaza', c.setSite({ tz: 'Mars/Olympus' }).errors.includes('site.err.tz'));
  t.ok('un parche inválido no cambia nada (ni lo válido que traía)', (c.setSite({ lat: 20, lon: 999 }), JSON.stringify(c.site) === before));
  t.eq('America/Mexico_City vale UTC−6 todo el año', c.tzOffsetHours('America/Mexico_City'), -6);
  t.eq('zona sin horario de verano', c.tzOffsetHours('Asia/Kolkata'), 5.5);
  const p0 = LAB.sim.solar.position(LAB.fromLocal(2026, 10, 23, 12, 0), c.site.lat, c.site.lon);
  const ok = c.setSite({ lat: 19.4326, lon: -99.1332, alt: 2240, tz: 'America/Mexico_City', measured: true });
  t.ok('setSite acepta un parche válido', ok.ok && c.site.lat === 19.4326 && c.site.measured === true);
  t.ok('…y la tabla de Tuxtla deja de corresponder (se avisa)', c.siteStatus().tableMatches === false);
  const p1 = LAB.sim.solar.position(LAB.fromLocal(2026, 10, 23, 12, 0));
  t.ok('el motor solar usa la ubicación configurada (cambia la elevación solar)', Math.abs(p1.el - p0.el) > 0.5, `${p0.el.toFixed(2)}° → ${p1.el.toFixed(2)}°`);
  c.setSite({ lat: 16.7516, lon: -93.1161, alt: 530, measured: false });
  t.ok('se restablece el sitio por defecto', c.siteStatus().tableMatches && Math.abs(LAB.sim.solar.position(LAB.fromLocal(2026, 10, 23, 12, 0)).el - p0.el) < 1e-9);
  t.ok('la paleta A/B tiene una sola fuente (config.palette)', /^#[0-9a-f]{6}$/i.test(c.palette.A) && /^#[0-9a-f]{6}$/i.test(c.palette.B) && c.palette.A !== c.palette.B);
}

t.done();
