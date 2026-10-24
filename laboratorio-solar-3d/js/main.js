/* Arranque: renderizador, postproceso (HDR + bloom + mapeo tonal), bucle principal y conexion con la interfaz. */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const canvasHost = document.getElementById('stage');

  // ------------------------------------------------------------ renderizador
  let renderer;
  try {
    if (params.get('glfail')) throw new Error('Falla de WebGL simulada con ?glfail (prueba)');
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    if (!renderer.getContext()) throw new Error('El navegador devolvió un contexto WebGL vacío');
  } catch (err) {
    // C20: sin WebGL no se puede dibujar el banco; se explica con claridad y se ofrece reintentar, sin pantalla en blanco
    const box = document.getElementById('glFail'); if (box) { box.hidden = false; const w = document.getElementById('glFailWhy'); if (w) w.textContent = LAB.t('main.detalle') + String(err && err.message || err).slice(0, 200); }
    const go = (q) => { const u = new URL(location.href); u.searchParams.delete('glfail'); if (q) u.searchParams.set('q', q); location.href = u.href; };
    const r = document.getElementById('glRetry'), l = document.getElementById('glLow'); if (r) r.onclick = () => go(); if (l) l.onclick = () => go('low');
    if (r) r.focus();
    window.__labGlFailed = true; console.warn('WebGL no disponible:', err);
    return;
  }
  // Calidad adaptativa: 'auto' baja o sube el nivel segun los cuadros por segundo reales de cada equipo
  const LEVELS = {
    high: { dpr: 2, shadow: 4096, samples: 4, bloom: true },
    medium: { dpr: 1.25, shadow: 2048, samples: 2, bloom: true },
    low: { dpr: 1, shadow: 1024, samples: 2, bloom: false },
  };
  const quality = { level: LEVELS[params.get('q')] ? params.get('q') : 'high', auto: !params.get('q'), slowT: 0, fastT: 0 };
  const dpr = () => Math.min(window.devicePixelRatio || 1, LEVELS[quality.level].dpr);
  renderer.setPixelRatio(dpr());
  renderer.outputEncoding = THREE.LinearEncoding;          // el mapeo tonal y la gamma los hace el pase final
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 1);
  canvasHost.appendChild(renderer.domElement);
  const gl = renderer.getContext();
  const isGL2 = renderer.capabilities.isWebGL2;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);

  // ------------------------------------------------------------- datos y mundo
  // Fuente de datos: sim (por omision), ws (banco real por la pasarela), twin (modelo con el ambiente medido) o replay (?run=ID).
  const srcKind = params.get('source') || (LAB.deploy && LAB.deploy.source) || 'sim';
  const source = LAB.data.createSource(['ws', 'real', 'twin', 'replay'].includes(srcKind) ? srcKind : 'sim', { apiBase: (LAB.deploy && LAB.deploy.apiBase) || '' });
  LAB.data.source = source;
  const netSource = source.kind === 'ws' ? source : source.kind === 'twin' ? source.ws : null;
  document.body.classList.add('src-' + (source.kind || 'sim'));
  const world = new LAB.scene.World(renderer, camera, canvasHost);
  const rig = new LAB.scene.CameraRig(camera, canvasHost, world);
  LAB.world = world; LAB.rig = rig;

  // ----------------------------------------------------------- postproceso
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType };
  const msaa = isGL2;
  const rtMain = msaa ? new THREE.WebGLMultisampleRenderTarget(size.x, size.y, rtOpts) : new THREE.WebGLRenderTarget(size.x, size.y, rtOpts);
  if (msaa) rtMain.samples = LEVELS[quality.level].samples;
  const rtB = new THREE.WebGLRenderTarget(size.x, size.y, rtOpts);
  const composer = new THREE.EffectComposer(renderer, rtB);
  composer.renderTarget2 = rtMain; composer.readBuffer = rtMain; composer.writeBuffer = rtB;
  composer.setPixelRatio && composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new THREE.RenderPass(world.scene, camera);
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 1.05);
  const pipRT = new THREE.WebGLRenderTarget(640, 360, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType });
  const pip = { on: false, cam: 'cam2', rect: new THREE.Vector4(0.015, 0.03, 0.22, 0.22) };

  const FinalShader = {
    uniforms: {
      tDiffuse: { value: null }, tPip: { value: pipRT.texture }, pipRect: { value: pip.rect }, pipOn: { value: 0 },
      exposure: { value: 1.0 }, time: { value: 0 }, vignette: { value: 0.28 }, aspect: { value: 1 }, pov: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse, tPip; uniform vec4 pipRect; uniform float pipOn, exposure, time, vignette, aspect, pov;
      varying vec2 vUv;
      vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        vec2 pu = (vUv - pipRect.xy) / pipRect.zw;
        bool inPip = pipOn > 0.5 && pu.x >= 0.0 && pu.x <= 1.0 && pu.y >= 0.0 && pu.y <= 1.0;
        float edge = 0.0;
        if (inPip) {
          c = texture2D(tPip, pu).rgb;
          float sl = 0.92 + 0.08 * sin(pu.y * 520.0 + time * 3.0);
          c *= sl; c += (hash(pu * 900.0 + time) - 0.5) * 0.03;
          c = mix(vec3(dot(c, vec3(0.3,0.59,0.11))), c, 0.8) * vec3(0.96, 1.0, 1.04);
        } else if (pipOn > 0.5) {
          vec2 q = (vUv - pipRect.xy) / pipRect.zw;
          vec2 e = min(q, 1.0 - q);
          if (q.x > -0.012 && q.x < 1.012 && q.y > -0.02 && q.y < 1.02) edge = 1.0;
        }
        c *= exposure;
        c = aces(c);
        vec2 d = vUv - 0.5; d.x *= aspect;
        float vg = 1.0 - vignette * smoothstep(0.35, 1.05, length(d));
        if (!inPip) c *= vg;
        if (pov > 0.5) { c = mix(vec3(dot(c, vec3(0.3,0.59,0.11))), c, 0.85); c += (hash(vUv * 1200.0 + time) - 0.5) * 0.025; c *= 0.93 + 0.07 * sin(vUv.y * 700.0); }
        c = pow(c, vec3(1.0 / 2.2));
        if (edge > 0.5) c = vec3(0.18, 0.7, 1.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  };
  const finalPass = new THREE.ShaderPass(FinalShader);
  // ShaderPass clona los uniformes: se vuelve a enlazar la textura y el rectangulo de la vista previa (antes la vista previa salia negra)
  finalPass.uniforms.tPip.value = pipRT.texture; finalPass.uniforms.pipRect.value = pip.rect;
  finalPass.renderToScreen = true;
  composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(finalPass);

  function resize() {
    const w = canvasHost.clientWidth, h = canvasHost.clientHeight;
    renderer.setPixelRatio(dpr());
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    const pr = renderer.getPixelRatio();
    composer.setPixelRatio(pr); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    world.labels.resize(w, h);
    finalPass.uniforms.aspect.value = w / h;
    pipRT.setSize(Math.round(Math.min(960, w * 0.3)), Math.round(Math.min(960, w * 0.3) * 9 / 16));
    pip.rect.set(0.015, 0.03 * (1280 / Math.max(h, 400)), 0.25, 0.25 * (w / h) * 9 / 16);
    if (onResized) onResized();
  }
  let onResized = null;
  /** Franja superior del escenario que cubre la barra de vistas: las vistas predefinidas dejan libre ese espacio */
  function syncInsets() {
    const vb = document.getElementById('viewbar'), r = canvasHost.getBoundingClientRect();
    let top = 0;
    if (vb && vb.offsetParent !== null && r.height > 40) { const b = vb.getBoundingClientRect(); top = Math.max(0, Math.min(0.4, (b.bottom - r.top + 6) / r.height)); }
    world.insets.top = top; rig.refit();
  }
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) { const ro = new ResizeObserver(resize); ro.observe(canvasHost); const vb = document.getElementById('viewbar'); if (vb) ro.observe(vb); }   // la escena sigue a su contenedor, no solo a la ventana
  onResized = syncInsets;
  resize();

  function applyQuality(level) {
    quality.level = level;
    const L = LEVELS[level];
    bloom.enabled = L.bloom;
    if (msaa) { rtMain.samples = L.samples; rtMain.dispose(); }
    const sh = world.env.sun.shadow;
    sh.mapSize.set(L.shadow, L.shadow);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
    resize();
    if (LAB.ui.onQuality) LAB.ui.onQuality(quality);
  }
  function adapt(dtRaw) {
    if (!quality.auto || document.hidden) return;
    const order = ['high', 'medium', 'low'], i = order.indexOf(quality.level);
    if (dtRaw > 0.045) { quality.slowT += dtRaw; quality.fastT = 0; } else if (dtRaw < 0.022) { quality.fastT += dtRaw; quality.slowT = Math.max(0, quality.slowT - dtRaw); } else { quality.slowT = 0; quality.fastT = 0; }
    if (quality.slowT > 2.5 && i < 2) { quality.slowT = 0; applyQuality(order[i + 1]); }
    else if (quality.fastT > 20 && i > 0) { quality.fastT = 0; applyQuality(order[i - 1]); }
  }
  applyQuality(quality.level);

  // --------------------------------------------------------- interaccion 3D
  let downAt = null;
  canvasHost.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvasHost.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    const id = world.picker.pick(e);
    if (id === 'estop') { handlePart('estop', true); return; }
    handlePart(id, false);
  });
  canvasHost.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const id = world.picker.pick(e);
    world.setHover(id);
    canvasHost.style.cursor = id ? 'pointer' : '';
  });
  world.labels.onClick = (id) => handlePart(id, false);

  function handlePart(id, press) {
    if (id === 'estop' && press) {
      if (source.telemetry.safety.estop) { LAB.ui.toast && LAB.ui.toast(LAB.t('main.restablecer_llave')); }
      else source.send({ type: 'safety.estop', who: 'Operador en sitio (clic en el paro)' });
    }
    world.select(id);
    if (LAB.ui.showPart) LAB.ui.showPart(id);
  }

  // ----------------------------------------------------------------- bucle
  let last = performance.now(), frame = 0, fpsAcc = 0, fpsN = 0;
  const api = {
    renderer, camera, world, rig, source, composer, bloom, finalPass, pip, pipRT, quality, handlePart, applyQuality, LEVELS,
    setPip(on, cam) { pip.on = !!on; if (cam) pip.cam = cam; finalPass.uniforms.pipOn.value = pip.on ? 1 : 0; },
    fps: 60, get glLost() { return glLost; },
  };
  LAB.app = api;

  // C20: pérdida y restauración del contexto gráfico. El simulador sigue calculando; solo se detiene el dibujo hasta recuperarlo.
  let glLost = false;
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); glLost = true;
    const b = document.getElementById('glLost'); if (b) b.hidden = false;
    source.log('warn', LAB.t('main.contexto_perdido'), 'Gráficos');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    glLost = false; const b = document.getElementById('glLost'); if (b) b.hidden = true;
    renderer.shadowMap.needsUpdate = true; applyQuality(quality.level);
    source.log('ok', LAB.t('main.contexto_restaurado'), 'Gráficos');
  });
  { const rl = document.getElementById('glReload'); if (rl) rl.addEventListener('click', () => location.reload()); }

  function render(dt, now) {
    if (glLost) return;
    const tel = source.telemetry;
    // exposicion: la camara se adapta de forma suave al dia y a la noche
    const dayF = world.env.dayFactor;
    const target = 0.95 + (1 - dayF) * 2.0;
    finalPass.uniforms.exposure.value += (target - finalPass.uniforms.exposure.value) * Math.min(1, dt * 2);
    finalPass.uniforms.time.value = now / 1000 % 100;
    finalPass.uniforms.pov.value = rig.pov ? 1 : 0;
    finalPass.uniforms.pipOn.value = pip.on && !rig.pov ? 1 : 0;   // en modo camara IP la vista previa no se dibuja (no tiene imagen propia)
    bloom.strength = 0.22 + 0.18 * (1 - dayF);
    renderer.shadowMap.needsUpdate = true;
    if (pip.on && !rig.pov) {
      renderer.setRenderTarget(pipRT);
      renderer.render(world.scene, world.camPov(pip.cam));
      renderer.setRenderTarget(null);
    }
    composer.render(dt);
    world.labels.render(camera);
    void tel;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const dtRaw = (now - last) / 1000, dt = Math.min(0.1, dtRaw); last = now;
    adapt(dtRaw);
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { api.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    // el reloj sigue al tiempo real aunque los cuadros salgan lentos: se integra en pasos de <= 0.1 s (tope 5 s tras una pausa larga de la pestana)
    for (let rest = Math.min(5, dtRaw); rest > 1e-6;) { const k = Math.min(0.1, rest); source.step(k); rest -= k; }
    const tel = source.telemetry;
    world.update(tel, dt);
    rig.update(dt);
    if (LAB.ui.update) LAB.ui.update(tel, dt, now);
    render(dt, now);
    frame++;
  }

  if (LAB.ui.init) LAB.ui.init(api);
  // parametros de URL para enlaces directos y pruebas: ?view=moduleB&time=2026-06-21T12:00&speed=60&cloud=0.4&pip=1
  if (source.kind === 'replay') {
    source.on('auth', () => { location.href = ((LAB.deploy && LAB.deploy.loginUrl) || 'login.html') + '?next=' + encodeURIComponent(location.pathname + location.search); });
    if (params.get('run')) source.loadFromServer(params.get('run'), { apiBase: (LAB.deploy && LAB.deploy.apiBase) || '' });
    else source.log('warn', LAB.t('main.falta_run'), 'Reproducción');
  }
  if (netSource) {
    netSource.on('auth', () => { location.href = ((LAB.deploy && LAB.deploy.loginUrl) || 'login.html') + '?next=' + encodeURIComponent(location.pathname + location.search); });
    netSource.loginState().then(() => netSource.connect());
  }
  const simLocal = !source.kind || source.kind === 'sim';
  if (!simLocal) { /* los parametros time/speed/cloud/wind son del simulador */ } else {
  if (params.get('time')) { const m = params.get('time').match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/); if (m) source.send({ type: 'sim.time', ms: LAB.fromLocal(+m[1], +m[2], +m[3], +m[4], +m[5]) }); }
  if (params.get('speed')) source.send({ type: 'sim.speed', speed: +params.get('speed') });
  if (params.get('cloud')) source.send({ type: 'sim.cloud', value: +params.get('cloud') });
  if (params.get('wind')) source.send({ type: 'sim.wind', value: +params.get('wind') });
  }
  if (params.get('view')) rig.set(params.get('view'), true);
  if (params.get('pip')) api.setPip(true, params.get('pip') === '1' ? 'cam2' : params.get('pip'));
  if (params.get('labels') === '0') world.labels.setVisible(false);
  window.__labReady = true;
  requestAnimationFrame(loop);
  void gl;
})();
