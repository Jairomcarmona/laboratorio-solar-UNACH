/* Tema claro / oscuro. Se carga en <head> para fijar data-theme antes del primer pintado (sin parpadeo).
 * Prioridad: ?theme=light|dark en la URL > elección guardada (localStorage 'lab.theme') > oscuro (valor por defecto).
 *   LAB.theme.set('light'|'dark')   LAB.theme.toggle()   LAB.theme.current */
(function () {
  'use strict';
  const LAB = (window.LAB = window.LAB || {});
  const KEY = 'lab.theme', OK = ['dark', 'light'];
  const T = (LAB.theme = LAB.theme || {});
  const norm = (v) => (OK.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);
  const initial = () => {
    let q = null, s = null;
    try { q = norm(new URLSearchParams(location.search).get('theme')); } catch (e) { /* sin URL */ }
    try { s = norm(localStorage.getItem(KEY)); } catch (e) { /* sin almacenamiento */ }
    return q || s || 'dark';
  };
  T.current = initial();
  const paint = () => {
    document.documentElement.setAttribute('data-theme', T.current);
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', T.current === 'light' ? '#e9eff8' : '#05080c');
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.setAttribute('aria-pressed', T.current === 'light' ? 'true' : 'false');
      const label = LAB.t ? LAB.t('ui.theme.toggle') : 'Cambiar tema claro/oscuro';
      b.setAttribute('aria-label', label); b.title = label;
    });
  };
  T.set = (v, persist = true) => {
    const t = norm(v); if (!t) return false;
    T.current = t;
    if (persist) { try { localStorage.setItem(KEY, t); } catch (e) { /* sin almacenamiento */ } }
    paint();
    return true;
  };
  T.toggle = () => T.set(T.current === 'light' ? 'dark' : 'light');
  paint();
  const wire = () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', T.toggle));
    paint();
    if (LAB.i18n && LAB.i18n.onChange) LAB.i18n.onChange(paint);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
