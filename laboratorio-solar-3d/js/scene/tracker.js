/* Estructura fija del modulo A y seguidor de dos ejes del modulo B (columna, giro en azimut, eje de inclinacion,
 * actuador lineal telescopico, motorreductores y flechas de movimiento). */
(function () {
  'use strict';
  const { D2R, col } = LAB.util;
  const T = LAB.scene.tex;
  const M = LAB.config.module;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  function mats() {
    return {
      galv: T.std({ color: 0xaab2ba, roughness: 0.42, metalness: 0.85, envMapIntensity: 1.1 }),
      dark: T.std({ color: 0x23282e, roughness: 0.55, metalness: 0.5 }),
      conc: T.std({ color: 0x9a9b97, roughness: 0.95 }),
      yellow: T.std({ color: 0xf2b705, roughness: 0.5, metalness: 0.2 }),
    };
  }

  // ------------------------------------------------------------------ modulo A (fijo)
  function createFixedBank(pos) {
    const mt = mats();
    const g = new THREE.Group(); g.position.set(...pos);
    const mod = LAB.scene.createModule('A');
    const { az, tilt } = LAB.config.fixed;
    const b = tilt * D2R, hz = M.short / 2;
    const lowEdge = 0.58;
    const yc = lowEdge + hz * Math.sin(b);
    mod.root.position.set(0, yc, 0);
    mod.root.rotation.order = 'YXZ'; mod.root.rotation.y = -az * D2R; mod.root.rotation.x = -tilt * D2R;
    g.add(mod.root);
    // soportes: puntos en el marco del modulo (sistema local), girados a coordenadas del grupo
    const e = new THREE.Euler(-tilt * D2R, -az * D2R, 0, 'YXZ');
    const at = (x, z, y = -M.thick / 2 - 0.05) => V3(x, y, z).applyEuler(e).add(V3(0, yc, 0));
    const rails = [];
    for (const x of [-0.7, 0.7]) {
      const lowP = at(x, -hz + 0.12), hiP = at(x, hz - 0.12);
      rails.push(T.strut(g, at(x, -hz + 0.02, -M.thick / 2 - 0.045), at(x, hz - 0.02, -M.thick / 2 - 0.045), 0.022, mt.galv));
      const pLow = V3(lowP.x, 0, lowP.z), pHigh = V3(hiP.x, 0, hiP.z);
      T.strut(g, pLow, lowP, 0.026, mt.galv);
      T.strut(g, pHigh, hiP, 0.026, mt.galv);
      T.box(g, 0.34, 0.12, 0.34, mt.conc, pLow.x, 0.06, pLow.z);
      T.box(g, 0.34, 0.12, 0.34, mt.conc, pHigh.x, 0.06, pHigh.z);
    }
    // travesanos
    for (const z of [-0.25, 0.25]) {
      const l = at(-0.9, z), r = at(0.9, z);
      T.strut(g, l, r, 0.018, mt.galv);
    }
    return { group: g, module: mod, name: 'Módulo A (fijo)' };
  }

  // ------------------------------------------------------------ modulo B (seguidor)
  function createTracker(pos) {
    const mt = mats();
    const g = new THREE.Group(); g.position.set(...pos);

    // base y columna
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.5, 0.3, 28), mt.conc);
    ped.position.y = 0.15; ped.castShadow = ped.receiveShadow = true; g.add(ped);
    for (let i = 0; i < 8; i++) {                       // pernos de anclaje
      const a = (i / 8) * Math.PI * 2;
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 8), mt.galv);
      bolt.position.set(Math.cos(a) * 0.32, 0.33, Math.sin(a) * 0.32); g.add(bolt);
    }
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.035, 28), mt.galv);
    plate.position.y = 0.318; plate.castShadow = true; g.add(plate);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.125, 1.4, 20), mt.galv);
    pole.position.y = 1.02; pole.castShadow = pole.receiveShadow = true; g.add(pole);
    const slew = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 28), mt.dark);
    slew.position.y = 1.82; slew.castShadow = true; g.add(slew);

    // cabezal de azimut
    const azG = new THREE.Group(); azG.position.y = 1.92; g.add(azG);
    T.box(azG, 1.0, 0.1, 0.36, mt.galv, 0, 0.05, 0);
    const motorAz = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.24, 16), mt.dark);
    motorAz.rotation.z = Math.PI / 2; motorAz.position.set(0.34, 0.05, 0.28); azG.add(motorAz);
    for (const sx of [-0.52, 0.52]) T.box(azG, 0.07, 0.62, 0.22, mt.galv, sx, 0.36, 0);   // horquilla
    const TILT_Y = 0.55;

    // eje de inclinacion
    const tiltG = new THREE.Group(); tiltG.position.y = TILT_Y; azG.add(tiltG);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.46, 16), mt.galv);
    tube.rotation.z = Math.PI / 2; tube.castShadow = true; tiltG.add(tube);
    const motorT = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.22, 16), mt.dark);
    motorT.rotation.z = Math.PI / 2; motorT.position.set(0.66, 0, 0); tiltG.add(motorT);
    for (const sx of [-0.72, 0.72]) {                    // rieles de montaje
      T.box(tiltG, 0.06, 0.04, M.short - 0.08, mt.galv, sx, 0.062, 0);
    }
    const mod = LAB.scene.createModule('B');
    mod.root.position.set(0, 0.062 + 0.02 + M.thick / 2, 0);
    tiltG.add(mod.root);

    // actuador lineal telescopico entre la base del cabezal y el panel (se recalcula en cada cuadro)
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 12), mt.dark);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 10), T.std({ color: 0xdfe3e7, roughness: 0.25, metalness: 0.95 }));
    outer.castShadow = inner.castShadow = true;
    g.add(outer, inner);
    const p0 = V3(0, 0.0, 0.72), p1 = V3(0, -0.02, 0.5);   // puntos de anclaje (azG y tiltG)
    const w0 = V3(), w1 = V3();

    // flechas de movimiento (resaltan el eje que se mueve)
    const arrowMat = (c) => new THREE.MeshBasicMaterial({ color: col(c), transparent: true, opacity: 0.0, depthWrite: false, depthTest: false, fog: false });
    const mkArrow = (radius, arc, c) => {
      const grp = new THREE.Group();
      const mat = arrowMat(c);
      const t = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.022, 8, 56, arc), mat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 14), mat);
      head.position.set(radius * Math.cos(arc), radius * Math.sin(arc), 0);
      head.rotation.z = arc + Math.PI / 2 * 0 - Math.PI / 2 + Math.PI;
      grp.add(t, head); grp.renderOrder = 20; t.renderOrder = head.renderOrder = 20;
      return { grp, mat };
    };
    const azArrow = mkArrow(0.62, Math.PI * 1.35, 0x2fb4ff);
    azArrow.grp.rotation.x = -Math.PI / 2; azArrow.grp.position.y = 1.48; g.add(azArrow.grp);
    const tiltArrow = mkArrow(0.78, Math.PI * 0.8, 0x35d07f);
    tiltArrow.grp.rotation.y = Math.PI / 2; tiltArrow.grp.position.set(1.38, 1.92 + TILT_Y, 0.0); g.add(tiltArrow.grp);

    const api = {
      group: g, azGroup: azG, tiltGroup: tiltG, module: mod, name: 'Módulo B (móvil de dos ejes)',
      arrows: { az: azArrow, tilt: tiltArrow }, showArrows: true,
      tiltAxisWorld: () => tiltG.getWorldPosition(V3()),
      /** az y tilt en grados (inclinacion respecto a la horizontal, azimut desde el norte) */
      setPose(az, tilt) {
        azG.rotation.y = -az * D2R;
        tiltG.rotation.x = -tilt * D2R;
      },
      update(tel, dt, t) {
        this.setPose(tel.tracker.az, tel.tracker.tilt);
        g.updateMatrixWorld(true);
        azG.localToWorld(w0.copy(p0)); tiltG.localToWorld(w1.copy(p1));
        g.worldToLocal(w0); g.worldToLocal(w1);
        const d = V3().subVectors(w1, w0), len = d.length(); d.normalize();
        const oLen = Math.min(0.55, len * 0.62);
        T.placeStrut(outer, w0, V3().copy(w0).addScaledVector(d, oLen), 1);
        T.placeStrut(inner, V3().copy(w1).addScaledVector(d, -(len - oLen + 0.12)), w1, 1);
        // flechas: parpadean mientras el eje se mueve
        const pulse = 0.55 + 0.45 * Math.sin(t * 7);
        const mv = tel.tracker.moving;
        const sa = this.showArrows ? (mv.az ? 0.95 * pulse : 0) : 0, st = this.showArrows ? (mv.tilt ? 0.95 * pulse : 0) : 0;
        azArrow.mat.opacity += (sa - azArrow.mat.opacity) * Math.min(1, dt * 10);
        tiltArrow.mat.opacity += (st - tiltArrow.mat.opacity) * Math.min(1, dt * 10);
        azArrow.grp.visible = azArrow.mat.opacity > 0.02; tiltArrow.grp.visible = tiltArrow.mat.opacity > 0.02;
        azArrow.grp.rotation.z = (tel.tracker.vAz >= 0 ? -1 : 1) * 0;
      },
    };
    return api;
  }

  LAB.scene.createFixedBank = createFixedBank;
  LAB.scene.createTracker = createTracker;
})();
