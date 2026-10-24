/* Equipo auxiliar del banco: carga electronica programable (con pantalla viva), gabinete de control y seguridad
 * (paro de emergencia, lamparas, llave de restablecimiento), camaras IP con postes y conduits de cableado CC. */
(function () {
  'use strict';
  const { D2R, col, clamp } = LAB.util;
  const T = LAB.scene.tex;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  // ---------------------------------------------------------------- carga CC
  function createLoadCabinet(pos) {
    const g = new THREE.Group(); g.position.set(...pos);
    const body = T.std({ color: 0xd9dde1, roughness: 0.4, metalness: 0.55, envMapIntensity: 1.0 });
    const dark = T.std({ color: 0x1b1f24, roughness: 0.5, metalness: 0.4 });
    const W = 1.0, H = 1.3, D = 0.62, y0 = 0.22;
    T.box(g, W, H, D, body, 0, y0 + H / 2, 0);
    T.box(g, W + 0.04, 0.05, D + 0.04, dark, 0, y0 + H + 0.025, 0);       // tapa
    // ruedas
    for (const [x, z] of [[-0.4, -0.22], [0.4, -0.22], [-0.4, 0.22], [0.4, 0.22]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 18), dark);
      w.rotation.z = Math.PI / 2; w.position.set(x, 0.1, z); w.castShadow = true; g.add(w);
      T.box(g, 0.05, 0.12, 0.05, dark, x, 0.17, z);
    }
    // rejillas de ventilacion
    for (let i = 0; i < 9; i++) T.box(g, 0.78, 0.018, 0.012, dark, 0, y0 + 0.12 + i * 0.045, D / 2 + 0.003);
    // letrero
    const sign = T.textTexture(512, 96, (ctx, w, h) => {
      ctx.fillStyle = '#0b3b6f'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.font = '700 30px Inter, Arial, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('CARGA ELECTRÓNICA', w / 2, 42); ctx.font = '500 24px Inter, Arial, sans-serif'; ctx.fillText('PROGRAMABLE CC · 2 CANALES', w / 2, 76);
    });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.16), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }));
    plate.position.set(0, y0 + H - 0.14, D / 2 + 0.01); g.add(plate);

    // pantalla viva
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 360;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.56), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    screen.position.set(0, y0 + 0.78, D / 2 + 0.01); g.add(screen);
    T.box(g, 0.86, 0.62, 0.012, dark, 0, y0 + 0.78, D / 2 - 0.002);

    let acc = 0;
    const api = {
      group: g, screen, anchor: V3(0, 1.9, 0),
      update(tel, dt) {
        acc += dt; if (acc < 0.2) return; acc = 0;
        const L = tel.load, A = tel.A, B = tel.B;
        ctx.fillStyle = '#06141f'; ctx.fillRect(0, 0, 512, 360);
        ctx.fillStyle = '#0d2a40'; ctx.fillRect(0, 0, 512, 44);
        ctx.fillStyle = '#7fd4ff'; ctx.font = '600 22px "JetBrains Mono", monospace'; ctx.textAlign = 'left';
        const names = { oc: 'CIRCUITO ABIERTO', sc: 'CORTOCIRCUITO', cv: 'TENSIÓN CONST.', cr: 'RESISTENCIA CTE', mppt: 'SEGUIM. MPP' };
        ctx.fillText('MODO ' + (L.sweeping ? 'BARRIDO I-V' : names[L.mode] || L.mode), 14, 30);
        const row = (label, m, y, c) => {
          ctx.fillStyle = c; ctx.font = '700 22px "JetBrains Mono", monospace'; ctx.fillText(label, 14, y);
          ctx.fillStyle = '#e8f6ff'; ctx.font = '500 20px "JetBrains Mono", monospace';
          ctx.fillText(`${m.v.toFixed(1).padStart(5)} V`, 70, y); ctx.fillText(`${m.i.toFixed(2).padStart(5)} A`, 190, y); ctx.fillText(`${m.p.toFixed(0).padStart(4)} W`, 320, y);
          const frac = clamp(m.p / 520, 0, 1);
          ctx.fillStyle = '#0d2a40'; ctx.fillRect(14, y + 10, 484, 12);
          ctx.fillStyle = c; ctx.fillRect(14, y + 10, 484 * frac, 12);
        };
        row('A', A, 102, '#35d07f'); row('B', B, 182, '#ffb020');
        ctx.fillStyle = '#7fd4ff'; ctx.font = '500 18px "JetBrains Mono", monospace';
        ctx.fillText(`Pa+Pb ${(A.p + B.p).toFixed(0)} W   Pmax ${(A.pmp + B.pmp).toFixed(0)} W`, 14, 260);
        ctx.fillText(tel.safety.estop ? '⚠ CARGA DESCONECTADA (PARO)' : 'Carga conectada · protección CC OK', 14, 300);
        ctx.fillStyle = tel.safety.estop ? '#ff4d4d' : '#35d07f'; ctx.fillRect(14, 316, 484, 6);
        tex.needsUpdate = true;
      },
    };
    return api;
  }

  // ---------------------------------------------------------- gabinete de control
  function createControlCabinet(pos) {
    const g = new THREE.Group(); g.position.set(...pos);
    const body = T.std({ color: 0xc9d0d6, roughness: 0.42, metalness: 0.5 });
    const dark = T.std({ color: 0x1b1f24, roughness: 0.5, metalness: 0.4 });
    const W = 0.85, H = 1.6, D = 0.42, y0 = 0.12;
    T.box(g, W, 0.12, D + 0.1, T.std({ color: 0x8d8f8b, roughness: 0.95 }), 0, 0.06, 0);
    T.box(g, W, H, D, body, 0, y0 + H / 2, 0);
    T.box(g, W + 0.06, 0.05, D + 0.06, dark, 0, y0 + H + 0.025, 0);
    // ventana con equipos
    const win = T.textTexture(256, 320, (ctx, w, h) => {
      ctx.fillStyle = '#0a1620'; ctx.fillRect(0, 0, w, h);
      const items = [['cDAQ-9184', '#3da5ff'], ['NI 9215', '#3da5ff'], ['Controlador local', '#ffb020'], ['Drivers / relés', '#35d07f'], ['Protección CC', '#ff6b6b'], ['Fuente 24 V', '#b0b8c0']];
      items.forEach(([t, c], i) => { ctx.fillStyle = '#10222f'; ctx.fillRect(14, 14 + i * 50, w - 28, 40); ctx.fillStyle = c; ctx.fillRect(14, 14 + i * 50, 6, 40); ctx.fillStyle = '#d7ecff'; ctx.font = '600 18px Inter, Arial'; ctx.fillText(t, 32, 40 + i * 50); });
    });
    const win3d = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.7), new THREE.MeshBasicMaterial({ map: win, toneMapped: false }));
    win3d.position.set(0, y0 + 0.95, D / 2 + 0.01); g.add(win3d);
    T.box(g, 0.62, 0.76, 0.012, dark, 0, y0 + 0.95, D / 2 - 0.002);

    // panel de seguridad: paro de emergencia (hongo rojo) y llave de restablecimiento
    const plate = T.std({ color: 0xf2b705, roughness: 0.5 });
    const ePlate = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 28), plate);
    ePlate.rotation.x = Math.PI / 2; ePlate.position.set(-0.2, y0 + 0.3, D / 2 + 0.008); g.add(ePlate);
    const eMat = T.std({ color: 0xd61f1f, roughness: 0.3, metalness: 0.1, emissive: 0xff2a2a, emissiveIntensity: 0.0 });
    const estop = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.06, 28), eMat);
    estop.rotation.x = Math.PI / 2; estop.position.set(-0.2, y0 + 0.3, D / 2 + 0.05); estop.castShadow = true; g.add(estop);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.04, 16), dark);
    stem.rotation.x = Math.PI / 2; stem.position.set(-0.2, y0 + 0.3, D / 2 + 0.022); g.add(stem);
    const resetBase = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 20), dark);
    resetBase.rotation.x = Math.PI / 2; resetBase.position.set(0.2, y0 + 0.3, D / 2 + 0.015); g.add(resetBase);
    const resetKey = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.025), T.std({ color: 0xb8bec4, metalness: 0.9, roughness: 0.3 }));
    resetKey.position.set(0.2, y0 + 0.3, D / 2 + 0.04); g.add(resetKey);
    const label = T.textTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#f2b705'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#111'; ctx.font = '700 28px Inter, Arial'; ctx.textAlign = 'center';
      ctx.fillText('PARO LOCAL            RESTABLECER', w / 2, 42);
    });
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.1), new THREE.MeshBasicMaterial({ map: label, toneMapped: false }));
    lab.position.set(0, y0 + 0.15, D / 2 + 0.01); g.add(lab);

    // torre de lamparas (verde, ambar, roja)
    const lampMats = {};
    const lampDefs = [['red', 0xff2a2a, 0.0], ['amber', 0xffb020, 0.16], ['green', 0x35d07f, 0.32]];
    T.box(g, 0.08, 0.5, 0.08, dark, 0.3, y0 + H + 0.3, 0);
    for (const [k, c, dy] of lampDefs) {
      const m = new THREE.MeshStandardMaterial({ color: col(c).multiplyScalar(0.18), emissive: col(c), emissiveIntensity: 0, roughness: 0.3 });
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 18), m);
      l.position.set(0.3, y0 + H + 0.08 + dy, 0); g.add(l); lampMats[k] = m;
    }
    const lampLight = new THREE.PointLight(0x35d07f, 0, 5, 2);
    lampLight.position.set(0.3, y0 + H + 0.3, 0.25); g.add(lampLight);

    const api = {
      group: g, estop, resetKey, lampMats, anchor: V3(0, 2.4, 0), estopAnchor: V3(-0.2, 0.55, 0.55),
      update(tel, dt, t) {
        const lamp = tel.safety.lamp;
        const blink = lamp === 'amber' ? (0.5 + 0.5 * Math.sin(t * 6)) : 1;
        for (const k of Object.keys(lampMats)) {
          const on = k === lamp;
          lampMats[k].emissiveIntensity += ((on ? 2.6 * (k === 'amber' ? blink : 1) : 0.0) - lampMats[k].emissiveIntensity) * Math.min(1, dt * 14);
        }
        lampLight.color.copy(col(lamp === 'red' ? 0xff2a2a : lamp === 'amber' ? 0xffb020 : 0x35d07f));
        lampLight.intensity = 0.9 * (lamp === 'amber' ? blink : 1);
        eMat.emissiveIntensity += ((tel.safety.estop ? 1.2 + 0.6 * Math.sin(t * 8) : 0) - eMat.emissiveIntensity) * Math.min(1, dt * 12);
        estop.position.z = (0.42 / 2) + (tel.safety.estop ? 0.036 : 0.05);
      },
    };
    return api;
  }

  // ------------------------------------------------------------- camaras IP
  function createIpCamera(pos, target, name, fov = 52) {
    const g = new THREE.Group(); g.position.set(...pos);
    const steel = T.std({ color: 0xaab2ba, roughness: 0.4, metalness: 0.85 });
    const white = T.std({ color: 0xf3f4f5, roughness: 0.35 });
    const dark = T.std({ color: 0x14171b, roughness: 0.3, metalness: 0.5 });
    const H = 3.1;
    T.box(g, 0.5, 0.12, 0.5, T.std({ color: 0x9a9b97, roughness: 0.95 }), 0, 0.06, 0);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, H, 14), steel); pole.position.y = H / 2; pole.castShadow = true; g.add(pole);
    const head = new THREE.Group(); head.position.set(0, H + 0.02, 0); g.add(head);
    T.box(head, 0.1, 0.1, 0.1, dark, 0, -0.03, 0);
    const bodyG = new THREE.Group(); bodyG.position.y = 0.09; head.add(bodyG);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.3, 20), white); cyl.rotation.x = Math.PI / 2; cyl.position.z = 0.1; cyl.castShadow = true; bodyG.add(cyl);
    const shade = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.012, 0.36), white); shade.position.set(0, 0.085, 0.14); shade.castShadow = true; bodyG.add(shade);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.03, 20), T.std({ color: 0x07090c, roughness: 0.05, metalness: 0.2, envMapIntensity: 2.0 }, true));
    lens.rotation.x = Math.PI / 2; lens.position.z = 0.26; bodyG.add(lens);
    const ledM = new THREE.MeshStandardMaterial({ color: col(0x600000), emissive: col(0xff2020), emissiveIntensity: 1.5 });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), ledM); led.position.set(0.055, 0.045, 0.26); bodyG.add(led);
    // la camara 3D apunta a su objetivo
    const worldTarget = V3(...target);
    const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.3, 600);
    const api = {
      group: g, name, led: ledM, cam, headNode: head, lens, bodyG,
      /** direccion (mundo) hacia donde mira la carcasa; coincide con la de la camara virtual (se comprueba en pruebas) */
      forward() { g.updateMatrixWorld(true); return V3(0, 0, 1).transformDirection(bodyG.matrixWorld); }, targetWorld: worldTarget, anchor: V3(0, H + 0.45, 0),
      aim() {   // llamar con el grupo ya en la escena. La carcasa y la camara virtual quedan apuntando exactamente al mismo objetivo
        const lensW = V3();
        for (let k = 0; k < 4; k++) {          // la lente esta desplazada del eje de giro: se itera hasta que coinciden
          g.updateMatrixWorld(true);
          lens.getWorldPosition(lensW);
          const dir = g.worldToLocal(worldTarget.clone()).sub(g.worldToLocal(lensW.clone()));
          head.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
          bodyG.rotation.x = Math.atan2(-dir.y, Math.hypot(dir.x, dir.z));
        }
        g.updateMatrixWorld(true);
        lens.getWorldPosition(lensW);
        cam.position.copy(lensW);
        cam.lookAt(worldTarget);
        cam.updateMatrixWorld(true);
      },
      update(tel, dt, t) { ledM.emissiveIntensity = 0.3 + 1.6 * (Math.sin(t * 2.6 + (name.length)) > 0.2 ? 1 : 0); },
    };
    return api;
  }

  // -------------------------------------------------------------- cableado CC
  /** Rutas derivadas de la distribucion (LAB.config.layout); se construye una sola vez, no por cuadro.
   *  Todo va pegado a la azotea (y ~ 4 cm): nunca entra en el volumen que barre el panel B ni toca columnas o gabinetes.
   *  - A -> carga: pasa por el frente (lado sur) de B y entra por la cara oeste de la carga.
   *  - B -> carga: con un tramo ondulado de holgura junto a la base (recurso didactico; no afirma validez mecanica del cable).
   *  - Conduits grises (senales): estacion -> gabinete por el fondo, B -> gabinete y carga -> gabinete. La estacion no se
   *    conecta a la salida de potencia CC. */
  function createCables(layout) {
    const g = new THREE.Group();
    g.userData.routes = [];
    const mk = (pts, color, r = 0.028, y = 0.045, id = '') => {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => V3(p[0], y + (p[3] || 0), p[1])), false, 'centripetal', 0.4);
      const geo = new THREE.TubeGeometry(curve, 96, r, 8, false);
      const m = new THREE.Mesh(geo, T.std({ color, roughness: 0.55, metalness: 0.1 }));
      m.castShadow = true; m.receiveShadow = true; g.add(m); g.userData.routes.push({ id, kind: color === 0x6e757c ? 'senal' : 'cc', curve });
    };
    // pts: [x, z, alturaExtra] en metros de la azotea
    const [ax, , az] = layout.moduleA, [bx, , bz] = layout.moduleB, [lx, , lz] = layout.load;
    const [wx, , wz] = layout.weather, [cx, , cz] = layout.cabinet;
    const lw = lx - 0.5 + 0.01;                  // cara oeste de la carga (W = 1.0 m)
    const red = 0xc21b1b, blk = 0x15171a, grey = 0x6e757c;
    const south = Math.max(az, bz) + 2.0;        // pasillo al frente de B (fuera de su columna y de su base)
    // modulo A -> carga (rojo y negro en paralelo)
    mk([[ax + 0.3, az + 0.1, 0.5], [ax + 0.3, az + 0.45], [ax + 1.4, az + 1.2], [bx - 2.0, south - 0.15], [bx, south], [lx - 1.1, south - 0.2], [lw - 0.35, lz + 0.45], [lw, lz + 0.12, 0.45]], red, 0.028, 0.045, 'A-carga(+)');
    mk([[ax + 0.38, az + 0.1, 0.5], [ax + 0.38, az + 0.5], [ax + 1.48, az + 1.26], [bx - 2.0, south - 0.05], [bx + 0.05, south + 0.1], [lx - 1.05, south - 0.1], [lw - 0.3, lz + 0.52], [lw, lz + 0.2, 0.45]], blk, 0.028, 0.045, 'A-carga(-)');
    // modulo B -> carga, con tramo de holgura (serpenteo suave)
    mk([[bx + 0.3, bz + 0.1, 0.5], [bx + 0.35, bz + 0.55], [bx + 1.0, bz + 1.0], [bx + 1.7, bz + 0.45], [bx + 2.2, bz - 0.05], [lw - 0.25, lz - 0.2], [lw, lz - 0.22, 0.45]], red, 0.028, 0.045, 'B-carga(+)');
    mk([[bx + 0.38, bz + 0.1, 0.5], [bx + 0.43, bz + 0.62], [bx + 1.08, bz + 1.08], [bx + 1.78, bz + 0.52], [bx + 2.28, bz + 0.02], [lw - 0.2, lz - 0.12], [lw, lz - 0.14, 0.45]], blk, 0.028, 0.045, 'B-carga(-)');
    // conduits grises hacia el gabinete (senales)
    mk([[wx + 0.1, wz + 0.45, 0.3], [wx + 1.2, wz - 0.9], [wx + 3.0, cz - 1.9], [bx, cz - 1.9], [cx - 1.7, cz - 1.5], [cx - 0.47, cz - 0.1, 0.3]], grey, 0.024, 0.045, 'estacion-gabinete');
    mk([[lx + 0.1, lz - 0.34, 0.2], [lx + 0.1, lz - 1.3], [cx + 0.12, cz + 0.55], [cx + 0.12, cz + 0.3, 0.2]], grey, 0.024, 0.045, 'carga-gabinete');
    mk([[bx + 0.3, bz - 0.3, 0.2], [bx + 1.1, bz - 1.0], [cx - 1.4, cz + 0.3], [cx - 0.47, cz + 0.2, 0.2]], grey, 0.024, 0.045, 'B-gabinete');
    return g;
  }

  LAB.scene.createLoadCabinet = createLoadCabinet;
  LAB.scene.createControlCabinet = createControlCabinet;
  LAB.scene.createIpCamera = createIpCamera;
  LAB.scene.createCables = createCables;
})();
