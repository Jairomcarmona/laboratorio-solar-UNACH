/* Vista «Conexiones del módulo» (punto 6) + multímetro virtual (punto 7).
 * El diagrama es ILUSTRATIVO hasta tener fotos del banco: caja de conexiones con 3 diodos de bypass, conectores MC4 y puntos de medida.
 * El multímetro no tiene física propia: LAB.core.meter pone la carga del banco en oc / sc con el comando real y lee el punto de operación. */
(function () {
  'use strict';
  const { fmt } = LAB.util;
  const $ = (s, r = document) => r.querySelector(s);
  const ui = (LAB.ui = LAB.ui || {});
  const M = () => LAB.core.meter;

  const FN_UNIT = { voc: 'V', isc: 'A' };
  const REASON = () => ({
    cancelled: LAB.t('conn.r_cancelled'), limit: LAB.t('conn.r_limit', { s: M().spec().scMaxS }), safety: LAB.t('conn.r_safety'), estop: LAB.t('conn.r_estop'), stale: LAB.t('conn.r_stale'),
    sweep: LAB.t('conn.r_sweep'), timeout: LAB.t('conn.r_timeout'), changed: LAB.t('conn.r_changed'),
  });
  const PROBE_MSG = () => ({ missing: LAB.t('conn.p_missing'), modules: LAB.t('conn.p_modules'), same: LAB.t('conn.p_same') });

  let tel = null, meas = null, fn = 'voc', red = 'B+', black = 'B-', mod = 'B', last = null, inited = false, clickN = 0;

  function init() {
    if (inited || !$('#connDlg')) return; inited = true;
    const dlg = $('#connDlg');
    $('#btnConn').addEventListener('click', () => { ui.showModal(dlg); render(); });
    $('.x', dlg).addEventListener('click', () => { if (meas) meas.cancel(); ui.hideModal(dlg); });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (meas) meas.cancel(); ui.hideModal(dlg); } });
    $$('#connMod button').forEach((b) => b.addEventListener('click', () => { mod = b.dataset.m; red = mod + '+'; black = mod + '-'; last = null; render(); }));
    $$('#dmmFn button').forEach((b) => b.addEventListener('click', () => { if (meas) return; fn = b.dataset.fn; last = null; render(); }));
    $('#dmmRed').addEventListener('change', (e) => { red = e.target.value; last = null; render(); });
    $('#dmmBlack').addEventListener('change', (e) => { black = e.target.value; last = null; render(); });
    $$('#connSvg [data-tp]').forEach((g) => {
      const pick = () => { if (meas) return; const p = g.dataset.tp; if (clickN % 2 === 0) red = p; else black = p; clickN++; last = null; render(); };
      g.addEventListener('click', pick); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $('#dmmGo').addEventListener('click', start);
    $('#dmmCancel').addEventListener('click', () => { if (meas) meas.cancel(); });
    render();
  }
  function $$(s, r = document) { return Array.from(r.querySelectorAll(s)); }

  function start() {
    const pr = M().probes(red, black);
    if (!pr.valid || meas || !tel) return;
    const L = tel.load;
    meas = new (M().Measurement)(fn, pr.module, pr.sign, { mode: L.mode, setpoint: L.setpoint }, (c) => ui.send(c));
    last = null; render();
  }

  /** Llamada en cada ciclo de la interfaz con la telemetría y el dt real */
  function update(t, dt) {
    tel = t;
    if (!inited) return;
    if (meas) {
      const st = meas.tick(t, dt);
      if (st === 'done') { last = { ok: true, ...meas.result }; meas = null; }
      else if (st === 'aborted') { last = { ok: false, reason: meas.reason }; meas = null; }
      if (!meas) render();
    }
    if ($('#connDlg').hidden) return;
    live();
  }

  function live() {
    const pr = M().probes(red, black), can = tel && tel.safety.session.active && tel.safety.role.canOperate;
    const sc = meas && meas.scActive;
    const w = $('#dmmScWarn'); w.hidden = !(sc || (fn === 'isc' && !meas)); 
    if (sc) setT('dmmScWarn', LAB.t('conn.sc_active', { s: fmt(Math.max(0, M().spec().scMaxS - meas.t), 0), max: M().spec().scMaxS }));
    else setT('dmmScWarn', LAB.t('conn.sc_warn', { max: M().spec().scMaxS }));
    setT('dmmMsg', meas ? (meas.state === 'settling' ? LAB.t('conn.settling') : LAB.t('conn.sampling', { n: meas.samples.length, total: M().spec().samples })) : !pr.valid ? PROBE_MSG()[pr.reason] : !can ? LAB.t('conn.need_control') : last && !last.ok ? (REASON()[last.reason] || LAB.tm(last.reason)) : last ? LAB.t('conn.done') : LAB.t('conn.ready'));
    $('#dmmGo').disabled = !!meas || !pr.valid || !can;
    $('#dmmCancel').hidden = !meas;
  }
  const setT = (id, v) => { const e = document.getElementById(id); if (e && e.textContent !== v) e.textContent = v; };

  function render() {
    if (!inited) return;
    $$('#connMod button').forEach((b) => { const on = b.dataset.m === mod; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#dmmFn button').forEach((b) => { const on = b.dataset.fn === fn; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !!meas; });
    $('#dmmRed').value = red; $('#dmmBlack').value = black;
    $('#dmmRed').disabled = $('#dmmBlack').disabled = !!meas;
    // los dos puntos de medida del diagrama son los del módulo elegido; marcas de las puntas
    $('#tpPos').dataset.tp = mod + '+'; $('#tpNeg').dataset.tp = mod + '-';
    $('#tpPos').setAttribute('aria-label', LAB.t('conn.tp_pos', { m: mod })); $('#tpNeg').setAttribute('aria-label', LAB.t('conn.tp_neg', { m: mod }));
    $$('#connSvg [data-tp]').forEach((g) => {
      const p = g.dataset.tp; g.classList.toggle('pr', p === red); g.classList.toggle('pb', p === black);
      g.setAttribute('aria-pressed', String(p === red || p === black));
    });
    setT('connModTitle', LAB.t('conn.mod_title', { m: mod }));
    $('#connSvg').dataset.mod = mod;
    const r = last && last.ok ? last : null;
    setT('dmmVal', r ? r.text : meas ? '- - -' : '—'); setT('dmmUnit', r ? (r.ol ? '' : r.unit) : FN_UNIT[fn]);
    setT('dmmUnc', r && !r.ol ? LAB.t('conn.unc', { u: fmt(r.unc, r.res < 0.01 ? 3 : 2), unit: r.unit, range: r.range }) : r && r.ol ? LAB.t('conn.overload') : '');
    const sdm = LAB.sim.pv.sdm();
    setT('dmmRef', LAB.t('conn.ref', { voc: fmt(sdm.Voc, 1), isc: fmt(sdm.Isc, 1) }));
    if (tel) live();
  }

  ui.connections = { init, update, render, get busy() { return !!meas; } };
})();
