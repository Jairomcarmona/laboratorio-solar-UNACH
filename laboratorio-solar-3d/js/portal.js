/* Paginas de acceso (login.html) y reservas (reservas.html). Habla con la pasarela por /api; no guarda nada en el navegador:
 * la sesion vive en una cookie HttpOnly. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, data };
  };
  const show = (el, text) => { el.textContent = text || ''; el.hidden = !text; };
  const detail = (r) => (r.data && (typeof r.data.detail === 'string' ? r.data.detail : Array.isArray(r.data.detail) ? LAB.t('portal.revisa_los_datos_escritos') : null)) || `Error ${r.status}`;
  /** Solo rutas relativas del mismo sitio: evita redirigir a un dominio ajeno desde ?next= */
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : 'reservas.html');
  const ROLE = () => ({ student: LAB.t('portal.role_student'), teacher: LAB.t('portal.role_teacher'), tech: LAB.t('portal.tecnico'), visitor: LAB.t('portal.role_visitor'), admin: LAB.t('portal.administracion') });

  if ($('#loginForm')) {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = $('#user').value.trim(), p = $('#pass').value;
      if (!u || !p) return show($('#msg'), LAB.t('portal.escribe_tu_usuario_y'));
      $('#go').disabled = true; show($('#msg'), '');
      const r = await api('POST', '/api/login', { username: u, password: p });
      $('#go').disabled = false;
      if (!r.ok) { $('#pass').value = ''; return show($('#msg'), r.status === 429 ? LAB.t('portal.demasiados_intentos_espera_un') : detail(r)); }
      location.href = safeNext(new URLSearchParams(location.search).get('next'));
    });
  }

  if ($('#bookForm')) {
    const fmt = (iso) => new Date(iso).toLocaleString(LAB.locale(), { dateStyle: 'medium', timeStyle: 'short' });
    const load = async () => {
      const me = await api('GET', '/api/me');
      if (!me.ok) { location.href = 'login.html?next=' + encodeURIComponent('/reservas.html'); return; }
      const u = me.data.user;
      $('#who').textContent = `${u.display_name} · ${ROLE()[u.role] || u.role}`;
      $('#adminLink').hidden = !['admin', 'tech', 'teacher'].includes(u.role);
      $('#newBox').hidden = !['student', 'teacher', 'admin'].includes(u.role);
      const r = await api('GET', '/api/bookings');
      const ul = $('#list'); ul.textContent = '';
      (r.data && r.data.bookings || []).forEach((b) => {
        const li = document.createElement('li'); li.textContent = `${fmt(b.start)} → ${fmt(b.end)}`;
        const x = document.createElement('button'); x.className = 'btn'; x.type = 'button'; x.textContent = LAB.t('portal.cancelar');
        x.addEventListener('click', async () => { await api('DELETE', '/api/bookings/' + b.id); load(); });
        li.append(' ', x); ul.appendChild(li);
      });
      $('#empty').hidden = ul.children.length > 0;
    };
    $('#bookForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('#bStart').value, m = +$('#bMin').value;
      if (!v) return show($('#bMsg'), LAB.t('portal.elige_la_fecha_y'));
      if (!(m >= 15 && m <= 120)) return show($('#bMsg'), LAB.t('portal.la_duracion_va_de'));
      const start = new Date(v), end = new Date(start.getTime() + m * 60000);
      const r = await api('POST', '/api/bookings', { start: start.toISOString(), end: end.toISOString() });
      show($('#bMsg'), r.ok ? '' : detail(r));
      if (r.ok) load();
    });
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = 'login.html'; });
    load();
    LAB.i18n.onChange(load);
  }
})();
