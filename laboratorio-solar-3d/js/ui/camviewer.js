/* Visor de cámaras IP del banco real (HLS). MediaMTX publica cada cámara en /cam/<id>/index.m3u8 detrás de Nginx con sesión.
 * Solo se descarga y reproduce el flujo de la cámara elegida y solo mientras el panel está abierto. Si no hay flujo se dice
 * con claridad; nunca se dibuja una imagen de relleno que pueda confundirse con video real. */
(function () {
  'use strict';
  const LAB = (window.LAB = window.LAB || {});
  const $ = (s) => document.querySelector(s);
  const RETRY_S = 5, STALL_MS = 8000, HLS_SRC = 'js/lib/hls.min.js';
  const base = () => ((LAB.deploy && LAB.deploy.apiBase) || '') + '/cam/';
  const urlOf = (id) => base() + id + '/index.m3u8';

  let hlsLib = null, hls = null, current = null, retryT = null, stallT = null, bound = false, opened = false;

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLib) return hlsLib;
    hlsLib = new Promise((res) => {
      const s = document.createElement('script'); s.src = HLS_SRC;
      s.onload = () => res(window.Hls || null); s.onerror = () => res(null);
      document.head.appendChild(s);
    });
    return hlsLib;
  }

  function status(kind) {
    const st = $('#camStatus'), live = $('#camLive'), view = $('#camView');
    const msg = { connecting: LAB.t('real.cam_conectando'), none: LAB.t('real.cam_sin_flujo') + ' ' + LAB.t('real.cam_reintento', { s: RETRY_S }), nosupport: LAB.t('real.cam_sin_soporte'), live: '' }[kind] || '';
    st.textContent = msg; st.hidden = !msg; live.hidden = kind !== 'live';
    view.dataset.state = kind;
  }

  function teardown() {
    clearTimeout(retryT); clearTimeout(stallT); retryT = stallT = null;
    if (hls) { try { hls.destroy(); } catch (e) { /* ya liberado */ } hls = null; }
    const v = $('#camVideo'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  }

  function failed() {
    teardown(); status('none');
    if (opened) retryT = setTimeout(() => { if (opened) start(current); }, RETRY_S * 1000);
  }

  async function start(id) {
    teardown(); current = id || current || 'cam1'; status('connecting');
    const v = $('#camVideo'), url = urlOf(current);
    const onPlaying = () => { clearTimeout(stallT); status('live'); };
    v.onplaying = onPlaying;
    v.onerror = failed; v.onstalled = null;
    const Hls = await loadHls();
    if (!opened) return;
    if (Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 1 });
      hls.on(Hls.Events.ERROR, (e, data) => { if (data && data.fatal) failed(); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { const p = v.play(); if (p && p.catch) p.catch(() => { /* el navegador pidió interacción; el video queda con controles ocultos pero cargado */ }); });
      hls.loadSource(url); hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; const p = v.play(); if (p && p.catch) p.catch(() => {});
    } else { status('nosupport'); return; }
    stallT = setTimeout(failed, STALL_MS);      // si en este tiempo no se reproduce nada, se considera sin flujo
  }

  function select(id) {
    document.querySelectorAll('#camTabs button').forEach((b) => { const on = b.dataset.cam === id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (opened) start(id); else current = id;
  }

  function open(id) {
    bind(); opened = true; $('#camPanel').hidden = false; $('#btnIpCam').classList.add('on'); $('#btnIpCam').setAttribute('aria-pressed', 'true');
    select(id || current || 'cam1');
  }
  function close() {
    opened = false; teardown(); $('#camPanel').hidden = true; $('#btnIpCam').classList.remove('on'); $('#btnIpCam').setAttribute('aria-pressed', 'false');
  }
  function toggle() { if (opened) close(); else open(); }

  function bind() {
    if (bound) return; bound = true;
    $('#camTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) select(b.dataset.cam); });
    $('#camClose').addEventListener('click', close);
  }

  /** moving: el seguidor se está moviendo; se resalta la cámara que lo enfoca (cam2) */
  function setMoving(on) {
    const p = $('#camPanel'); if (!p) return;
    const hot = !!on && current === 'cam2';
    p.classList.toggle('hot', hot); $('#camMove').hidden = !on;
  }

  LAB.ui = LAB.ui || {};
  LAB.ui.camviewer = { open, close, toggle, select, setMoving, isOpen: () => opened, urlOf };
})();
