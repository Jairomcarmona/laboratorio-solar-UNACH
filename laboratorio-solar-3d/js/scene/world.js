/* Ensambla la escena completa del laboratorio. La escena es una "vista" pura de la telemetria:
 * world.update(telemetry, dt) coloca el seguidor, el Sol, los sensores y las lamparas segun los datos. */
(function () {
  'use strict';
  const { D2R } = LAB.util;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const L = LAB.config.layout;

  class World {
    constructor(renderer, camera, labelsContainer) {
      this.scene = new THREE.Scene();
      this.camera = camera;
      this.env = new LAB.scene.Environment(this.scene, renderer);

      // banco
      this.bankA = LAB.scene.createFixedBank(L.moduleA);
      this.trackerB = LAB.scene.createTracker(L.moduleB);
      this.station = LAB.scene.createWeatherStation(L.weather);
      this.load = LAB.scene.createLoadCabinet(L.load);
      this.cabinet = LAB.scene.createControlCabinet(L.cabinet);
      this.env3 = LAB.config.envelopes(L);
      // camaras IP: la 1 supervisa el conjunto A+B; la 2 mira el eje de inclinacion de B (todo su recorrido cabe con margen)
      const mid = (a, b) => (a + b) / 2;
      this.camAim = { cam1: [mid(L.moduleA[0], L.moduleB[0]), 1.3, mid(L.moduleA[2], L.moduleB[2])], cam2: [L.moduleB[0], this.env3.axisY, L.moduleB[2]] };
      this.cam1 = LAB.scene.createIpCamera(L.cam1, this.camAim.cam1, 'cam1', 55);
      this.cam2 = LAB.scene.createIpCamera(L.cam2, this.camAim.cam2, 'cam2', 40);
      this.cables = LAB.scene.createCables(L);
      this.scene.add(this.bankA.group, this.trackerB.group, this.station.group, this.load.group, this.cabinet.group, this.cam1.group, this.cam2.group, this.cables);
      this.cam1.aim(); this.cam2.aim();

      this.scene.add(this.buildRoofRose());
      this.buildLabelsAndPicking(labelsContainer);
      this.buildViews();
      this.hover = null; this.selected = null;
      this.halo = new THREE.Box3Helper(new THREE.Box3(), 0x2fb4ff);
      this.halo.material.depthTest = false; this.halo.material.transparent = true; this.halo.renderOrder = 30; this.halo.visible = false;
      this.scene.add(this.halo);
      this.t = 0;
    }

    /** Rosa de los vientos pintada en la azotea: el Norte es -Z, el Este +X */
    buildRoofRose() {
      const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
      const g = cv.getContext('2d'), c = S / 2;
      g.strokeStyle = '#f3f6f8'; g.fillStyle = '#f3f6f8'; g.lineWidth = 7;
      g.beginPath(); g.arc(c, c, 200, 0, 7); g.stroke(); g.lineWidth = 3; g.beginPath(); g.arc(c, c, 150, 0, 7); g.stroke();
      for (let d = 0; d < 360; d += 15) { const a = d * Math.PI / 180, r1 = 200, r2 = d % 90 === 0 ? 150 : d % 45 === 0 ? 170 : 184; g.lineWidth = d % 45 ? 2 : 5; g.beginPath(); g.moveTo(c + Math.sin(a) * r1, c - Math.cos(a) * r1); g.lineTo(c + Math.sin(a) * r2, c - Math.cos(a) * r2); g.stroke(); }
      g.beginPath(); g.moveTo(c, c - 150); g.lineTo(c - 26, c + 10); g.lineTo(c, c - 12); g.lineTo(c + 26, c + 10); g.closePath(); g.fillStyle = '#e8483c'; g.fill();
      g.beginPath(); g.moveTo(c, c + 120); g.lineTo(c - 16, c + 10); g.lineTo(c + 16, c + 10); g.closePath(); g.fillStyle = '#f3f6f8'; g.fill();
      g.font = '800 56px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      [['N', 0, '#e8483c'], ['E', 90, '#f3f6f8'], ['S', 180, '#f3f6f8'], ['O', 270, '#f3f6f8']].forEach(([t, d, col]) => { const a = d * Math.PI / 180; g.fillStyle = col; g.fillText(t, c + Math.sin(a) * 232 * 0.88 + (d === 90 ? 24 : d === 270 ? -24 : 0), c - Math.cos(a) * 232 * 0.88 + (d === 0 ? -24 : d === 180 ? 24 : 0)); });
      const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.85, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.rotation.x = -Math.PI / 2; m.position.set(L.rose[0], 0.012, L.rose[1]); m.receiveShadow = true; m.renderOrder = 1;
      return m;
    }

    buildLabelsAndPicking(container) {
      const labels = (this.labels = new LAB.scene.Labels(this.scene, container));
      const picker = (this.picker = new LAB.scene.Picker(container, this.camera));
      const A = this.bankA, B = this.trackerB, S = this.station;
      this.partRoots = {
        moduleA: A.module.root, moduleB: B.module.root, irrA: A.module.irradianceSensor, irrB: B.module.irradianceSensor,
        pyr: S.objects.pyr, anemo: S.parts.cups, shield: S.objects.shield, rain: S.objects.rain, load: this.load.group,
        cabinet: this.cabinet.group, estop: this.cabinet.estop, cam1: this.cam1.group, cam2: this.cam2.group,
        azAxis: B.azGroup, tiltAxis: B.tiltGroup,
      };
      // ids de seleccion por malla
      for (const id of ['moduleA', 'moduleB', 'irrA', 'irrB', 'pyr', 'shield', 'rain', 'load', 'cabinet', 'cam1', 'cam2']) picker.register(this.partRoots[id], id);
      picker.register(S.parts.cups, 'anemo'); picker.register(S.parts.vane, 'anemo');
      picker.register(this.cabinet.estop, 'estop');
      picker.register(this.cabinet.resetKey, 'estop');

      // etiquetas (posiciones locales respecto del objeto que las contiene)
      labels.add('moduleA', A.group, V3(0, 1.72, 0), 'lbl.moduleA', { cls: 'a' });
      labels.add('moduleB', B.group, V3(0, 3.5, 0), 'lbl.moduleB', { cls: 'b', track: { object: B.module.root, offset: [0, 0.75, 0] } });
      labels.add('irrA', A.group, V3(0.0, 1.5, 0.75), 'lbl.irrA', { cls: 'sensor', detail: true });
      labels.add('irrB', B.group, V3(1.35, 3.0, 0), 'lbl.irrB', { cls: 'sensor', detail: true, track: { object: B.module.irradianceSensor, offset: [0, 0.4, 0] } });
      labels.add('pyr', S.group, V3(0.36, 2.95, 0), 'lbl.pyr', { cls: 'sensor', detail: true });
      labels.add('anemo', S.group, V3(0, 4.05, 0), 'lbl.anemo', { cls: 'sensor' });
      labels.add('shield', S.group, V3(-0.28, 2.3, 0), 'lbl.shield', { cls: 'sensor', detail: true });
      labels.add('rain', S.group, V3(0.8, 1.2, 0.4), 'lbl.rain', { cls: 'sensor', detail: true });
      labels.add('load', this.load.group, V3(0, 1.85, 0), 'lbl.load', { cls: 'load' });
      labels.add('cabinet', this.cabinet.group, V3(0.6, 3.2, 0), 'lbl.cabinet', { cls: 'ctrl' });
      labels.add('estop', this.cabinet.group, V3(-0.2, 0.62, 0.45), 'lbl.estop', { cls: 'safety' });
      labels.add('cam1', this.cam1.group, V3(0, 3.6, 0), 'lbl.cam1', { cls: 'sensor' });
      labels.add('cam2', this.cam2.group, V3(0, 3.6, 0), 'lbl.cam2', { cls: 'sensor' });
      labels.add('azAxis', B.group, V3(-0.95, 1.9, 0.62), 'lbl.azAxis', { cls: 'axis', detail: true });
      labels.add('tiltAxis', B.group, V3(1.45, 2.5, 0), 'lbl.tiltAxis', { cls: 'axis', detail: true, track: { object: B.tiltGroup, offset: [1.45, 0, 0], local: true } });
      labels.add('dcA', A.group, V3(0.9, 0.35, 0.9), 'lbl.dcA', { cls: 'sensor', detail: true });
      labels.add('dcB', B.group, V3(-0.9, 0.35, 0.9), 'lbl.dcB', { cls: 'sensor', detail: true });
      this.aidsMode = 'auto'; this.aids = LAB.scene.createAids(this);      // C19: ayudas 3D por tarea (normal, rayo, ángulo de incidencia, azimut)
      this.partRoots.dcA = A.group; this.partRoots.dcB = B.group;
    }

    /** Vistas predefinidas derivadas de la distribucion (LAB.config.layout) y de los volumenes de cada equipo:
     *  ninguna posicion de camara esta escrita a mano. Cada vista fija el punto de mira y la direccion; la distancia se calcula
     *  para que todo lo que debe verse quepa en el area util del escenario (viewPose). */
    buildViews() {
      const E = this.env3, norm = (v) => V3(...v).normalize();
      const pts = (...names) => names.flatMap((n) => LAB.scene.framing.corners(E[n]));
      const ctr = (names, y) => { const b = new THREE.Box3(); pts(...names).forEach((p) => b.expandByPoint(p)); const c = b.getCenter(V3()); return { c: V3(c.x, y, c.z), b }; };
      const c = (n, y) => { const e = E[n]; return V3((e.min[0] + e.max[0]) / 2, y, (e.min[2] + e.max[2]) / 2); };
      const all = ['moduleA', 'moduleB', 'weather', 'load', 'cabinet'];
      const gen = ctr(all, 1.4);
      const zAB = (L.moduleA[2] + L.moduleB[2]) / 2;
      this.insets = { top: 0 };
      this.viewSpecs = {
        general: { points: pts(...all), target: V3(gen.c.x, 1.4, zAB - 0.4), dir: norm([0.6, 5.8, 12.4]), fov: 42, margin: 1.08, get label() { return LAB.t('world.view_general'); } },
        moduleA: { points: pts('moduleA'), target: c('moduleA', 0.75), dir: norm([-0.55, 0.28, 1]), fov: 42, margin: 1.12, get label() { return LAB.t('world.view_moduleA'); } },
        moduleB: { points: pts('moduleB'), target: c('moduleB', 1.8), dir: norm([-0.6, 0.32, 1]), fov: 42, margin: 1.1, get label() { return LAB.t('world.view_moduleB'); } },
        station: { points: pts('weather'), target: c('weather', 2.1), dir: norm([0.75, 0.2, 1]), fov: 42, margin: 1.1, get label() { return LAB.t('world.view_station'); } },
        load: { points: pts('load'), target: c('load', 0.9), dir: norm([-0.5, 0.3, 1]), fov: 42, margin: 1.35, get label() { return LAB.t('world.view_load'); } },
        cabinet: { points: pts('cabinet'), target: c('cabinet', 1.2), dir: norm([0.8, 0.2, 0.6]), fov: 42, margin: 1.3, get label() { return LAB.t('world.view_cabinet'); } },
        aerial: { points: pts(...all, 'cam1', 'cam2'), target: V3(gen.c.x, 0, gen.c.z), dir: norm([0.045, 1, 0.58]), fov: 42, margin: 1.12, get label() { return LAB.t('world.view_aerial'); } },
        // acercamientos desde "Abrir componente" de las camaras IP (no aparecen en la barra de vistas)
        camFocus1: { points: pts('cam1'), target: c('cam1', 2.9), dir: norm([0.55, 0.12, 1]), fov: 42, margin: 1.25, get label() { return LAB.t('world.view_camFocus1'); } },
        camFocus2: { points: pts('cam2'), target: c('cam2', 2.9), dir: norm([-0.55, 0.12, 1]), fov: 42, margin: 1.25, get label() { return LAB.t('world.view_camFocus2'); } },
        front: { points: pts('moduleA', 'moduleB', 'load', 'cabinet'), target: V3(gen.c.x, 1.3, zAB), dir: norm([0, 0.1, 1]), fov: 40, margin: 1.1, get label() { return LAB.t('world.view_front'); } },
      };
      this.views = this.viewSpecs;
    }

    /** Posicion, punto de mira y campo de vision de una vista para un area util de relacion de aspecto `aspect` */
    viewPose(name, aspect) {
      const v = this.viewSpecs[name]; if (!v) return null;
      const d = LAB.scene.framing.fitDistance(v.points, v.target, v.dir, v.fov, aspect || 16 / 9, { margin: v.margin, top: this.insets.top, minDist: 2.2 });
      const pos = v.target.clone().addScaledVector(v.dir, d);
      return { pos: pos.toArray(), target: v.target.toArray(), fov: v.fov, dist: d };
    }

    camPov(which) { return which === 'cam1' ? this.cam1.cam : this.cam2.cam; }

    setHover(id) {
      if (id === this.hover) return;
      this.hover = id;
    }
    select(id) {
      this.selected = id;
      this.labels.setActive(id);
    }

    updateHalo() {
      const id = this.hover || this.selected;
      const root = id && this.partRoots[id];
      if (!root) { this.halo.visible = false; return; }
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) { this.halo.visible = false; return; }
      box.expandByScalar(0.06);
      this.halo.box.copy(box);
      this.halo.material.color.set(this.hover ? 0x7fd4ff : 0x2fb4ff);
      this.halo.material.opacity = this.hover ? 0.95 : 0.7;
      this.halo.visible = true;
    }

    update(tel, dt) {
      this.t += dt;
      this.env.update(tel, dt);
      this.trackerB.update(tel, dt, this.t);
      this.station.update(tel, dt);
      this.load.update(tel, dt);
      this.cabinet.update(tel, dt, this.t);
      this.cam1.update(tel, dt, this.t); this.cam2.update(tel, dt, this.t);
      this.aids.update(tel, this.aidsMode, LAB.ui && LAB.ui.aidsAuto ? LAB.ui.aidsAuto() : false);
      // sombra: el volumen de la luz sigue al banco
      this.updateHalo();
    }
  }

  LAB.scene.World = World;
})();
