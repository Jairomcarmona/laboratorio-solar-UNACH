/* Etiquetas 3D (CSS2D), seleccion por clic/hover y ficha informativa de cada componente. */
(function () {
  'use strict';
  const { fmt } = LAB.util;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  /** Informacion didactica de cada componente + variables en vivo que se muestran en la ficha. */
  const INFO = {
    moduleA: {
      get title() { return LAB.t('labels.modulo_a_fijo_de'); }, get kind() { return LAB.t('labels.kind_generacion'); }, get color() { return LAB.config.palette.A; },
      get text() { return LAB.t('labels.modulo_comercial_de_500'); },
      live: (t) => [[LAB.t('labels.irradiancia_plano'), fmt(t.A.poa, 0) + ' W/m²'], [LAB.t('labels.temp_de_celda'), fmt(t.A.tcell, 1) + ' °C'], [LAB.t('labels.potencia'), fmt(t.A.p, 0) + ' W'], [LAB.t('labels.energia'), fmt(t.A.wh, 1) + ' Wh']],
    },
    moduleB: {
      get title() { return LAB.t('labels.modulo_b_movil_de'); }, get kind() { return LAB.t('labels.kind_generacion'); }, get color() { return LAB.config.palette.B; },
      get text() { return LAB.t('labels.modulo_identico_al_a'); },
      live: (t) => [[LAB.t('labels.azimut'), fmt(t.B.az, 1) + '°'], [LAB.t('labels.inclinacion'), fmt(t.B.tilt, 1) + '°'], [LAB.t('labels.irradiancia_en_el_plano'), fmt(t.B.poa, 0) + ' W/m²'], [LAB.t('labels.potencia'), fmt(t.B.p, 0) + ' W'], [LAB.t('labels.diferencia_de_potencia_vs'), t.comparison.powerDiffPct == null ? LAB.t('labels.no_disponible') : fmt(t.comparison.powerDiffPct, 1) + ' %']],
    },
    irrA: {
      get title() { return LAB.t('labels.sensor_de_irradiancia_plano'); }, get kind() { return LAB.t('labels.kind_medicion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.mide_la_irradiancia_en'); },
      live: (t) => [[LAB.t('labels.irradiancia'), fmt(t.A.poa, 0) + ' W/m²'], [LAB.t('labels.angulo_de_incidencia'), fmt(t.A.aoi, 1) + '°']],
    },
    irrB: {
      get title() { return LAB.t('labels.sensor_de_irradiancia_plano_2'); }, get kind() { return LAB.t('labels.kind_medicion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.igual_que_el_del'); },
      live: (t) => [[LAB.t('labels.irradiancia'), fmt(t.B.poa, 0) + ' W/m²'], [LAB.t('labels.angulo_de_incidencia'), fmt(t.B.aoi, 1) + '°']],
    },
    pyr: {
      get title() { return LAB.t('labels.piranometro_referencia_ambiental'); }, get kind() { return LAB.t('labels.kind_meteorologia'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.mide_la_irradiancia_global'); },
      live: (t) => [[LAB.t('labels.ghi_medida_simulada'), fmt(t.env.ghi, 0) + ' W/m²'], [LAB.t('labels.dni_derivada_del_modelo'), fmt(t.env.dni, 0) + ' W/m²'], [LAB.t('labels.dhi_derivada_del_modelo'), fmt(t.env.dhi, 0) + ' W/m²']],
    },
    anemo: {
      get title() { return LAB.t('labels.anemometro_y_veleta'); }, get kind() { return LAB.t('labels.kind_meteorologia'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.velocidad_y_direccion_del'); },
      live: (t) => [[LAB.t('labels.velocidad'), fmt(t.env.wind, 1) + ' m/s'], [LAB.t('labels.direccion_de_donde_sopla'), fmt(t.env.windDir, 0) + '°'], [LAB.t('labels.umbral_de_seguridad'), LAB.config.safety.windStow + ' m/s']],
    },
    shield: {
      get title() { return LAB.t('labels.temperatura_y_humedad_relativa'); }, get kind() { return LAB.t('labels.kind_meteorologia'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.sensor_protegido_por_un'); },
      live: (t) => [[LAB.t('labels.temp_ambiente'), fmt(t.env.ta, 1) + ' °C'], [LAB.t('labels.humedad_relativa'), fmt(t.env.rh, 0) + ' %']],
    },
    rain: {
      get title() { return LAB.t('labels.pluviometro'); }, get kind() { return LAB.t('labels.kind_meteorologia'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.registra_la_lluvia_acumulada'); },
      live: (t) => [[LAB.t('labels.estado'), t.env.rain ? LAB.t('labels.lloviendo') + LAB.sim.RAIN_LEVELS[t.env.rainLevel].name.toLowerCase() : LAB.t('labels.seco')], [LAB.t('labels.intensidad'), fmt(t.env.rainRate, 1) + ' mm/h'], [LAB.t('labels.acumulado'), fmt(t.env.rainMm, 2) + ' mm']],
    },
    load: {
      get title() { return LAB.t('labels.carga_electronica_programable_cc'); }, get kind() { return LAB.t('labels.kind_caracterizacion'); }, color: '#a98bff',
      get text() { return LAB.t('labels.impone_el_punto_de'); },
      live: (t) => [[LAB.t('labels.modo'), { oc: LAB.t('labels.circuito_abierto'), sc: LAB.t('labels.cortocircuito'), cv: LAB.t('labels.tension_const'), cr: LAB.t('labels.resistencia'), mppt: 'MPPT' }[t.load.mode] || t.load.mode], [LAB.t('labels.p_total'), fmt(t.A.p + t.B.p, 0) + ' W']],
    },
    cabinet: {
      get title() { return LAB.t('labels.gabinete_de_control_y'); }, get kind() { return LAB.t('labels.kind_control_local'); }, color: '#ff6b6b',
      get text() { return LAB.t('labels.aloja_el_ni_cdaq'); },
      live: (t) => [[LAB.t('labels.estado_de_seguridad'), { NORMAL: LAB.t('labels.normal'), WIND_STOW: LAB.t('labels.posicion_segura_viento'), COMMS_STOW: LAB.t('labels.posicion_segura_watchdog'), ESTOP: LAB.t('labels.paro_de_emergencia') }[t.safety.state]], [LAB.t('labels.latencia_del_enlace'), fmt(t.comms.latency, 0) + ' ms']],
    },
    estop: {
      get title() { return LAB.t('labels.paro_de_emergencia_local'); }, get kind() { return LAB.t('labels.kind_seguridad'); }, color: '#ff4d4d',
      get text() { return LAB.t('labels.corta_la_energia_de'); },
      live: (t) => [[LAB.t('labels.estado'), t.safety.estop ? LAB.t('labels.accionado') : LAB.t('labels.normal')]],
    },
    cam1: {
      get title() { return LAB.t('labels.camara_ip_1_vista'); }, get kind() { return LAB.t('labels.kind_observacion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.permite_verificar_visualmente_el'); },
      live: () => [[LAB.t('labels.resolucion'), '1080p · 15 fps (simulado)']],
    },
    cam2: {
      get title() { return LAB.t('labels.camara_ip_2_vista'); }, get kind() { return LAB.t('labels.kind_observacion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.apunta_al_modulo_movil'); },
      live: (t) => [[LAB.t('labels.posicion_del_seguidor'), `${fmt(t.B.az, 0)}° / ${fmt(t.B.tilt, 0)}°`]],
    },
    azAxis: {
      get title() { return LAB.t('labels.eje_de_azimut_giro'); }, get kind() { return LAB.t('labels.kind_movimiento'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.motorreductor_con_realimentacion_de'); },
      live: (t) => [[LAB.t('labels.azimut'), fmt(t.tracker.az, 1) + '°'], [LAB.t('labels.objetivo'), fmt(t.tracker.targetAz, 1) + '°'], [LAB.t('labels.rango'), `${t.tracker.limits.azMin}°–${t.tracker.limits.azMax}°`]],
    },
    tiltAxis: {
      get title() { return LAB.t('labels.eje_de_inclinacion_elevacion'); }, get kind() { return LAB.t('labels.kind_movimiento'); }, color: '#35d07f',
      get text() { return LAB.t('labels.actuador_lineal_que_inclina'); },
      live: (t) => [[LAB.t('labels.inclinacion'), fmt(t.tracker.tilt, 1) + '°'], [LAB.t('labels.objetivo'), fmt(t.tracker.targetTilt, 1) + '°'], [LAB.t('labels.rango'), `${t.tracker.limits.tiltMin}°–${t.tracker.limits.tiltMax}°`]],
    },
    dcA: {
      get title() { return LAB.t('labels.medicion_electrica_cc_modulo'); }, get kind() { return LAB.t('labels.kind_medicion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.transductores_aislados_de_tension'); },
      live: (t) => [['V', fmt(t.A.v, 1) + ' V'], ['I', fmt(t.A.i, 2) + ' A'], ['P', fmt(t.A.p, 0) + ' W']],
    },
    dcB: {
      get title() { return LAB.t('labels.medicion_electrica_cc_modulo_2'); }, get kind() { return LAB.t('labels.kind_medicion'); }, color: '#2fb4ff',
      get text() { return LAB.t('labels.misma_instrumentacion_que_el'); },
      live: (t) => [['V', fmt(t.B.v, 1) + ' V'], ['I', fmt(t.B.i, 2) + ' A'], ['P', fmt(t.B.p, 0) + ' W']],
    },
  };

  class Labels {
    constructor(scene, container) {
      this.scene = scene;
      this.renderer = new THREE.CSS2DRenderer();
      this.renderer.domElement.className = 'labels-layer';
      container.appendChild(this.renderer.domElement);
      this.items = [];
      this.mode = 'main';          // 'main' (principales + detalle cercano), 'all', 'off'
      this.onClick = null;
      this.tmp = new THREE.Vector3();
    }
    resize(w, h) { this.renderer.setSize(w, h); }
    /** opts.detail: la etiqueta solo aparece cuando la camara esta cerca (o en modo 'all') */
    add(partId, parent, localPos, text, opts = {}) {
      const wrap = document.createElement('div');
      wrap.className = 'tag-wrap';
      const el = document.createElement('button');
      el.className = 'tag' + (opts.cls ? ' ' + opts.cls : '');
      el.type = 'button';
      const key = /^lbl\./.test(text) ? text : null;      // las etiquetas fijas se guardan por clave para poder retraducirlas
      el.innerHTML = `<i class="dot"></i><span>${key ? LAB.t(key) : text}</span>`;
      el.dataset.part = partId;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (this.onClick) this.onClick(partId); });
      wrap.appendChild(el);
      const obj = new THREE.CSS2DObject(wrap);
      obj.position.copy(localPos);
      parent.add(obj);
      this.items.push({ el, wrap, obj, partId, key, detail: !!opts.detail, track: opts.track || null, parent });
      return el;
    }
    /** Vuelve a escribir las etiquetas con el idioma activo */
    relabel() { this.items.forEach((i) => { if (i.key) i.el.innerHTML = `<i class="dot"></i><span>${LAB.t(i.key)}</span>`; }); }
    setMode(mode) {
      this.mode = mode;
      this.renderer.domElement.style.display = mode === 'off' ? 'none' : '';
    }
    setVisible(v) { this.setMode(v ? 'main' : 'off'); }
    render(camera) {
      if (this.mode === 'off') return;
      const cp = camera.position;
      for (const it of this.items) {
        if (it.track) {   // el ancla acompana a la pieza que se mueve (con desplazamiento en vertical del mundo)
          if (it.track.local) this.tmp.set(...it.track.offset).applyMatrix4(it.track.object.matrixWorld);   // desplazamiento en el marco de la pieza
          else { it.track.object.getWorldPosition(this.tmp); this.tmp.x += it.track.offset[0]; this.tmp.y += it.track.offset[1]; this.tmp.z += it.track.offset[2]; }
          it.parent.worldToLocal(this.tmp); it.obj.position.copy(this.tmp);
        }
        it.obj.getWorldPosition(this.tmp);
        const d = this.tmp.distanceTo(cp);
        let o = 1;
        if (it.detail && this.mode !== 'all' && !it.active) o = 1 - LAB.util.smoothstep(6.5, 9.5, d);
        if (!it.detail) o = 1 - LAB.util.smoothstep(38, 60, d);
        it.d = d; it.o = o;
        it.el.style.opacity = o.toFixed(2);
        it.el.style.visibility = o < 0.05 ? 'hidden' : 'visible';
      }
      if ((this.frame = (this.frame || 0) + 1) % 4 === 0) this.declutter(camera);
      this.renderer.render(this.scene, camera);
    }
    /** Evita que las etiquetas se pisen: por prioridad (activa, principales, cercanas) cada una sube hasta quedar libre;
     *  si no cabe, se atenúa (nunca la activa). Se calcula con la geometría real de las pastillas en pantalla. */
    declutter(camera) {
      const dom = this.renderer.domElement, W = dom.clientWidth, H = dom.clientHeight;
      if (!W || !H) return;
      const vis = this.items.filter((i) => i.o > 0.05 && i.el.offsetWidth > 0);
      vis.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (a.detail ? 1 : 0) - (b.detail ? 1 : 0) || a.d - b.d);
      const placed = [], v = new THREE.Vector3();
      const hit = (r) => placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      for (const it of vis) {
        it.obj.getWorldPosition(v); v.project(camera);
        if (v.z > 1) { it.el.style.setProperty('--dy', '0px'); continue; }
        const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H, w = it.el.offsetWidth, h = it.el.offsetHeight;
        let dy = 0, ok = false;
        for (let k = 0; k < 4; k++) {
          const r = { x0: sx - w / 2, x1: sx + w / 2, y0: sy - 14 - h + dy, y1: sy - 14 + dy };
          if (!hit(r)) { placed.push(r); ok = true; break; }
          dy -= h + 4;
        }
        if (!ok && !it.active) { it.el.style.opacity = '0'; it.el.style.pointerEvents = 'none'; it.el.style.setProperty('--dy', '0px'); continue; }
        if (!ok) { dy = 0; placed.push({ x0: sx - w / 2, x1: sx + w / 2, y0: sy - 14 - h, y1: sy - 14 }); }
        it.el.style.pointerEvents = '';
        it.el.style.setProperty('--dy', dy + 'px');
      }
      this.items.forEach((i) => { if (!(i.o > 0.05)) i.el.style.setProperty('--dy', '0px'); });
    }
    /** La etiqueta del objeto seleccionado pasa al frente y no se atenua por distancia en detalle */
    setActive(partId) { this.items.forEach((i) => { const on = i.partId === partId; i.el.classList.toggle('active', on); i.wrap.style.zIndex = on ? '20' : ''; i.active = on; }); }
  }

  /** Seleccion por puntero: devuelve el id de componente bajo el cursor */
  class Picker {
    constructor(domElement, camera) {
      this.dom = domElement; this.camera = camera; this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
      this.meshes = [];
    }
    register(root, partId) {
      root.traverse((o) => { if (o.isMesh) { o.userData.part = partId; this.meshes.push(o); } });
    }
    pick(ev) {
      const r = this.dom.getBoundingClientRect();
      this.mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(this.mouse, this.camera);
      const hits = this.ray.intersectObjects(this.meshes, false);
      for (const h of hits) if (h.object.userData.part) return h.object.userData.part;
      return null;
    }
  }

  LAB.scene.PART_INFO = INFO;
  LAB.scene.Labels = Labels;
  LAB.scene.Picker = Picker;
})();
