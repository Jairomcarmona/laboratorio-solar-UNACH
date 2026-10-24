/* Estacion meteorologica: anemometro de cazoletas, veleta, piranometro de referencia, abrigo de temperatura y humedad,
 * pluviometro. Gira y se orienta con el viento simulado. */
(function () {
  'use strict';
  const { D2R } = LAB.util;
  const T = LAB.scene.tex;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  function createWeatherStation(pos) {
    const g = new THREE.Group(); g.position.set(...pos);
    const steel = T.std({ color: 0xb4bcc4, roughness: 0.38, metalness: 0.9, envMapIntensity: 1.2 });
    const white = T.std({ color: 0xf2f4f5, roughness: 0.35 });
    const dark = T.std({ color: 0x1c2025, roughness: 0.5, metalness: 0.2 });
    const orange = T.std({ color: 0xf08a24, roughness: 0.5 });
    const conc = T.std({ color: 0x9a9b97, roughness: 0.95 });
    const parts = {};

    // base y mastil
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.18, 24), conc);
    base.position.y = 0.09; base.castShadow = base.receiveShadow = true; g.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 3.5, 14), steel);
    mast.position.y = 1.9; mast.castShadow = true; g.add(mast);
    for (let i = 0; i < 3; i++) {                                  // vientos de sujecion
      const a = (i / 3) * Math.PI * 2 + 0.5;
      T.strut(g, V3(0, 3.0, 0), V3(Math.cos(a) * 1.4, 0.1, Math.sin(a) * 1.4), 0.007, dark);
    }

    // anemometro + veleta (arriba)
    const top = new THREE.Group(); top.position.y = 3.68; g.add(top);
    const cupArm = new THREE.Group(); top.add(cupArm);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 12), dark); cupArm.add(hub);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const arm = T.strut(cupArm, V3(0, 0, 0), V3(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17), 0.006, dark);
      const cup = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 10, 0, Math.PI), orange);
      cup.position.set(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17);
      cup.rotation.y = -a + Math.PI / 2; cup.scale.set(1, 1, 0.9);
      cup.castShadow = true; cupArm.add(cup);
    }
    cupArm.position.y = 0.0;
    const vane = new THREE.Group(); vane.position.y = 3.32; g.add(vane);
    const vaneBar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.5), steel); vaneBar.position.z = -0.0; vane.add(vaneBar);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.16), orange); tail.position.set(0, 0.0, 0.26); tail.castShadow = true; vane.add(tail);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 10), dark); tip.rotation.x = -Math.PI / 2; tip.position.z = -0.3; vane.add(tip);
    parts.cups = cupArm; parts.vane = vane;

    // piranometro de referencia (cupula de vidrio sobre cuerpo blanco) en un brazo
    const pyr = new THREE.Group(); pyr.position.set(0.36, 2.72, 0);
    T.strut(g, V3(0, 2.72, 0), V3(0.36, 2.72, 0), 0.012, steel);
    const pBody = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.06, 24), white); pBody.castShadow = true; pyr.add(pBody);
    const pDome = new THREE.Mesh(new THREE.SphereGeometry(0.052, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      T.std({ color: 0xcfe6f5, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, envMapIntensity: 1.8 }, true));
    pDome.position.y = 0.03; pyr.add(pDome);
    const pDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.004, 16), dark); pDisc.position.y = 0.034; pyr.add(pDisc);
    const pRing = new THREE.Mesh(new THREE.TorusGeometry(0.083, 0.006, 8, 24), white); pRing.rotation.x = Math.PI / 2; pRing.position.y = 0.032; pyr.add(pRing);
    g.add(pyr);

    // abrigo de radiacion (placas apiladas) para T y HR
    const shield = new THREE.Group(); shield.position.set(-0.28, 2.05, 0);
    T.strut(g, V3(0, 2.05, 0), V3(-0.28, 2.05, 0), 0.012, steel);
    for (let i = 0; i < 7; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1 - i * 0.003, 0.125 - i * 0.003, 0.014, 22), white);
      p.position.y = i * 0.026; p.castShadow = true; shield.add(p);
    }
    g.add(shield);

    // pluviometro de balancin
    const rain = new THREE.Group(); rain.position.set(0.8, 0, 0.4);
    const rBase = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.34, 22), white); rBase.position.y = 0.17 + 0.5; rBase.castShadow = true; rain.add(rBase);
    const rTop = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.12, 22), steel); rTop.position.y = 0.7 + 0.12; rain.add(rTop);
    T.strut(rain, V3(0, 0, 0), V3(0, 0.5, 0), 0.04, steel);
    g.add(rain);

    // pequena caja de conexiones al pie del mastil
    T.box(g, 0.26, 0.3, 0.12, dark, 0.0, 0.55, 0.1);

    const api = {
      group: g, parts,
      anchors: { mast: V3(0, 3.7, 0), pyr: V3(0.36, 2.8, 0), shield: V3(-0.28, 2.2, 0), rain: V3(0.8, 0.95, 0.4), anemo: V3(0, 3.95, 0) },
      objects: { pyr, shield, rain },
      update(tel, dt) {
        const w = tel.env.wind;
        cupArm.rotation.y -= dt * (w * 2.6);                    // rad/s proporcional al viento
        // la veleta apunta hacia donde sopla el viento (origen en windDir)
        const d = (tel.env.windDir) * D2R;
        const target = Math.atan2(Math.sin(d), -Math.cos(d));
        vane.rotation.y = target - Math.PI;
      },
    };
    return api;
  }

  LAB.scene.createWeatherStation = createWeatherStation;
})();
