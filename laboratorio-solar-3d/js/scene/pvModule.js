/* Modulo fotovoltaico 3D (~500 Wp) con marco, celdas, caja de conexiones y sensores de irradiancia y temperatura.
 * El modulo se construye horizontal (cara activa hacia +Y, lado largo en X). Quien lo use lo inclina:
 *   rotation.order = 'YXZ'; rotation.y = -azimut; rotation.x = -inclinacion  (el borde bajo queda del lado -Z, hacia donde mira)
 */
(function () {
  'use strict';
  const T = LAB.scene.tex;
  const M = LAB.config.module;

  let shared = null;
  function materials() {
    if (shared) return shared;
    const cells = T.pvCells(M.cols, M.rows);
    shared = {
      glass: T.std({
        color: 0xffffff, map: cells, roughness: 0.16, metalness: 0.25, clearcoat: 1.0, clearcoatRoughness: 0.04,
        envMapIntensity: 1.35,
      }, true),
      frame: T.std({ color: 0xc9ced4, roughness: 0.34, metalness: 0.92, envMapIntensity: 1.2 }),
      back: T.std({ color: 0xe8eaec, roughness: 0.6, metalness: 0.0 }),
      black: T.std({ color: 0x101214, roughness: 0.5, metalness: 0.2 }),
      white: T.std({ color: 0xf1f3f4, roughness: 0.4 }),
      steel: T.std({ color: 0x8b949e, roughness: 0.4, metalness: 0.85, envMapIntensity: 1.1 }),
      sensorTop: T.std({ color: 0x0d0f12, roughness: 0.12, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.05 }, true),
      highlight: T.std({ color: 0x2fb4ff, emissive: 0x2fb4ff, emissiveIntensity: 1.4, transparent: true, opacity: 0.0, roughness: 1, depthWrite: false }),
    };
    return shared;
  }

  function createModule(label) {
    const m = materials();
    const root = new THREE.Group();
    root.name = 'module' + label;
    const L = M.long, S = M.short, th = M.thick;

    // vidrio + celdas (cara superior), laterales del marco
    const mats = [m.frame, m.frame, m.glass, m.back, m.frame, m.frame];
    const panel = new THREE.Mesh(new THREE.BoxGeometry(L, th, S), mats);
    panel.castShadow = true; panel.receiveShadow = true;
    root.add(panel);

    // marco de aluminio (cuatro perfiles con un pequeno resalte)
    const fh = th + 0.004, ft = 0.03;
    T.box(root, L, fh, ft, m.frame, 0, 0.002, S / 2 - ft / 2);
    T.box(root, L, fh, ft, m.frame, 0, 0.002, -S / 2 + ft / 2);
    T.box(root, ft, fh, S, m.frame, L / 2 - ft / 2, 0.002, 0);
    T.box(root, ft, fh, S, m.frame, -L / 2 + ft / 2, 0.002, 0);
    // caja de conexiones y cables (cara posterior)
    T.box(root, 0.16, 0.035, 0.1, m.black, 0.55, -th / 2 - 0.018, 0.34);
    // capa de resaltado para seleccion (ligeramente por encima)
    const hl = new THREE.Mesh(new THREE.PlaneGeometry(L, S), m.highlight.clone());
    hl.rotation.x = -Math.PI / 2; hl.position.y = th / 2 + 0.004; hl.renderOrder = 5;
    root.add(hl);

    // sensor de irradiancia en el plano del modulo (borde superior, paralelo a la cara)
    const irr = new THREE.Group();
    irr.position.set(0, th / 2 + 0.035, S / 2 - 0.05);
    const post = T.strut(irr, new THREE.Vector3(0, -0.035, 0), new THREE.Vector3(0, 0, 0), 0.012, m.steel);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.03, 20), m.white);
    body.position.y = 0.014; body.castShadow = true; irr.add(body);
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.006, 20), m.sensorTop);
    dome.position.y = 0.032; irr.add(dome);
    root.add(irr);

    // sensor de temperatura del modulo (cara posterior)
    const temp = new THREE.Group();
    temp.position.set(-0.3, -th / 2 - 0.01, 0.0);
    T.box(temp, 0.06, 0.016, 0.04, m.white);
    root.add(temp);

    return { root, panel, hl, irradianceSensor: irr, tempSensor: temp, size: { L, S, th } };
  }

  LAB.scene.createModule = createModule;
})();
