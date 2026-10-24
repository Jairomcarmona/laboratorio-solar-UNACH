/* Idiomas de la interfaz. Los textos viven en i18n/es.json y i18n/en.json (claves planas); i18n/es.js y i18n/en.js son su copia
 * para <script> (se generan con `node tools/build_i18n.js`) porque el simulador se abre con doble clic, sin servidor ni fetch.
 *   LAB.t('clave', { n: 3 })  texto en el idioma activo; marcador {n}. Si falta la clave, usa el español; si tampoco, la clave.
 *   data-i18n / data-i18n-html / data-i18n-attr="title:clave;aria-label:otra" en el HTML se aplican con LAB.i18n.apply().
 *   LAB.i18n.set('en') cambia el idioma, lo guarda y avisa a los modulos con LAB.i18n.onChange(fn). */
(function () {
  'use strict';
  const LAB = (window.LAB = window.LAB || {});
  const LANGS = ['es', 'en'];
  const KEY = 'lab.lang';
  const I = (LAB.i18n = LAB.i18n || {});
  I.langs = LANGS;
  I.lang = 'es';
  I.dict = I.dict || { es: {}, en: {} };
  I.missing = new Set();            // claves pedidas que no existen en ningun idioma (las revisa la prueba)
  I.fellBack = new Set();           // claves que existen en español pero no en el idioma activo
  const listeners = [];

  I.register = (lang, obj) => { I.dict[lang] = Object.assign(I.dict[lang] || {}, obj); };
  I.has = (key) => Object.prototype.hasOwnProperty.call(I.dict[I.lang] || {}, key);

  const fill = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k]))) : s);
  LAB.t = (key, params) => {
    const cur = I.dict[I.lang] || {};
    let s = cur[key];
    if (s === undefined) {
      s = I.dict.es[key];
      if (s === undefined) { I.missing.add(key); return key; }
      if (I.lang !== 'es') I.fellBack.add(key);
    }
    return fill(s, params);
  };
  /** Lista traducida (las claves .0, .1, ... hasta que falte una) */
  /** Configuración regional para fechas y números (no cambia los datos exportados) */
  LAB.locale = () => (I.lang === 'en' ? 'en-US' : 'es-MX');
  LAB.tl = (key) => { const out = []; for (let i = 0; i < 99; i++) { const k = key + '.' + i; if (I.dict.es[k] === undefined) break; out.push(LAB.t(k)); } return out; };

  /** Traduce un valor de datos con prefijo (p. ej. LAB.tk('ev.kind.', 'carga')); si no hay clave devuelve el valor tal cual */
  LAB.tk = (prefix, value) => { const k = prefix + value; return I.dict.es[k] !== undefined ? LAB.t(k) : String(value); };

  // Mensajes del motor y del nucleo (js/sim, js/core): se guardan en español y se traducen AL MOSTRARLOS, asi el motor no cambia.
  // Las claves 'msg.*' de es.json son plantillas con {nombre}; un parametro llamado t_x se traduce de forma recursiva.
  let msgIndex = null, msgCount = -1;
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const buildMsgIndex = () => {
    const keys = Object.keys(I.dict.es).filter((k) => k.startsWith('msg.'));
    if (msgIndex && msgCount === keys.length) return msgIndex;
    msgCount = keys.length;
    msgIndex = keys.map((k) => {
      const tpl = I.dict.es[k], names = [];
      const re = '^' + tpl.split(/(\{\w+\})/).map((part) => { const m = /^\{(\w+)\}$/.exec(part); if (m) { names.push(m[1]); return '([\\s\\S]*?)'; } return esc(part); }).join('') + '$';
      return { key: k, re: new RegExp(re), names, lit: tpl.replace(/\{\w+\}/g, '').length };
    }).sort((a, b) => b.lit - a.lit);      // primero las plantillas mas especificas
    return msgIndex;
  };
  LAB.tm = (text) => {
    if (typeof text !== 'string' || !text || I.lang === 'es') return text;
    for (const e of buildMsgIndex()) {
      const m = e.re.exec(text); if (!m) continue;
      const params = {}; e.names.forEach((n, i) => { params[n] = n.startsWith('t_') ? LAB.tm(m[i + 1]) : m[i + 1]; });
      return LAB.t(e.key, params);
    }
    return text;
  };

  I.normalize = (l) => { l = String(l || '').toLowerCase().slice(0, 2); return LANGS.includes(l) ? l : null; };
  I.initial = () => {
    let q = null, saved = null, nav = null;
    try { q = I.normalize(new URLSearchParams(location.search).get('lang')); } catch (e) { /* sin URL */ }
    try { saved = I.normalize(localStorage.getItem(KEY)); } catch (e) { /* sin almacenamiento */ }
    return q || saved || nav || 'es';   // español por defecto: el idioma del navegador no lo cambia
  };

  I.apply = (root) => {
    if (typeof document === 'undefined') return;
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = LAB.t(e.getAttribute('data-i18n')); });
    r.querySelectorAll('[data-i18n-html]').forEach((e) => { e.innerHTML = LAB.t(e.getAttribute('data-i18n-html')); });
    r.querySelectorAll('[data-i18n-attr]').forEach((e) => {
      e.getAttribute('data-i18n-attr').split(';').forEach((pair) => { const j = pair.indexOf(':'); if (j > 0) e.setAttribute(pair.slice(0, j), LAB.t(pair.slice(j + 1))); });
    });
    if (document.documentElement) { document.documentElement.lang = I.lang; document.documentElement.style.setProperty('--ro-label', JSON.stringify('🔒 ' + LAB.t('ui.readonly.tag'))); }
    document.querySelectorAll('[data-lang]').forEach((b) => { const on = b.dataset.lang === I.lang; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  };
  I.onChange = (fn) => { listeners.push(fn); };
  I.set = (lang, persist = true) => {
    const l = I.normalize(lang); if (!l) return false;
    I.lang = l;
    if (persist) { try { localStorage.setItem(KEY, l); } catch (e) { /* sin almacenamiento */ } }
    I.apply();
    listeners.forEach((fn) => { try { fn(l); } catch (e) { console.error(e); } });
    return true;
  };
  I.lang = I.initial();
  // los botones [data-lang] (barra superior y portal) cambian el idioma sin cablear cada pagina
  if (typeof document !== 'undefined') document.addEventListener('click', (ev) => { const b = ev.target.closest && ev.target.closest('[data-lang]'); if (b) I.set(b.dataset.lang); });
  // el HTML se traduce en cuanto el DOM existe (sin esperar al resto de scripts)
  if (typeof document !== 'undefined') {
    const go = () => I.apply();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
})();
