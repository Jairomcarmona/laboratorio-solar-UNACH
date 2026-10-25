/* Control 3D del seguidor (banco real): un panel solar que se arrastra para preparar azimut e inclinación.
 * Muestra la posición MEDIDA (panel sólido) y el objetivo preparado (panel fantasma). Arrastrar no envía nada:
 * solo cambia el objetivo preparado; el envío lo hace el botón «Mover». Render propio y pequeño, independiente de la escena grande. */
(function () {
  'use strict';
  const LAB = (window.LAB = window.LAB || {});
  const D2R = Math.PI / 180;
  const PX_PER_DEG_AZ = 2.2, PX_PER_DEG_TILT = 2.6;      // píxeles de arrastre por grado

  function cellsTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#17306b'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = 'rgba(190,215,255,.55)'; g.lineWidth = 1;
    for (let x = 0; x <= 256; x += 256 / 12) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    for (let y = 0; y <= 128; y += 128 / 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  }
  function label(text, color) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = color; g.font = '700 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 32, 34);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
    s.scale.set(0.34, 0.34, 1); return s;
  }

  function create(host, opts) {
    if (!window.THREE || !host) return null;
    const M = LAB.config.module, T = LAB.config.tracker;
    const W = host.clientWidth || 320, H = host.clientHeight || 220;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return null; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W, H);
    renderer.domElement.setAttribute('aria-hidden', 'true'); renderer.domElement.style.touchAction = 'none'; renderer.domElement.style.cursor = 'grab';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(36, W / H, 0.1, 50);
    cam.position.set(0, 3.1, 5.2); cam.lookAt(0, 0.75, 0);       // se mira desde el sur hacia el norte (-Z): el este queda a la derecha
    scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a2a44, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(2.5, 5, 3); scene.add(sun);

    // suelo con aro de rumbos
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.16, 96), new THREE.MeshBasicMaterial({ color: 0x6ea8ff, transparent: true, opacity: .6, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; scene.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.1, 64), new THREE.MeshBasicMaterial({ color: 0x0b1d3a, transparent: true, opacity: .75 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -0.005; scene.add(disc);
    const tick = (az, txt, col) => { const a = az * D2R, s = label(txt, col); s.position.set(Math.sin(a) * 2.45, 0.05, -Math.cos(a) * 2.45); scene.add(s); };
    tick(0, 'N', '#ff6b6b'); tick(90, 'E', '#e8f0f8'); tick(180, 'S', '#e8f0f8'); tick(270, 'O', '#e8f0f8');
    // sector permitido de azimut (90°–270°)
    const sector = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.05, 64, 1, 0, Math.PI), new THREE.MeshBasicMaterial({ color: 0x35d07f, transparent: true, opacity: .45, side: THREE.DoubleSide }));
    sector.rotation.x = -Math.PI / 2; sector.rotation.z = Math.PI; sector.position.y = 0.002; scene.add(sector);
    // base y mástil
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: .8, roughness: .4 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.0, 16), steel); pole.position.y = 0.5; scene.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.46, 0.1, 24), steel); base.position.y = 0.05; scene.add(base);

    const L = M.long * 0.62, S = M.short * 0.62, th = 0.05;
    const tex = cellsTexture();
    const glass = new THREE.MeshStandardMaterial({ map: tex, metalness: .3, roughness: .25 });
    const frame = new THREE.MeshStandardMaterial({ color: 0xcfd5dc, metalness: .9, roughness: .35 });
    const solid = new THREE.Mesh(new THREE.BoxGeometry(L, th, S), [frame, frame, glass, frame, frame, frame]);
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(L, th, S), new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: .38, depthWrite: false }));
    ghost.add(new THREE.LineSegments(new THREE.EdgesGeometry(ghost.geometry), new THREE.LineBasicMaterial({ color: 0xffb020 })));
    const pivot = new THREE.Group(); pivot.position.y = 1.05; scene.add(pivot);
    const gpivot = new THREE.Group(); gpivot.position.y = 1.05; scene.add(gpivot);
    pivot.add(solid); gpivot.add(ghost);
    for (const p of [pivot, gpivot]) p.rotation.order = 'YXZ';

    // normal de la cara activa: flecha hacia donde mira el panel
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 0.7, 0xffd48a, 0.16, 0.1); solid.add(arrow);

    const pose = (grp, az, tilt) => { grp.rotation.y = -az * D2R; grp.rotation.x = -tilt * D2R; };
    let cur = { az: 180, tilt: 17 }, tgt = { az: 180, tilt: 17 }, enabled = true, raf = 0, last = 0, drag = null;

    function frameLoop(now) {
      raf = requestAnimationFrame(frameLoop);
      if (document.hidden || host.offsetParent === null) return;
      if (now - last < 33) return; last = now;
      pose(pivot, Number.isFinite(cur.az) ? cur.az : 180, Number.isFinite(cur.tilt) ? cur.tilt : 0);
      pose(gpivot, tgt.az, tgt.tilt);
      renderer.render(scene, cam);
    }

    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => { if (!enabled) return; drag = { x: e.clientX, y: e.clientY, az: tgt.az, tilt: tgt.tilt }; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const az = Math.max(T.azMin, Math.min(T.azMax, drag.az + (e.clientX - drag.x) / PX_PER_DEG_AZ));
      const tilt = Math.max(T.tiltMin, Math.min(T.tiltMax, drag.tilt - (e.clientY - drag.y) / PX_PER_DEG_TILT));
      if (opts && opts.onTarget) opts.onTarget(Math.round(az), Math.round(tilt));
    });
    const end = (e) => { drag = null; el.style.cursor = enabled ? 'grab' : 'not-allowed'; try { el.releasePointerCapture(e.pointerId); } catch (x) { /* ya liberado */ } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
    }) : null;
    if (ro) ro.observe(host);
    raf = requestAnimationFrame(frameLoop);

    return {
      setCurrent(az, tilt) { cur = { az, tilt }; },
      setTarget(az, tilt) { if (Number.isFinite(az) && Number.isFinite(tilt)) tgt = { az, tilt }; },
      setEnabled(on) { enabled = !!on; el.style.cursor = enabled ? 'grab' : 'not-allowed'; el.style.opacity = enabled ? '1' : '.75'; },
      dispose() { cancelAnimationFrame(raf); if (ro) ro.disconnect(); renderer.dispose(); el.remove(); },
    };
  }

  LAB.ui = LAB.ui || {};
  LAB.ui.pose3d = { create };
})();
