/* Panel de administración (admin.html). Solo textContent: la política de contenido no admite HTML insertado.
 * admin: todo. tech (técnico): control en vivo, liberar y mantenimiento; no ve usuarios ni auditoría. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, data };
  };
  const detail = (r) => (r.data && typeof r.data.detail === 'string' && r.data.detail) || `Error ${r.status}`;
  const show = (el, text) => { el.textContent = text || ''; el.hidden = !text; };
  const ROLE = () => ({ student: LAB.t('portal.role_student'), teacher: LAB.t('portal.role_teacher'), tech: LAB.t('portal.tecnico'), visitor: LAB.t('portal.role_visitor'), admin: LAB.t('portal.administracion') });
  const fmt = (iso) => new Date(iso).toLocaleString(LAB.locale(), { dateStyle: 'medium', timeStyle: 'short' });
  const li = (ul, text, ...extra) => { const el = document.createElement('li'); const s = document.createElement('span'); s.textContent = text; el.append(s, ...extra); ul.appendChild(el); return el; };
  const btn = (label, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); return b; };
  const mins = (s) => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  let me = null, timer = null;

  const refreshLive = async () => {
    const r = await api('GET', '/api/admin/control');
    if (!r.ok) return show($('#topMsg'), detail(r));
    const d = r.data, live = $('#live'); live.textContent = '';
    const row = (k, v) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; live.append(dt, dd); };
    row(LAB.t('admin.operador'), d.control ? `${d.control.user} (${ROLE()[d.control.role] || d.control.role}) · ${mins(d.control.heldSeconds)}` : LAB.t('admin.nadie_tiene_el_control'));
    if (d.control && d.control.bookingEnd) row(LAB.t('admin.reserva_hasta'), fmt(d.control.bookingEnd));
    row(LAB.t('admin.estado_del_banco'), `${d.state.safety || '—'} · PLC ${d.state.plc || '—'} · ${LAB.t('admin.puente')} ${d.state.bridge || '—'}`);
    row(LAB.t('admin.telemetria'), d.teleAgeMs == null ? LAB.t('admin.sin_datos') : LAB.t('admin.hace_ms', { ms: d.teleAgeMs }));
    $('#maintState').textContent = d.maintenance ? LAB.t('admin.bloqueado_por', { by: d.maintenance.by, reason: d.maintenance.reason || '—' }) : LAB.t('admin.el_banco_esta_disponible');
    const w = $('#watchers'); w.textContent = '';
    d.clients.forEach((c) => li(w, `${c.user} · ${ROLE()[c.role] || c.role} · ${c.control ? LAB.t('admin.controla') : LAB.t('admin.observa')}`));
    $('#release').disabled = !d.control;
    show($('#topMsg'), '');
  };

  const loadUsers = async () => {
    const r = await api('GET', '/api/admin/users');
    const ul = $('#users'); ul.textContent = '';
    (r.data && r.data.users || []).forEach((u) => {
      const sel = document.createElement('select'); sel.setAttribute('aria-label', LAB.t('admin.uRole.rol'));
      Object.keys(ROLE()).forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = ROLE()[k]; o.selected = k === u.role; sel.appendChild(o); });
      sel.addEventListener('change', async () => { const x = await api('PATCH', '/api/admin/users/' + u.id, { role: sel.value }); if (!x.ok) show($('#uMsg'), detail(x)); loadUsers(); refreshLive(); });
      const tog = btn(u.active ? LAB.t('admin.desactivar') : LAB.t('admin.activar'), async () => {
        if (u.active && !window.confirm(LAB.t('admin.confirmar_desactivar', { user: u.username }))) return;
        const x = await api('PATCH', '/api/admin/users/' + u.id, { active: !u.active }); if (!x.ok) show($('#uMsg'), detail(x)); loadUsers(); refreshLive();
      });
      li(ul, `${u.username}${u.active ? '' : ' · ' + LAB.t('admin.inactivo')}`, sel, tog);
    });
  };

  const loadBookings = async () => {
    const r = await api('GET', '/api/bookings?all=true');
    const ul = $('#bookings'); ul.textContent = '';
    (r.data && r.data.bookings || []).forEach((b) => li(ul, `${b.user} · ${fmt(b.start)} → ${fmt(b.end)}`, btn(LAB.t('portal.cancelar'), async () => {
      if (!window.confirm(LAB.t('admin.confirmar_cancelar'))) return;
      await api('DELETE', '/api/bookings/' + b.id); loadBookings(); refreshLive();
    })));
    $('#noBookings').hidden = ul.children.length > 0;
  };

  const loadAudit = async () => {
    const q = new URLSearchParams(); if ($('#aUser').value.trim()) q.set('user', $('#aUser').value.trim()); if ($('#aAction').value.trim()) q.set('action', $('#aAction').value.trim()); q.set('limit', '100');
    const r = await api('GET', '/api/admin/audit?' + q);
    const ul = $('#audit'); ul.textContent = '';
    (r.data && r.data.audit || []).forEach((a) => li(ul, `${fmt(a.ts)} · ${a.username || '—'} · ${a.action} · ${a.ok ? 'ok' : LAB.t('admin.fallo')}${a.detail ? ' · ' + a.detail : ''}`));
  };

  const init = async () => {
    const r = await api('GET', '/api/me');
    if (!r.ok) { location.href = 'login.html?next=' + encodeURIComponent('/admin.html'); return; }
    me = r.data.user;
    $('#who').textContent = `${me.display_name} · ${ROLE()[me.role] || me.role}`;
    if (!['admin', 'tech'].includes(me.role)) { show($('#topMsg'), LAB.t('admin.tu_rol_no_permite_esta')); ['hLive', 'hMaint', 'hUsers', 'hBook', 'hAudit'].forEach((id) => { $('#' + id).parentElement.hidden = true; }); return; }
    const isAdmin = me.role === 'admin';
    ['usersBox', 'auditBox'].forEach((id) => { $('#' + id).hidden = !isAdmin; });
    $('#hBook').parentElement.hidden = !isAdmin;
    const roles = $('#uRole'); roles.textContent = '';
    Object.keys(ROLE()).forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = ROLE()[k]; roles.appendChild(o); });
    roles.value = 'student';
    refreshLive();
    if (isAdmin) { loadUsers(); loadBookings(); loadAudit(); }
    clearInterval(timer); timer = setInterval(refreshLive, 3000);
  };

  $('#release').addEventListener('click', async () => {
    if (!window.confirm(LAB.t('admin.confirmar_liberar'))) return;
    const r = await api('POST', '/api/admin/control/release'); if (!r.ok) show($('#topMsg'), detail(r)); refreshLive();
  });
  $('#maintOn').addEventListener('click', async () => {
    if (!window.confirm(LAB.t('admin.confirmar_mantenimiento'))) return;
    const r = await api('POST', '/api/admin/maintenance', { on: true, reason: $('#mReason').value.trim() }); if (!r.ok) show($('#topMsg'), detail(r)); refreshLive();
  });
  $('#maintOff').addEventListener('click', async () => { const r = await api('POST', '/api/admin/maintenance', { on: false }); if (!r.ok) show($('#topMsg'), detail(r)); refreshLive(); });
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = $('#uName').value.trim(), p = $('#uPass').value;
    if (!u || !p) return show($('#uMsg'), LAB.t('admin.escribe_usuario_y_contrasena'));
    const r = await api('POST', '/api/admin/users', { username: u, password: p, role: $('#uRole').value, display_name: u });
    show($('#uMsg'), r.ok ? '' : detail(r));
    if (r.ok) { $('#uName').value = ''; $('#uPass').value = ''; loadUsers(); }
  });
  $('#auditForm').addEventListener('submit', (e) => { e.preventDefault(); loadAudit(); });
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = 'login.html'; });
  init();
  LAB.i18n.onChange(init);
})();
