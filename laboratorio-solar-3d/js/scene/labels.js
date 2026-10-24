/* Etiquetas 3D (CSS2D), seleccion por clic/hover y ficha informativa de cada componente. */
(function () {
  'use strict';
  const { fmt } = LAB.util;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  /** Informacion didactica de cada componente + variables en vivo que se muestran en la ficha. */
  const INFO = {
    moduleA: {
      title: 'Módulo A · fijo de referencia', kind: 'Generación', color: '#35d07f',
      text: 'Módulo comercial de ~500 Wp con inclinación fija (≈ latitud) orientado al sur. Es la referencia contra la que se compara el módulo móvil: cualquier diferencia de energía se debe a la orientación y al seguimiento.',
      live: (t) => [['Irradiancia plano', fmt(t.A.poa, 0) + ' W/m²'], ['Temp. de celda', fmt(t.A.tcell, 1) + ' °C'], ['Potencia', fmt(t.A.p, 0) + ' W'], ['Energía', fmt(t.A.wh, 1) + ' Wh']],
    },
    moduleB: {
      title: 'Módulo B · móvil de dos ejes', kind: 'Generación', color: '#ffb020',
      text: 'Módulo idéntico al A sobre un seguidor de dos ejes con realimentación de posición. Puede trabajar con ambos ejes, bloquear uno (práctica de azimut o de inclinación) o seguir al Sol de forma astronómica o por sensores.',
      live: (t) => [['Azimut', fmt(t.B.az, 1) + '°'], ['Inclinación', fmt(t.B.tilt, 1) + '°'], ['Irradiancia en el plano', fmt(t.B.poa, 0) + ' W/m²'], ['Potencia', fmt(t.B.p, 0) + ' W'], ['Diferencia de potencia vs. A', t.comparison.powerDiffPct == null ? 'No disponible' : fmt(t.comparison.powerDiffPct, 1) + ' %']],
    },
    irrA: {
      title: 'Sensor de irradiancia · plano de A', kind: 'Medición', color: '#2fb4ff',
      text: 'Mide la irradiancia en el mismo plano del módulo (W/m²). Es lo que permite comparar los módulos de forma justa, porque cada uno recibe una irradiancia distinta según su orientación.',
      live: (t) => [['Irradiancia', fmt(t.A.poa, 0) + ' W/m²'], ['Ángulo de incidencia', fmt(t.A.aoi, 1) + '°']],
    },
    irrB: {
      title: 'Sensor de irradiancia · plano de B', kind: 'Medición', color: '#2fb4ff',
      text: 'Igual que el del módulo A pero montado sobre la parte móvil: se inclina junto con el panel y sigue midiendo en su plano.',
      live: (t) => [['Irradiancia', fmt(t.B.poa, 0) + ' W/m²'], ['Ángulo de incidencia', fmt(t.B.aoi, 1) + '°']],
    },
    pyr: {
      title: 'Piranómetro (referencia ambiental)', kind: 'Meteorología', color: '#2fb4ff',
      text: 'Mide la irradiancia global horizontal (GHI). Sirve como referencia meteorológica y permite detectar nubes o suciedad al compararla con los sensores de plano. La DNI y la DHI NO las mide este sensor: son valores derivados del modelo del simulador.',
      live: (t) => [['GHI (medida simulada)', fmt(t.env.ghi, 0) + ' W/m²'], ['DNI (derivada del modelo)', fmt(t.env.dni, 0) + ' W/m²'], ['DHI (derivada del modelo)', fmt(t.env.dhi, 0) + ' W/m²']],
    },
    anemo: {
      title: 'Anemómetro y veleta', kind: 'Meteorología', color: '#2fb4ff',
      text: 'Velocidad y dirección del viento. Con rachas fuertes el controlador local lleva el seguidor a posición segura (horizontal) para proteger la estructura.',
      live: (t) => [['Velocidad', fmt(t.env.wind, 1) + ' m/s'], ['Dirección (de donde sopla)', fmt(t.env.windDir, 0) + '°'], ['Umbral de seguridad', LAB.config.safety.windStow + ' m/s']],
    },
    shield: {
      title: 'Temperatura y humedad relativa', kind: 'Meteorología', color: '#2fb4ff',
      text: 'Sensor protegido por un abrigo de placas apiladas para evitar que el Sol caliente la lectura. La temperatura ambiente determina cuánto se calienta el módulo.',
      live: (t) => [['Temp. ambiente', fmt(t.env.ta, 1) + ' °C'], ['Humedad relativa', fmt(t.env.rh, 0) + ' %']],
    },
    rain: {
      title: 'Pluviómetro', kind: 'Meteorología', color: '#2fb4ff',
      text: 'Registra la lluvia acumulada. Se usa para interpretar caídas de irradiancia y como apoyo a decisiones de seguridad.',
      live: (t) => [['Estado', t.env.rain ? 'Lloviendo · ' + LAB.sim.RAIN_LEVELS[t.env.rainLevel].name.toLowerCase() : 'Seco'], ['Intensidad', fmt(t.env.rainRate, 1) + ' mm/h'], ['Acumulado', fmt(t.env.rainMm, 2) + ' mm']],
    },
    load: {
      title: 'Carga electrónica programable CC', kind: 'Caracterización', color: '#a98bff',
      text: 'Impone el punto de operación a cada módulo (tensión, resistencia, cortocircuito o seguimiento del punto de máxima potencia) y permite barridos automáticos para obtener la curva I-V. Los estados son predefinidos y limitados por el sistema.',
      live: (t) => [['Modo', { oc: 'Circuito abierto', sc: 'Cortocircuito', cv: 'Tensión const.', cr: 'Resistencia', mppt: 'MPPT' }[t.load.mode] || t.load.mode], ['P total', fmt(t.A.p + t.B.p, 0) + ' W']],
    },
    cabinet: {
      title: 'Gabinete de control y adquisición', kind: 'Control local', color: '#ff6b6b',
      text: 'Aloja el NI cDAQ-9184 con LabVIEW 2016 (por confirmar en inventario), el controlador local, drivers y relés, y las protecciones CC. Los límites críticos de seguridad viven aquí y no se pueden cambiar desde la web.',
      live: (t) => [['Estado de seguridad', { NORMAL: 'Normal', WIND_STOW: 'Posición segura (viento)', COMMS_STOW: 'Posición segura (watchdog)', ESTOP: 'Paro de emergencia' }[t.safety.state]], ['Latencia del enlace', fmt(t.comms.latency, 0) + ' ms']],
    },
    estop: {
      title: 'Paro de emergencia local', kind: 'Seguridad', color: '#ff4d4d',
      text: 'Corta la energía de los motores y desconecta la carga. Solo se restablece en sitio con la llave. Haz clic en el botón rojo para accionarlo (en la práctica real solo lo haría personal en el lugar).',
      live: (t) => [['Estado', t.safety.estop ? 'ACCIONADO' : 'Normal']],
    },
    cam1: {
      title: 'Cámara IP 1 · vista general', kind: 'Observación', color: '#2fb4ff',
      text: 'Permite verificar visualmente el estado del banco durante la sesión. Haz clic en "Ver cámara" para ver su imagen simulada.',
      live: () => [['Resolución', '1080p · 15 fps (simulado)']],
    },
    cam2: {
      title: 'Cámara IP 2 · vista del seguidor', kind: 'Observación', color: '#2fb4ff',
      text: 'Apunta al módulo móvil: sirve para confirmar con la imagen el movimiento que reporta la telemetría.',
      live: (t) => [['Posición del seguidor', `${fmt(t.B.az, 0)}° / ${fmt(t.B.tilt, 0)}°`]],
    },
    azAxis: {
      title: 'Eje de azimut (giro horizontal)', kind: 'Movimiento', color: '#2fb4ff',
      text: 'Motorreductor con realimentación de posición. Rango autorizado de 90° a 270° (este–sur–oeste) con finales de carrera por hardware y software.',
      live: (t) => [['Azimut', fmt(t.tracker.az, 1) + '°'], ['Objetivo', fmt(t.tracker.targetAz, 1) + '°'], ['Rango', `${t.tracker.limits.azMin}°–${t.tracker.limits.azMax}°`]],
    },
    tiltAxis: {
      title: 'Eje de inclinación (elevación)', kind: 'Movimiento', color: '#35d07f',
      text: 'Actuador lineal que inclina el panel de 0° (horizontal, posición segura) a 90°. Con el eje de azimut bloqueado se hace la práctica de inclinación.',
      live: (t) => [['Inclinación', fmt(t.tracker.tilt, 1) + '°'], ['Objetivo', fmt(t.tracker.targetTilt, 1) + '°'], ['Rango', `${t.tracker.limits.tiltMin}°–${t.tracker.limits.tiltMax}°`]],
    },
    dcA: {
      title: 'Medición eléctrica CC · módulo A', kind: 'Medición', color: '#2fb4ff',
      text: 'Transductores aislados de tensión y corriente. A partir de ellos se calculan potencia y energía del módulo.',
      live: (t) => [['V', fmt(t.A.v, 1) + ' V'], ['I', fmt(t.A.i, 2) + ' A'], ['P', fmt(t.A.p, 0) + ' W']],
    },
    dcB: {
      title: 'Medición eléctrica CC · módulo B', kind: 'Medición', color: '#2fb4ff',
      text: 'Misma instrumentación que el módulo A, sincronizada con ella para poder comparar potencia y energía.',
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
      el.innerHTML = `<i class="dot"></i><span>${text}</span>`;
      el.dataset.part = partId;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (this.onClick) this.onClick(partId); });
      wrap.appendChild(el);
      const obj = new THREE.CSS2DObject(wrap);
      obj.position.copy(localPos);
      parent.add(obj);
      this.items.push({ el, wrap, obj, partId, detail: !!opts.detail, track: opts.track || null, parent });
      return el;
    }
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
        it.el.style.opacity = o.toFixed(2);
        it.el.style.visibility = o < 0.05 ? 'hidden' : 'visible';
      }
      this.renderer.render(this.scene, camera);
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
